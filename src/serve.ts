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
// Static assets (web/index.html, web/app.js, web/pages/*, …) are read from
// disk per request. On localhost this IO is negligible, and it means an
// upgraded package's new web/ assets are served immediately rather than a
// stale in-memory copy surviving until the daemon process restarts.
//
// Business logic lives in projections.ts / store.ts / consolidate.ts. The
// handlers here are thin wrappers.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { Store } from "./store.ts";
import { proposeEdges } from "./consolidate.ts";
import {
  featureDecisions,
  featureDetail,
  featureSummary,
  featuresList,
  graphSlice,
  projectListSummary,
  projectRollup,
  resumeDigest,
  trace,
  traceEntity,
  traceStitch,
} from "./projections.ts";
import { stubResolver } from "./resolver.ts";
import { resumeCommand, isResumableSessionId } from "./resume.ts";
import { isLocale, type Locale } from "./i18n.ts";
import {
  CaptureTagRequestSchema,
  CapturePayloadSchema,
  EdgeSchema,
  ProjectStatusSchema,
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
  Decision,
  Edge,
  EntityRef,
  FeatureState,
  Project,
  ProposalOutcome,
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

interface AssetServer {
  index(): Asset;
  landing(): Asset;
  file(rel: string): Asset | null;   // null = not found or outside web/
}

// Resolve web/ once, then read files on demand. `file()` is hardened against
// path traversal: `rel` comes straight off the `/assets/<rel>` URL, so a
// request for `../../etc/passwd` must resolve outside web/ and return null
// rather than leak an arbitrary file.
function loadAssets(): AssetServer {
  const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
  const read = (relPath: string): Asset => {
    const ext = relPath.slice(relPath.lastIndexOf("."));
    return { body: readFileSync(join(webDir, relPath)), type: MIME[ext] ?? "application/octet-stream" };
  };
  const file = (rel: string): Asset | null => {
    const full = join(webDir, rel);
    const within = relative(webDir, full);
    if (within.startsWith("..") || isAbsolute(within)) return null;  // escaped web/
    if (!existsSync(full)) return null;
    try {
      return read(rel);
    } catch {
      return null;  // races with deletion / directory paths
    }
  };
  return {
    index: () => read("index.html"),
    landing: () => read("landing.html"),
    file,
  };
}

// Version this process booted with, re-read live from the installed
// package.json. The daemon polls this to detect an `npm update` and restart
// itself (see startServerForeground). Returns null if the file is missing or
// mid-write so the caller treats it as "no change".
function pkgVersion(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "package.json"), "utf8");
    const v = (JSON.parse(raw) as { version?: string }).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
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
  featureId: string | null,
  res: ServerResponse,
): void {
  if (prefix !== "D" && prefix !== "DEF" && prefix !== "OQ") {
    badRequest(res, `unknown prefix '${prefix}' — expected one of D, DEF, OQ`);
    return;
  }
  if (!featureId) {
    badRequest(res, "0.1.0 ids are <feature>/<local> — pass feature=<M-NN> too");
    return;
  }
  const type = prefix === "D" ? "decision" : prefix === "DEF" ? "deferred" : "open";
  json(res, 200, store.nextLocalDecisionId(featureId, type));
}

async function handleDecision(
  store: Store,
  id: string,
  res: ServerResponse,
  locale: Locale | undefined,
): Promise<void> {
  const tr = await trace(store, id, stubResolver, locale);
  if (!tr) return notFound(res);
  json(res, 200, tr);
}

async function handleEntity(
  store: Store,
  kind: string,
  id: string,
  res: ServerResponse,
  locale: Locale | undefined,
): Promise<void> {
  const ref: EntityRef = { kind, id };
  const traces = await traceEntity(store, ref, stubResolver, locale);
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

const ProjectStatusBodySchema = z.object({ status: ProjectStatusSchema });


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
  // 0.5.0 — strict enum for display_language (CLI + Web UI both branch on it)
  if (key === "display_language" && !["zh", "en"].includes(body.value)) {
    return badRequest(res, `display_language must be 'zh' or 'en'`);
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
  // Per-request locale for server-rendered prose (Trace.statusLine, the
  // deferred decision's trigger field in resumeDigest). The SPA's apiGet()
  // appends `?lang=` automatically; if absent we leave it undefined and
  // projections fall through to the process-level default.
  const langRaw = searchParams.get("lang");
  const locale: Locale | undefined = isLocale(langRaw) ? langRaw : undefined;

  if (method === "GET") {
    if (apiPath === "/api/resume") return json(res, 200, resumeDigest(store, locale));
    if (apiPath === "/api/decisions") return json(res, 200, store.allDecisions());
    if (apiPath === "/api/next-id") {
      return handleNextId(
        store,
        searchParams.get("prefix") ?? "D",
        searchParams.get("feature"),
        res,
      );
    }
    // 0.3.0 — features (collapsed; was /api/milestones in 0.2.x).
    // `state` query param filters by FeatureState. `summary=1` returns the
    // legacy featureSummary projection (flat counts + lastActivity, no tags);
    // default is the richer featuresList with tags.
    if (apiPath === "/api/features") {
      const state = searchParams.get("state") ?? undefined;
      if (searchParams.get("summary") === "1") {
        return json(res, 200, featureSummary(store));
      }
      return json(res, 200, featuresList(store, state ? { state: state as FeatureState } : undefined));
    }
    const mFeatureDecisions = apiPath.match(/^\/api\/features\/([^/]+)\/decisions$/);
    if (mFeatureDecisions) {
      const id = decodeURIComponent(mFeatureDecisions[1]);
      if (!store.getFeature(id)) return notFound(res);
      return json(res, 200, featureDecisions(store, id));
    }
    const mFeature = apiPath.match(/^\/api\/features\/([^/]+)$/);
    if (mFeature) {
      const detail = featureDetail(store, decodeURIComponent(mFeature[1]));
      return detail ? json(res, 200, detail) : notFound(res);
    }
    // 0.1.0 — decision id is `<featureId>/<local>` which contains a slash.
    // The decisions route therefore takes the WHOLE remainder of the path
    // after `/api/decisions/`, not just the next segment.
    //
    // 0.2.0 — `/stitch` suffix returns the cross-session resolves projection
    // for the Trace page.
    if (apiPath.startsWith("/api/decisions/")) {
      const raw = apiPath.slice("/api/decisions/".length);
      if (raw.endsWith("/stitch")) {
        const id = decodeURIComponent(raw.slice(0, -"/stitch".length));
        if (id) {
          const s = traceStitch(store, id);
          return json(res, 200, s);
        }
      }
      const id = decodeURIComponent(raw);
      if (id && !id.includes("?")) return await handleDecision(store, id, res, locale);
    }
    const mEntity = apiPath.match(/^\/api\/entity\/([^/]+)\/([^/]+)$/);
    if (mEntity) return await handleEntity(store, decodeURIComponent(mEntity[1]), decodeURIComponent(mEntity[2]), res, locale);
    // 0.1.0 — projects + features + sessions
    if (apiPath === "/api/project") {
      const p = store.theProject();
      if (!p) return notFound(res);
      return json(res, 200, { project: p, rollup: projectRollup(store, p.id) });
    }
    // 0.2.0 — single-project alias for /api/projects so the SPA's Projects
    // overview works in single-project mode without branching on mode. Returns
    // a synthetic one-element array shaped exactly like the multi-tenant
    // dispatcher's response.
    if (apiPath === "/api/projects") {
      const p = store.theProject();
      if (!p) return json(res, 200, []);
      const synthetic = {
        slug: basename(p.path) || "local",
        path: p.path,
        addedAt: p.createdAt,
      };
      const digest = resumeDigest(store);
      return json(res, 200, projectListSummary([{
        entry: synthetic,
        store,
        needsCheck: digest.filter((i) => i.needsCheck).length,
      }]));
    }
    if (apiPath === "/api/graph") {
      // Decision graph slice — {nodes, edges, features} with optional
      // feature/tag filters in the querystring.
      const filter = {
        feature: searchParams.get("feature") ?? undefined,
        tag: searchParams.get("tag") ?? undefined,
      };
      return json(res, 200, graphSlice(store, filter));
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
      // Fall back to the project's path when the session didn't record its own
      // cwd (scan / session-extract captures have no provenance.cwd) so the
      // resume command is a valid `cd <project> && …` rather than `cd  && …`.
      const cwd = s.provenance?.cwd ?? store.theProject()?.path ?? "";
      const ccSid = s.sourceSessionId ?? "";
      return json(res, 200, {
        mode: layoutAlive ? "jump" : "rebuild",
        // shell-quote cwd + id (untrusted via /stele:scan); a non-cc id isn't
        // a real resumable session, so don't advertise it as runnable.
        command: resumeCommand(cwd, ccSid),
        copyable: isResumableSessionId(ccSid),
        lastSession: { id: s.id, endedAt: s.endedAt, outcome: s.outcome, pauseReason: s.pauseReason },
      });
    }
    const mFeatureReport = apiPath.match(/^\/api\/features\/([^/]+)\/report$/);
    if (mFeatureReport) {
      const id = decodeURIComponent(mFeatureReport[1]);
      const m = store.getFeature(id);
      if (!m) return notFound(res);
      const openLoops = store.decisionsInFeature(id).filter((d) => {
        // Use nodeState via projection-level helper if available; for now inline.
        if (d.type === "decision") return false;
        return d.status !== "resolved" && !store.isResolved(d.id);
      }).map((d) => ({ id: d.id, title: d.title, type: d.type }));
      return json(res, 200, { featureId: id, summary: "", openLoops });
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
    const mTaggings = apiPath.match(/^\/api\/(decisions|features)\/([^/]+)\/tags$/);
    if (mTaggings) {
      const kind = mTaggings[1] === "decisions" ? "decision" : "feature";
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
    // 0.3.0 — sessions/start, sessions/end, and feature-open POST endpoints
    // were removed. Writes happen through MCP (decision_capture / feature_open),
    // not HTTP.
    // 0.3.0 — feature summary write (the /stele:feature step 5 sink)
    const mFeatureSummary = apiPath.match(/^\/api\/features\/([^/]+)\/summary$/);
    if (mFeatureSummary) {
      const id = decodeURIComponent(mFeatureSummary[1]);
      if (!store.getFeature(id)) return notFound(res);
      let raw: unknown;
      try { raw = await readJsonBody(req); } catch (e) { return badRequest(res, (e as Error).message); }
      const body = validate(z.object({ summary: z.string() }), raw, res);
      if (!body) return;
      store.setFeatureSummary(id, body.summary);
      return json(res, 200, { id, summary: body.summary });
    }
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
  let path = url.pathname;
  const method = req.method ?? "GET";
  try {
    if (method === "GET") {
      if (path === "/" || path === "/index.html") return asset(res, assets.index());
      if (path === "/welcome" || path === "/welcome.html") return asset(res, assets.landing());
      if (path.startsWith("/assets/")) {
        const file = assets.file(path.slice("/assets/".length));
        return file ? asset(res, file) : notFound(res);
      }
    }
    // The SPA lays its routes out with multi-tenant slug prefixes
    // (`/<slug>/`, `/<slug>/d/<m>/<id>`, `/<slug>/api/feature-rail`, etc.).
    // In single-project mode there is only one store, so we treat the
    // first path segment as cosmetic: strip it before dispatching to the
    // API, and serve the SPA shell for any non-API path under it.
    if (path !== "/" && !path.startsWith("/api/")) {
      const parts = path.split("/").filter(Boolean);
      const first = parts[0];
      if (first !== "api" && first !== "assets" && first !== "welcome") {
        const rest = "/" + parts.slice(1).join("/");
        if (rest.startsWith("/api/")) {
          path = rest;
        } else if (method === "GET") {
          return asset(res, assets.index());
        }
      }
    }
    if (method === "GET" && !path.startsWith("/api/")) return asset(res, assets.index());
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
  // Resolve store + needsCheck once per project, then hand off to the
  // projection. needsCheck (open/deferred decisions whose revisit trigger
  // fired) is sourced from resumeDigest since projectRollup gives dueLoops
  // but not the count of items the resume digest would highlight.
  const rows = list.map((entry) => {
    const got = ctx.getStore(entry.slug);
    if (!got) return { entry, store: null, needsCheck: 0 };
    const digest = resumeDigest(got.store);
    return {
      entry,
      store: got.store,
      needsCheck: digest.filter((i) => i.needsCheck).length,
    };
  });
  json(res, 200, projectListSummary(rows));
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
      const file = assets.file(parts.slice(1).join("/"));
      return file ? asset(res, file) : notFound(res);
    }

    // Global API
    if (method === "GET" && parts.length === 2 && parts[0] === "api" && parts[1] === "projects") {
      return await handleProjects(ctx, res);
    }

    // Overview at /
    if (method === "GET" && parts.length === 0) {
      return asset(res, assets.index());
    }

    // Marketing landing at /welcome (single static page, no slug)
    if (method === "GET" && parts.length === 1 && (parts[0] === "welcome" || parts[0] === "welcome.html")) {
      return asset(res, assets.landing());
    }

    // /<slug>/...
    const slug = parts[0];
    // Reserve some words just in case
    if (slug === "api" || slug === "assets" || slug === "welcome") {
      return notFound(res, `unknown global route '/${slug}/...'`);
    }
    const got = ctx.getStore(slug);
    if (!got) {
      // SPA fallback for GETs to a slug that doesn't exist — the frontend
      // will show "no such project" and offer the overview.
      if (method === "GET" && !path.includes("/api/")) return asset(res, assets.index());
      return notFound(res, `no such project: ${slug}`);
    }

    const rest = "/" + parts.slice(1).join("/");  // "/", "/decisions", "/api/resume", ...

    if (method === "GET" && !rest.startsWith("/api/")) {
      // SPA fallback for any non-API path under the slug
      return asset(res, assets.index());
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

  // Daemon self-restart on upgrade. `npm update -g stele-mcp` swaps the
  // package files under the running process but can't bounce it, so the
  // long-lived daemon would keep serving old code (and, before per-request
  // asset reads, old UI) until the next login/reboot. Poll the installed
  // version; when it changes, exit cleanly — launchd (KeepAlive) and systemd
  // (Restart=always) respawn us on the new code, which re-reads everything.
  // Only in multi mode (the daemon); a foreground `stele serve` in a project
  // is the user's own process to manage.
  if (multi) {
    const booted = pkgVersion();
    if (booted) {
      const watch = setInterval(() => {
        const now = pkgVersion();
        if (now && now !== booted) {
          console.log(`[stele] package upgraded ${booted} → ${now}; restarting daemon to load new code`);
          const hardExit = setTimeout(() => process.exit(0), 2000);
          hardExit.unref();
          void running.close().then(() => process.exit(0), () => process.exit(0));
        }
      }, 30_000);
      watch.unref();  // the server keeps the loop alive; this timer must not
    }
  }

  process.on("SIGINT", () => {
    console.log("");
    console.log("stopping…");
    void running.close().then(() => process.exit(0));
  });

  // Never resolve — server runs until killed.
  await new Promise<void>(() => {});
}
