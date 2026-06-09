// HTTP entry point. `stele serve` runs this — a localhost-only Node http
// server fronting the same store(s) the MCP server and CLI talk to.
//
// Two modes:
//   • single-project (default): one Store, routes at `/`, `/api/*`. Used by
//     dev / power users who run `stele serve` foreground from a project.
//   • multi-tenant (`--multi`):  reads ~/.stele/registry.json, lazy-opens
//     a Store per registered project, routes at `/<slug>/api/*` plus an
//     overview at `/`. Used by the always-on daemon (com.stele.daemon).
//
// Static assets (web/index.html, web/styles.css, web/app.js) are read once
// at startup into memory — no filesystem IO per request.
//
// Business logic lives in projections.ts / store.ts / consolidate.ts. The
// handlers here are thin wrappers.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { Store } from "./store.ts";
import { proposeEdges } from "./consolidate.ts";
import {
  milestoneDetail,
  milestoneSummary,
  projectRollup,
  resumeDigest,
  trace,
  traceEntity,
} from "./projections.ts";
import {
  recordSessionEnd,
  recordSessionStart,
} from "./capture.ts";
import { stubResolver } from "./resolver.ts";
import {
  CaptureSourceSessionSchema,
  CaptureTagRequestSchema,
  CapturePayloadSchema,
  EdgeSchema,
  PauseReasonSchema,
  ProjectStatusSchema,
  SessionOutcomeSchema,
  SessionProvenanceSchema,
  TaggingTargetSchema,
} from "./schemas.ts";
import {
  applyCaptureTags,
  confirmProposal,
  ensureTag,
  getTagPolicy,
  getTagRequireReason,
  rejectProposal,
} from "./tags.ts";
import {
  allProjects,
  registryMtimeMs,
  loadRegistry,
  type ProjectEntry,
} from "./registry.ts";
import type {
  CaptureSourceSession,
  Decision,
  Edge,
  EntityRef,
  Feature,
  PauseReason,
  Project,
  ProposalOutcome,
  SessionOutcome,
  SessionProvenance,
  TaggingTargetKind,
} from "./types.ts";

export interface ServeOptions {
  store?: Store;        // single-project mode: pass a pre-resolved Store
  multi?: boolean;      // multi-tenant mode: read registry, lazy-open stores
  port?: number;
  host?: string;
  open?: boolean;
}

interface Asset {
  body: Buffer;
  type: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
};

function loadAssets(): { index: Asset; files: Map<string, Asset> } {
  const here = dirname(fileURLToPath(import.meta.url));
  const webDir = join(here, "..", "web");
  const read = (name: string): Asset => {
    const ext = name.slice(name.lastIndexOf("."));
    return { body: readFileSync(join(webDir, name)), type: MIME[ext] ?? "application/octet-stream" };
  };
  const index = read("index.html");
  const files = new Map<string, Asset>();
  files.set("styles.css", read("styles.css"));
  files.set("app.js", read("app.js"));
  return { index, files };
}

// -----------------------------------------------------------------------------
// Multi-tenant context — lazy Store per registered project, watches registry
// mtime and evicts stale entries when projects are removed.
// -----------------------------------------------------------------------------

class MultiStoreContext {
  private stores = new Map<string, Store>();
  private lastMtime = 0;
  private projectsCache: ProjectEntry[] = [];

  private refresh(): void {
    const m = registryMtimeMs();
    if (m === this.lastMtime) return;
    const r = loadRegistry();
    this.lastMtime = m;
    this.projectsCache = r.projects;
    const valid = new Set(r.projects.map((p) => p.slug));
    for (const slug of this.stores.keys()) {
      if (!valid.has(slug)) this.stores.delete(slug);
    }
  }

  projects(): ProjectEntry[] {
    this.refresh();
    return this.projectsCache.slice();
  }

  getStore(slug: string): { store: Store; entry: ProjectEntry } | null {
    this.refresh();
    const entry = this.projectsCache.find((p) => p.slug === slug);
    if (!entry) return null;
    const cached = this.stores.get(slug);
    if (cached) return { store: cached, entry };
    const dbPath = join(entry.path, ".stele", "decisions.db");
    if (!existsSync(dbPath)) return null;
    try {
      const store = new Store(dbPath);
      this.stores.set(slug, store);
      return { store, entry };
    } catch {
      return null;
    }
  }
}

// -----------------------------------------------------------------------------
// Response helpers
// -----------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function notFound(res: ServerResponse, msg = "not found"): void {
  json(res, 404, { error: msg });
}

function asset(res: ServerResponse, a: Asset): void {
  res.writeHead(200, { "content-type": a.type });
  res.end(a.body);
}

async function readJsonBody(req: IncomingMessage, max = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > max) {
        reject(new Error(`request body too large (>${max} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text.length === 0 ? null : JSON.parse(text));
      } catch (e) {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function badRequest(res: ServerResponse, message: string, details?: unknown): void {
  json(res, 400, { error: message, ...(details ? { details } : {}) });
}

function validate<T>(schema: z.ZodType<T>, body: unknown, res: ServerResponse): T | null {
  const r = schema.safeParse(body);
  if (!r.success) {
    badRequest(res, "validation failed", r.error.issues);
    return null;
  }
  return r.data;
}

// -----------------------------------------------------------------------------
// Route handlers — operate on a Store, shared by both single and multi modes
// -----------------------------------------------------------------------------

function handleNextId(
  store: Store,
  prefix: string,
  milestoneId: string | null,
  res: ServerResponse,
): void {
  if (prefix !== "D" && prefix !== "DEF" && prefix !== "OQ") {
    badRequest(res, `unknown prefix '${prefix}' — expected one of D, DEF, OQ`);
    return;
  }
  if (!milestoneId) {
    badRequest(res, "0.1.0 ids are <milestone>/<local> — pass milestone=<M-NN> too");
    return;
  }
  const type = prefix === "D" ? "decision" : prefix === "DEF" ? "deferred" : "open";
  json(res, 200, store.nextLocalDecisionId(milestoneId, type));
}

async function handleDecision(store: Store, id: string, res: ServerResponse): Promise<void> {
  const t = await trace(store, id, stubResolver);
  if (!t) return notFound(res);
  json(res, 200, t);
}

async function handleEntity(
  store: Store,
  kind: string,
  id: string,
  res: ServerResponse,
): Promise<void> {
  const ref: EntityRef = { kind, id };
  const traces = await traceEntity(store, ref, stubResolver);
  json(res, 200, { ref, traces });
}

async function handlePostDecision(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch (e) {
    return badRequest(res, (e as Error).message);
  }
  const payload = validate(CapturePayloadSchema, raw, res);
  if (!payload) return;
  // Zod 4's discriminatedUnion inference makes `revisitWhen` look optional
  // even though the schema requires it, so the inferred type doesn't satisfy
  // the canonical Decision shape from types.ts. The Zod safeParse already
  // enforced the constraint at runtime; the cast just bridges the static gap.
  const decision = payload.decision as unknown as Decision;
  const proposed = proposeEdges(store, decision);
  store.putDecision(decision);
  for (const e of payload.edges ?? []) store.addEdge(e as Edge);
  json(res, 200, {
    id: payload.decision.id,
    applied: payload.edges?.length ?? 0,
    proposed: proposed.map((c) => ({ ...c, edge: c.edge })),
  });
}

async function handlePostEdge(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch (e) {
    return badRequest(res, (e as Error).message);
  }
  const edge = validate(EdgeSchema, raw, res);
  if (!edge) return;
  if (!store.getDecision(edge.from) || !store.getDecision(edge.to)) {
    return badRequest(res, "edge endpoints must both exist");
  }
  store.addEdge(edge as Edge);
  json(res, 200, { ok: true, edge });
}

// -----------------------------------------------------------------------------
// 0.1.0 — feature / session / project endpoint bodies
// -----------------------------------------------------------------------------

const SessionStartBodySchema = z.object({
  milestoneId: z.string(),
  sourceSession: CaptureSourceSessionSchema,
  provenance: SessionProvenanceSchema.optional(),
});
const SessionEndBodySchema = z.object({
  outcome: SessionOutcomeSchema,
  pauseReason: PauseReasonSchema.optional(),
});
const FeatureBodySchema = z.object({
  name: z.string().min(1),
  links: z
    .array(z.object({
      to: z.string(),
      relation: z.enum(["depends-on", "depended-on-by"]),
    }))
    .optional(),
});
const ProjectStatusBodySchema = z.object({ status: ProjectStatusSchema });

async function handlePostSessionStart(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let raw: unknown;
  try { raw = await readJsonBody(req); } catch (e) { return badRequest(res, (e as Error).message); }
  const body = validate(SessionStartBodySchema, raw, res);
  if (!body) return;
  try {
    const s = recordSessionStart(
      store, body.milestoneId,
      body.sourceSession as CaptureSourceSession,
      body.provenance as SessionProvenance | undefined,
    );
    json(res, 200, s);
  } catch (e) {
    badRequest(res, (e as Error).message);
  }
}

async function handlePostSessionEnd(
  store: Store,
  sessionId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let raw: unknown;
  try { raw = await readJsonBody(req); } catch (e) { return badRequest(res, (e as Error).message); }
  const body = validate(SessionEndBodySchema, raw, res);
  if (!body) return;
  try {
    const s = recordSessionEnd(
      store, sessionId,
      body.outcome as SessionOutcome,
      body.pauseReason as PauseReason | undefined,
    );
    json(res, 200, s);
  } catch (e) {
    badRequest(res, (e as Error).message);
  }
}

async function handlePostFeature(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const project = store.theProject();
  if (!project) return badRequest(res, "no project — run `stele init`");
  let raw: unknown;
  try { raw = await readJsonBody(req); } catch (e) { return badRequest(res, (e as Error).message); }
  const body = validate(FeatureBodySchema, raw, res);
  if (!body) return;
  const id = store.nextFeatureId();
  const f: Feature = { id, projectId: project.id, name: body.name, links: body.links };
  store.putFeature(f);
  json(res, 200, f);
}

async function handlePostProjectStatus(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const project = store.theProject();
  if (!project) return badRequest(res, "no project — run `stele init`");
  let raw: unknown;
  try { raw = await readJsonBody(req); } catch (e) { return badRequest(res, (e as Error).message); }
  const body = validate(ProjectStatusBodySchema, raw, res);
  if (!body) return;
  const updated: Project = { ...project, status: body.status };
  store.putProject(updated);
  json(res, 200, { ok: true, project: updated });
}

// -----------------------------------------------------------------------------
// 0.0.7 — tag + config route handlers (extracted out of dispatchApi for
// readability — keep dispatchApi's switch flat).
// -----------------------------------------------------------------------------

const TagProposeBodySchema = z.object({
  name: z.string().min(1),
  reason: z.string().optional(),
  suggestedColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  targets: z.array(TaggingTargetSchema).min(1),
});

const ConfirmBodySchema = z.object({
  rename: z.string().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

const ApplyBodySchema = z.object({ target: TaggingTargetSchema });
const RecolorBodySchema = z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/) });
const RenameBodySchema = z.object({ name: z.string().min(1) });
const ConfigSetBodySchema = z.object({ value: z.string() });

async function handlePostTagPropose(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let raw: unknown;
  try { raw = await readJsonBody(req); }
  catch (e) { return badRequest(res, (e as Error).message); }
  const body = validate(TagProposeBodySchema, raw, res);
  if (!body) return;
  try {
    const r = ensureTag(store, body.name, {
      reason: body.reason,
      suggestedColor: body.suggestedColor,
      targets: body.targets as { kind: TaggingTargetKind; id: string }[],
    });
    json(res, 200, r);
  } catch (e) {
    badRequest(res, (e as Error).message);
  }
}

async function handlePostProposalConfirm(
  store: Store,
  proposalId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let raw: unknown = {};
  try {
    const ct = req.headers["content-length"];
    if (ct && ct !== "0") raw = await readJsonBody(req);
  } catch (e) { return badRequest(res, (e as Error).message); }
  const body = validate(ConfirmBodySchema, raw, res);
  if (!body) return;
  try {
    const r = confirmProposal(store, proposalId, body);
    json(res, 200, r);
  } catch (e) {
    badRequest(res, (e as Error).message);
  }
}

async function handlePostTagApply(
  store: Store,
  tagId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let raw: unknown;
  try { raw = await readJsonBody(req); }
  catch (e) { return badRequest(res, (e as Error).message); }
  const body = validate(ApplyBodySchema, raw, res);
  if (!body) return;
  const tag = store.getTag(tagId);
  if (!tag) return notFound(res, `no such tag: ${tagId}`);
  if (tag.status !== "active") return badRequest(res, `tag ${tagId} is archived`);
  store.upsertTagging({ tagId, targetKind: body.target.kind, targetId: body.target.id });
  json(res, 200, { ok: true });
}

async function handleDeleteTagging(
  store: Store,
  tagId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let raw: unknown;
  try { raw = await readJsonBody(req); }
  catch (e) { return badRequest(res, (e as Error).message); }
  const body = validate(ApplyBodySchema, raw, res);
  if (!body) return;
  const ok = store.removeTagging(tagId, body.target.kind, body.target.id);
  json(res, 200, { ok });
}

async function handlePostTagRecolor(
  store: Store,
  tagId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let raw: unknown;
  try { raw = await readJsonBody(req); }
  catch (e) { return badRequest(res, (e as Error).message); }
  const body = validate(RecolorBodySchema, raw, res);
  if (!body) return;
  if (!store.getTag(tagId)) return notFound(res, `no such tag: ${tagId}`);
  store.recolorTag(tagId, body.color);
  json(res, 200, { ok: true });
}

async function handlePostTagRename(
  store: Store,
  tagId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let raw: unknown;
  try { raw = await readJsonBody(req); }
  catch (e) { return badRequest(res, (e as Error).message); }
  const body = validate(RenameBodySchema, raw, res);
  if (!body) return;
  if (!store.getTag(tagId)) return notFound(res, `no such tag: ${tagId}`);
  const collision = store.findTagByName(body.name);
  if (collision && collision.id !== tagId) {
    return badRequest(res, `name "${body.name}" already taken by ${collision.id}`);
  }
  store.renameTag(tagId, body.name);
  json(res, 200, { ok: true });
}

async function handlePostConfigSet(
  store: Store,
  key: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let raw: unknown;
  try { raw = await readJsonBody(req); }
  catch (e) { return badRequest(res, (e as Error).message); }
  const body = validate(ConfigSetBodySchema, raw, res);
  if (!body) return;
  if (key === "tag_policy" && !["auto", "propose", "locked"].includes(body.value)) {
    return badRequest(res, `tag_policy must be auto / propose / locked`);
  }
  if (key === "tag_require_reason" && !["true", "false"].includes(body.value)) {
    return badRequest(res, `tag_require_reason must be 'true' or 'false'`);
  }
  store.setConfig(key, body.value);
  json(res, 200, { ok: true, key, value: body.value });
}

// Per-store API dispatch — handles /api/* relative to a single Store
async function dispatchApi(
  store: Store,
  apiPath: string,                 // e.g. "/api/resume", "/api/decisions/D-04"
  searchParams: URLSearchParams,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (method === "GET") {
    if (apiPath === "/api/resume") return json(res, 200, resumeDigest(store));
    if (apiPath === "/api/decisions") return json(res, 200, store.allDecisions());
    if (apiPath === "/api/next-id") {
      return handleNextId(
        store,
        searchParams.get("prefix") ?? "D",
        searchParams.get("milestone"),
        res,
      );
    }
    // 0.0.6 — milestones
    if (apiPath === "/api/milestones") return json(res, 200, milestoneSummary(store));
    const mMilestone = apiPath.match(/^\/api\/milestones\/([^/]+)$/);
    if (mMilestone) {
      const detail = milestoneDetail(store, decodeURIComponent(mMilestone[1]));
      return detail ? json(res, 200, detail) : notFound(res);
    }
    // 0.1.0 — decision id is `<milestoneId>/<local>` which contains a slash.
    // The decisions route therefore takes the WHOLE remainder of the path
    // after `/api/decisions/`, not just the next segment.
    if (apiPath.startsWith("/api/decisions/")) {
      const id = decodeURIComponent(apiPath.slice("/api/decisions/".length));
      if (id && !id.includes("?")) return await handleDecision(store, id, res);
    }
    const mEntity = apiPath.match(/^\/api\/entity\/([^/]+)\/([^/]+)$/);
    if (mEntity) return await handleEntity(store, decodeURIComponent(mEntity[1]), decodeURIComponent(mEntity[2]), res);
    // 0.1.0 — projects + features + sessions
    if (apiPath === "/api/project") {
      const p = store.theProject();
      if (!p) return notFound(res);
      return json(res, 200, { project: p, rollup: projectRollup(store, p.id) });
    }
    if (apiPath === "/api/features") {
      const p = store.theProject();
      if (!p) return json(res, 200, []);
      return json(res, 200, store.featuresIn(p.id));
    }
    const mFeature = apiPath.match(/^\/api\/features\/([^/]+)$/);
    if (mFeature) {
      const f = store.getFeature(decodeURIComponent(mFeature[1]));
      if (!f) return notFound(res);
      const milestones = store.milestonesInFeature(f.id);
      return json(res, 200, { feature: f, milestones });
    }
    if (apiPath === "/api/sessions") {
      // Latest session (resume strip)
      const latest = store.latestSession();
      return json(res, 200, latest);
    }
    const mSession = apiPath.match(/^\/api\/sessions\/([^/]+)$/);
    if (mSession) {
      const s = store.getSession(decodeURIComponent(mSession[1]));
      return s ? json(res, 200, s) : notFound(res);
    }
    const mSessionResume = apiPath.match(/^\/api\/sessions\/([^/]+)\/resume-command$/);
    if (mSessionResume) {
      const s = store.getSession(decodeURIComponent(mSessionResume[1]));
      if (!s) return notFound(res);
      const layoutAlive = s.provenance?.layoutAlive ?? false;
      const cwd = s.provenance?.cwd ?? "";
      const ccSid = s.sourceSessionId ?? "";
      return json(res, 200, {
        mode: layoutAlive ? "jump" : "rebuild",
        command: `cd ${cwd} && claude --resume ${ccSid}`,
        copyable: true,
        lastSession: { id: s.id, endedAt: s.endedAt, outcome: s.outcome, pauseReason: s.pauseReason },
      });
    }
    const mMilestoneReport = apiPath.match(/^\/api\/milestones\/([^/]+)\/report$/);
    if (mMilestoneReport) {
      const id = decodeURIComponent(mMilestoneReport[1]);
      const m = store.getMilestone(id);
      if (!m) return notFound(res);
      const openLoops = store.decisionsInMilestone(id).filter((d) => {
        // Use nodeState via projection-level helper if available; for now inline.
        if (d.type === "decision") return false;
        return d.status !== "resolved" && !store.isResolved(d.id);
      }).map((d) => ({ id: d.id, title: d.title, type: d.type }));
      return json(res, 200, { milestoneId: id, summary: "", openLoops });
    }
    // 0.0.7 — tags
    if (apiPath === "/api/tags") {
      const status = searchParams.get("status") ?? "active";
      if (status === "all") return json(res, 200, store.allTags());
      if (status === "archived") return json(res, 200, store.allTags("archived"));
      return json(res, 200, store.allTags("active"));
    }
    if (apiPath === "/api/tags/proposals") {
      const outcome = searchParams.get("outcome");
      if (!outcome || outcome === "all") return json(res, 200, store.allTagProposals());
      if (outcome !== "pending" && outcome !== "blocked" && outcome !== "auto_adopted") {
        return badRequest(res, `outcome must be pending / blocked / auto_adopted / all`);
      }
      return json(res, 200, store.allTagProposals(outcome as ProposalOutcome));
    }
    const mTaggings = apiPath.match(/^\/api\/(decisions|milestones)\/([^/]+)\/tags$/);
    if (mTaggings) {
      const kind = mTaggings[1] === "decisions" ? "decision" : "milestone";
      return json(res, 200, store.taggingsForTarget(kind, decodeURIComponent(mTaggings[2])));
    }
    // 0.0.7 — config
    if (apiPath === "/api/config") {
      const all = store.allConfig();
      // surface defaults too so the consumer doesn't have to know the engine.
      return json(res, 200, {
        ...all,
        _defaults: {
          tag_policy: getTagPolicy(store),
          tag_require_reason: getTagRequireReason(store),
        },
      });
    }
    const mConfigGet = apiPath.match(/^\/api\/config\/([^/]+)$/);
    if (mConfigGet) {
      const key = decodeURIComponent(mConfigGet[1]);
      const v = store.getConfig(key);
      if (v === null) {
        if (key === "tag_policy") return json(res, 200, { key, value: getTagPolicy(store), default: true });
        if (key === "tag_require_reason") return json(res, 200, { key, value: getTagRequireReason(store), default: true });
        return notFound(res);
      }
      return json(res, 200, { key, value: v });
    }
    return notFound(res);
  }
  if (method === "POST") {
    if (apiPath === "/api/decisions") return await handlePostDecision(store, req, res);
    if (apiPath === "/api/edges") return await handlePostEdge(store, req, res);
    // 0.1.0 — sessions lifecycle endpoints
    if (apiPath === "/api/sessions/start") return await handlePostSessionStart(store, req, res);
    const mSessionEnd = apiPath.match(/^\/api\/sessions\/([^/]+)\/end$/);
    if (mSessionEnd) return await handlePostSessionEnd(store, decodeURIComponent(mSessionEnd[1]), req, res);
    // 0.1.0 — features open
    if (apiPath === "/api/features") return await handlePostFeature(store, req, res);
    // 0.1.0 — project status
    const mProjectStatus = apiPath.match(/^\/api\/project\/status$/);
    if (mProjectStatus) return await handlePostProjectStatus(store, req, res);
    // 0.0.7 — tags
    if (apiPath === "/api/tags") return await handlePostTagPropose(store, req, res);
    const mConfirm = apiPath.match(/^\/api\/tags\/proposals\/([^/]+)\/confirm$/);
    if (mConfirm) return await handlePostProposalConfirm(store, decodeURIComponent(mConfirm[1]), req, res);
    const mReject = apiPath.match(/^\/api\/tags\/proposals\/([^/]+)\/reject$/);
    if (mReject) {
      const ok = rejectProposal(store, decodeURIComponent(mReject[1]));
      return ok ? json(res, 200, { ok }) : notFound(res);
    }
    const mApply = apiPath.match(/^\/api\/tags\/([^/]+)\/apply$/);
    if (mApply) return await handlePostTagApply(store, decodeURIComponent(mApply[1]), req, res);
    const mRecolor = apiPath.match(/^\/api\/tags\/([^/]+)\/recolor$/);
    if (mRecolor) return await handlePostTagRecolor(store, decodeURIComponent(mRecolor[1]), req, res);
    const mRename = apiPath.match(/^\/api\/tags\/([^/]+)\/rename$/);
    if (mRename) return await handlePostTagRename(store, decodeURIComponent(mRename[1]), req, res);
    const mArchive = apiPath.match(/^\/api\/tags\/([^/]+)\/archive$/);
    if (mArchive) {
      const tagId = decodeURIComponent(mArchive[1]);
      if (!store.getTag(tagId)) return notFound(res);
      store.archiveTag(tagId);
      return json(res, 200, { ok: true });
    }
    const mRestore = apiPath.match(/^\/api\/tags\/([^/]+)\/restore$/);
    if (mRestore) {
      const tagId = decodeURIComponent(mRestore[1]);
      if (!store.getTag(tagId)) return notFound(res);
      store.restoreTag(tagId);
      return json(res, 200, { ok: true });
    }
    // 0.0.7 — config
    const mConfigSet = apiPath.match(/^\/api\/config\/([^/]+)$/);
    if (mConfigSet) return await handlePostConfigSet(store, decodeURIComponent(mConfigSet[1]), req, res);
    return notFound(res);
  }
  if (method === "DELETE") {
    const mDelTagging = apiPath.match(/^\/api\/tags\/([^/]+)\/tagging$/);
    if (mDelTagging) return await handleDeleteTagging(store, decodeURIComponent(mDelTagging[1]), req, res);
    return notFound(res);
  }
  res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET, POST, DELETE" });
  res.end(JSON.stringify({ error: "method not allowed" }));
}

// -----------------------------------------------------------------------------
// Single-project dispatcher (backward compat for `stele serve` without --multi)
// -----------------------------------------------------------------------------

async function dispatchSingle(
  store: Store,
  assets: ReturnType<typeof loadAssets>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";
  try {
    if (method === "GET") {
      if (path === "/" || path === "/index.html") return asset(res, assets.index);
      if (path.startsWith("/assets/")) {
        const file = assets.files.get(path.slice("/assets/".length));
        return file ? asset(res, file) : notFound(res);
      }
      if (!path.startsWith("/api/")) return asset(res, assets.index);
    }
    return await dispatchApi(store, path, url.searchParams, method, req, res);
  } catch (e) {
    console.error(`[stele] handler error: ${(e as Error).message}`);
    json(res, 500, { error: "internal error" });
  }
}

// -----------------------------------------------------------------------------
// Multi-tenant dispatcher — routes /<slug>/api/* via the registry
// -----------------------------------------------------------------------------

async function handleProjects(ctx: MultiStoreContext, res: ServerResponse): Promise<void> {
  const list = ctx.projects();
  const summaries = list.map((p) => {
    const got = ctx.getStore(p.slug);
    if (!got) return { slug: p.slug, path: p.path, addedAt: p.addedAt, openLoops: 0, missing: true };
    const items = resumeDigest(got.store);
    return {
      slug: p.slug,
      path: p.path,
      addedAt: p.addedAt,
      openLoops: items.length,
      needsCheck: items.filter((i) => i.needsCheck).length,
    };
  });
  json(res, 200, summaries);
}

async function dispatchMulti(
  ctx: MultiStoreContext,
  assets: ReturnType<typeof loadAssets>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";
  const parts = path.split("/").filter(Boolean);

  try {
    // Static assets shared across projects
    if (method === "GET" && parts.length > 0 && parts[0] === "assets") {
      const file = assets.files.get(parts.slice(1).join("/"));
      return file ? asset(res, file) : notFound(res);
    }

    // Global API
    if (method === "GET" && parts.length === 2 && parts[0] === "api" && parts[1] === "projects") {
      return await handleProjects(ctx, res);
    }

    // Overview at /
    if (method === "GET" && parts.length === 0) {
      return asset(res, assets.index);
    }

    // /<slug>/...
    const slug = parts[0];
    // Reserve some words just in case
    if (slug === "api" || slug === "assets") {
      return notFound(res, `unknown global route '/${slug}/...'`);
    }
    const got = ctx.getStore(slug);
    if (!got) {
      // SPA fallback for GETs to a slug that doesn't exist — the frontend
      // will show "no such project" and offer the overview.
      if (method === "GET" && !path.includes("/api/")) return asset(res, assets.index);
      return notFound(res, `no such project: ${slug}`);
    }

    const rest = "/" + parts.slice(1).join("/");  // "/", "/decisions", "/api/resume", ...

    if (method === "GET" && !rest.startsWith("/api/")) {
      // SPA fallback for any non-API path under the slug
      return asset(res, assets.index);
    }

    return await dispatchApi(got.store, rest, url.searchParams, method, req, res);
  } catch (e) {
    console.error(`[stele] handler error: ${(e as Error).message}`);
    json(res, 500, { error: "internal error" });
  }
}

// -----------------------------------------------------------------------------
// Public entry
// -----------------------------------------------------------------------------

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "explorer"
    : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // best-effort; if the open helper isn't on PATH, user can click the URL
  }
}

export interface RunningServer {
  server: import("node:http").Server;
  url: string;
  port: number;
  host: string;
  close: () => Promise<void>;
}

// Start the HTTP server and resolve once it's listening. Returns a handle
// the caller can use to close (tests do this in afterEach; the CLI keeps
// the process alive separately).
export function startServer(opts: ServeOptions): Promise<RunningServer> {
  const { store, multi = false, port = 3939, host = "127.0.0.1" } = opts;
  const assets = loadAssets();

  if (!multi && !store) {
    throw new Error("startServer: either `store` (single-project) or `multi: true` is required");
  }

  const ctx = multi ? new MultiStoreContext() : null;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (multi) void dispatchMulti(ctx!, assets, req, res);
      else void dispatchSingle(store!, assets, req, res);
    });

    server.on("error", (err) => reject(err));

    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      const url = `http://${host}:${actualPort}`;
      const close = () =>
        new Promise<void>((res, rej) => {
          server.close((err) => (err ? rej(err) : res()));
        });
      resolve({ server, url, port: actualPort, host, close });
    });
  });
}

// Wrapper used by the CLI: starts the server, logs, opens browser if
// requested, installs SIGINT handler, and never resolves (server runs
// until killed). Tests use startServer directly.
export async function startServerForeground(opts: ServeOptions & { open?: boolean }): Promise<void> {
  const { open = false, multi = false } = opts;
  let running: RunningServer;
  try {
    running = await startServer(opts);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE") {
      console.error(
        `[stele] port ${opts.port ?? 3939} is already in use on ${opts.host ?? "127.0.0.1"} — pass --port to pick another`,
      );
      process.exit(1);
    }
    throw err;
  }
  const modeStr = multi ? " (multi-tenant)" : "";
  console.log(`stele serving on ${running.url}${modeStr}`);
  if (multi) {
    // For diagnostic only — reading the registry here is cheap
    const projects = (await import("./registry.ts")).allProjects();
    console.log(`  ${projects.length} project(s) registered`);
  }
  console.log(`(Ctrl-C to stop)`);
  if (open) openBrowser(running.url);

  process.on("SIGINT", () => {
    console.log("");
    console.log("stopping…");
    void running.close().then(() => process.exit(0));
  });

  // Never resolve — server runs until killed.
  await new Promise<void>(() => {});
}
