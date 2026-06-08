// HTTP entry point. `stele serve` runs this — a localhost-only Node http
// server fronting the same store the MCP server and CLI talk to. Three
// surfaces, one truth (the .stele/decisions.db SQLite file).
//
// Routes are intentionally thin: GET handlers call into projections.ts,
// POST handlers validate with the shared Zod schemas (src/schemas.ts) and
// then call into store.ts. Zero business logic lives here.
//
// Static assets (web/index.html, web/styles.css, web/app.js) are read once
// at startup into memory — no filesystem IO per request.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import type { Store } from "./store.ts";
import { proposeEdges } from "./consolidate.ts";
import { resumeDigest, trace, traceEntity } from "./projections.ts";
import { stubResolver } from "./resolver.ts";
import { CapturePayloadSchema, EdgeSchema } from "./schemas.ts";
import type { CapturePayload, Edge, EntityRef } from "./types.ts";

export interface ServeOptions {
  store: Store;
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
// Response helpers
// -----------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function notFound(res: ServerResponse): void {
  json(res, 404, { error: "not found" });
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
// Route handlers
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

  // Mirror mcp.ts decision_capture: compute proposed edges BEFORE writing
  // so we can return them; then write the node and any authored edges.
  const proposed = proposeEdges(store, payload.decision);
  store.putDecision(payload.decision as CapturePayload["decision"]);
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
// Dispatcher
// -----------------------------------------------------------------------------

async function dispatch(
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
      // Static
      if (path === "/" || path === "/index.html") return asset(res, assets.index);
      if (path.startsWith("/assets/")) {
        const file = assets.files.get(path.slice("/assets/".length));
        return file ? asset(res, file) : notFound(res);
      }
      // SPA fallback — any non-/api path serves the index so client-side
      // routes (e.g. /decisions/D-04) are deep-linkable.
      if (!path.startsWith("/api/")) return asset(res, assets.index);

      // API GETs
      if (path === "/api/resume") return json(res, 200, resumeDigest(store));
      if (path === "/api/decisions") return json(res, 200, store.allDecisions());
      if (path === "/api/next-id") {
        return handleNextId(store, url.searchParams.get("prefix") ?? "D", res);
      }
      const mDecision = path.match(/^\/api\/decisions\/([^/]+)$/);
      if (mDecision) return await handleDecision(store, mDecision[1], res);
      const mEntity = path.match(/^\/api\/entity\/([^/]+)\/([^/]+)$/);
      if (mEntity) return await handleEntity(store, mEntity[1], mEntity[2], res);

      return notFound(res);
    }

    if (method === "POST") {
      if (path === "/api/decisions") return await handlePostDecision(store, req, res);
      if (path === "/api/edges") return await handlePostEdge(store, req, res);
      return notFound(res);
    }

    res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET, POST" });
    res.end(JSON.stringify({ error: "method not allowed" }));
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
  const { store, port = 3939, host = "127.0.0.1", open = false } = opts;
  const assets = loadAssets();

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      void dispatch(store, assets, req, res);
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
      console.log(`stele serving on ${url}`);
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
