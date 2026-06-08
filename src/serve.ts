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
import { resumeDigest, trace, traceEntity } from "./projections.ts";
import { stubResolver } from "./resolver.ts";
import { CapturePayloadSchema, EdgeSchema } from "./schemas.ts";
import {
  allProjects,
  registryMtimeMs,
  loadRegistry,
  type ProjectEntry,
} from "./registry.ts";
import type { CapturePayload, Decision, Edge, EntityRef } from "./types.ts";

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

const NEXT_ID_PREFIXES = new Set(["D", "DEF", "OQ"]);

function handleNextId(store: Store, prefix: string, res: ServerResponse): void {
  if (!NEXT_ID_PREFIXES.has(prefix)) {
    badRequest(res, `unknown prefix '${prefix}' — expected one of D, DEF, OQ`);
    return;
  }
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const d of store.allDecisions()) {
    const m = d.id.match(pattern);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  const next = (max + 1).toString().padStart(2, "0");
  json(res, 200, `${prefix}-${next}`);
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
      return handleNextId(store, searchParams.get("prefix") ?? "D", res);
    }
    const mDecision = apiPath.match(/^\/api\/decisions\/([^/]+)$/);
    if (mDecision) return await handleDecision(store, decodeURIComponent(mDecision[1]), res);
    const mEntity = apiPath.match(/^\/api\/entity\/([^/]+)\/([^/]+)$/);
    if (mEntity) return await handleEntity(store, decodeURIComponent(mEntity[1]), decodeURIComponent(mEntity[2]), res);
    return notFound(res);
  }
  if (method === "POST") {
    if (apiPath === "/api/decisions") return await handlePostDecision(store, req, res);
    if (apiPath === "/api/edges") return await handlePostEdge(store, req, res);
    return notFound(res);
  }
  res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET, POST" });
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

export function startServer(opts: ServeOptions): Promise<void> {
  const { store, multi = false, port = 3939, host = "127.0.0.1", open = false } = opts;
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

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[stele] port ${port} is already in use on ${host} — pass --port to pick another`);
        process.exit(1);
      }
      reject(err);
    });

    server.listen(port, host, () => {
      const url = `http://${host}:${port}`;
      const modeStr = multi ? " (multi-tenant)" : "";
      console.log(`stele serving on ${url}${modeStr}`);
      if (multi && ctx) {
        const n = ctx.projects().length;
        console.log(`  ${n} project(s) registered`);
      }
      console.log(`(Ctrl-C to stop)`);
      if (open) openBrowser(url);
      // Don't resolve — server runs until killed.
    });

    process.on("SIGINT", () => {
      console.log("");
      console.log(`stopping…`);
      server.close(() => process.exit(0));
    });
  });
}
