// Tests for src/serve.ts — HTTP smoke covering both single-project and
// multi-tenant dispatch.
//
// startServer was refactored to resolve once listening (returning a
// RunningServer handle). We bind to port 0 (kernel-assigned) and tear
// down in afterEach.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "./store.ts";
import { startServer, type RunningServer } from "./serve.ts";
import { register, saveRegistry } from "./registry.ts";
import type { Decision } from "./types.ts";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const baseRaisedBy = {
  trigger: "test",
  actor: "tester",
  layer: "personal" as const,
  at: "2026-06-01T00:00:00Z",
};

function mkOpen(id: string, title: string): Decision {
  return {
    id, title,
    raisedBy: baseRaisedBy,
    status: { kind: "open", question: title },
    affects: [],
  };
}

function mkDecided(id: string, title: string): Decision {
  return {
    id, title,
    raisedBy: baseRaisedBy,
    status: {
      kind: "decided",
      options: [{ label: "A", summary: "a", verdict: "chosen" }],
      rationale: "because",
    },
    affects: [],
  };
}

function seedStore(): Store {
  const s = new Store(":memory:");
  s.putDecision(mkOpen("OQ-1", "open one"));
  s.putDecision(mkOpen("OQ-2", "open two"));
  s.putDecision(mkDecided("D-1", "decided one"));
  return s;
}

let savedHome: string | undefined;
let tmpHome: string;
let running: RunningServer | null = null;

beforeEach(() => {
  savedHome = process.env.HOME;
  tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "stele-serve-test-")));
  process.env.HOME = tmpHome;
});

afterEach(async () => {
  if (running) {
    await running.close().catch(() => {});
    running = null;
  }
  rmSync(tmpHome, { recursive: true, force: true });
  if (savedHome !== undefined) process.env.HOME = savedHome;
  else delete process.env.HOME;
});

// ============================================================================
// Single-project mode
// ============================================================================

test("single-project · GET / returns the SPA HTML shell", async () => {
  running = await startServer({ store: seedStore(), port: 0 });
  const r = await fetch(`${running.url}/`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "text/html; charset=utf-8");
  const text = await r.text();
  assert.ok(text.includes("<!DOCTYPE html>"));
});

test("single-project · GET /assets/styles.css serves CSS", async () => {
  running = await startServer({ store: seedStore(), port: 0 });
  const r = await fetch(`${running.url}/assets/styles.css`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "text/css; charset=utf-8");
});

test("single-project · GET /api/resume returns WaitingItem[]", async () => {
  running = await startServer({ store: seedStore(), port: 0 });
  const r = await fetch(`${running.url}/api/resume`);
  assert.equal(r.status, 200);
  const items = await r.json() as Array<{ id: string; bucket: string }>;
  assert.equal(items.length, 2, "two open items expected");
  const ids = items.map((i) => i.id).sort();
  assert.deepEqual(ids, ["OQ-1", "OQ-2"]);
});

test("single-project · GET /api/decisions returns all", async () => {
  running = await startServer({ store: seedStore(), port: 0 });
  const r = await fetch(`${running.url}/api/decisions`);
  const list = await r.json() as Array<{ id: string }>;
  assert.equal(list.length, 3);
});

test("single-project · GET /api/decisions/:id returns trace shape", async () => {
  running = await startServer({ store: seedStore(), port: 0 });
  const r = await fetch(`${running.url}/api/decisions/D-1`);
  assert.equal(r.status, 200);
  const t = await r.json() as { decision: { id: string }; statusLine: string };
  assert.equal(t.decision.id, "D-1");
  assert.ok(t.statusLine.includes("DECIDED"));
});

test("single-project · GET /api/decisions/:nonexistent returns 404", async () => {
  running = await startServer({ store: seedStore(), port: 0 });
  const r = await fetch(`${running.url}/api/decisions/NOPE`);
  assert.equal(r.status, 404);
});

test("single-project · GET /api/next-id?prefix=D returns next slot", async () => {
  const store = seedStore();
  // D-1 already exists → next should be D-02
  running = await startServer({ store, port: 0 });
  const r = await fetch(`${running.url}/api/next-id?prefix=D`);
  const id = await r.json();
  assert.equal(id, "D-02");
});

test("single-project · POST /api/decisions captures a new node", async () => {
  const store = seedStore();
  running = await startServer({ store, port: 0 });
  const decision = {
    id: "D-99",
    title: "new one",
    raisedBy: baseRaisedBy,
    status: { kind: "decided", options: [{ label: "A", summary: "a", verdict: "chosen" }], rationale: "because" },
    affects: [],
  };
  const r = await fetch(`${running.url}/api/decisions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  assert.equal(r.status, 200);
  const result = await r.json() as { id: string };
  assert.equal(result.id, "D-99");

  // Verify it landed in the store
  assert.ok(store.getDecision("D-99"));
});

test("single-project · POST /api/decisions with bad payload returns 400", async () => {
  running = await startServer({ store: seedStore(), port: 0 });
  const r = await fetch(`${running.url}/api/decisions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: { id: "X" } }),
  });
  assert.equal(r.status, 400);
});

test("single-project · POST /api/edges adds an edge", async () => {
  const store = seedStore();
  running = await startServer({ store, port: 0 });
  const r = await fetch(`${running.url}/api/edges`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: "D-1", to: "OQ-1", kind: "resolves" }),
  });
  assert.equal(r.status, 200);
  // Side effect: OQ-1 should now be resolved
  const d = store.getDecision("OQ-1");
  assert.equal(d!.status.kind, "resolved");
});

test("single-project · POST /api/edges rejects unknown endpoints", async () => {
  running = await startServer({ store: seedStore(), port: 0 });
  const r = await fetch(`${running.url}/api/edges`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: "NOPE", to: "OQ-1", kind: "resolves" }),
  });
  assert.equal(r.status, 400);
});

test("single-project · GET /random/spa/path falls back to index", async () => {
  running = await startServer({ store: seedStore(), port: 0 });
  const r = await fetch(`${running.url}/decisions/D-1`);
  // Even though this isn't a real backend route, the SPA fallback serves index
  assert.equal(r.status, 200);
  assert.ok((await r.text()).includes("<!DOCTYPE html>"));
});

// ============================================================================
// Multi-tenant mode
// ============================================================================

function seedProjectIntoRegistry(slug: string, parentDir: string): string {
  // Create a project dir with a .stele/decisions.db so MultiStoreContext
  // can lazy-open it. Return the path.
  const projectPath = join(parentDir, slug);
  mkdirSync(join(projectPath, ".stele"), { recursive: true });
  // Bootstrap an empty Store at that path so the .db file exists
  const s = new Store(join(projectPath, ".stele", "decisions.db"));
  s.putDecision(mkOpen(`OQ-${slug}`, `open in ${slug}`));
  return projectPath;
}

test("multi · GET / returns the SPA shell", async () => {
  running = await startServer({ multi: true, port: 0 });
  const r = await fetch(`${running.url}/`);
  assert.equal(r.status, 200);
  assert.ok((await r.text()).includes("<!DOCTYPE html>"));
});

test("multi · GET /api/projects returns the registered list", async () => {
  const aPath = seedProjectIntoRegistry("alpha", tmpHome);
  const bPath = seedProjectIntoRegistry("beta", tmpHome);
  register(aPath);
  register(bPath);

  running = await startServer({ multi: true, port: 0 });
  const r = await fetch(`${running.url}/api/projects`);
  assert.equal(r.status, 200);
  const projects = await r.json() as Array<{ slug: string; openLoops: number }>;
  assert.equal(projects.length, 2);
  const slugs = projects.map((p) => p.slug).sort();
  assert.deepEqual(slugs, ["alpha", "beta"]);
  // Each project we seeded has 1 open loop
  for (const p of projects) assert.equal(p.openLoops, 1);
});

test("multi · GET /<slug>/api/resume returns that project's items", async () => {
  const path = seedProjectIntoRegistry("zeta", tmpHome);
  register(path);

  running = await startServer({ multi: true, port: 0 });
  const r = await fetch(`${running.url}/zeta/api/resume`);
  assert.equal(r.status, 200);
  const items = await r.json() as Array<{ id: string }>;
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "OQ-zeta");
});

test("multi · GET /<unknown-slug>/api/resume returns 404", async () => {
  running = await startServer({ multi: true, port: 0 });
  const r = await fetch(`${running.url}/no-such-slug/api/resume`);
  assert.equal(r.status, 404);
});

test("multi · GET /<slug>/anything-else falls back to the SPA shell", async () => {
  const path = seedProjectIntoRegistry("zeta", tmpHome);
  register(path);

  running = await startServer({ multi: true, port: 0 });
  const r = await fetch(`${running.url}/zeta/decisions/D-04`);
  assert.equal(r.status, 200);
  assert.ok((await r.text()).includes("<!DOCTYPE html>"));
});

test("multi · GET /assets/styles.css works (shared across projects)", async () => {
  running = await startServer({ multi: true, port: 0 });
  const r = await fetch(`${running.url}/assets/styles.css`);
  assert.equal(r.status, 200);
});

test("multi · reserved word 'api' as slug returns 404 (not treated as a project)", async () => {
  running = await startServer({ multi: true, port: 0 });
  const r = await fetch(`${running.url}/api/something-not-routed`);
  assert.equal(r.status, 404);
});

test("multi · POST /<slug>/api/decisions captures into that project's store", async () => {
  const path = seedProjectIntoRegistry("test-proj", tmpHome);
  register(path);

  running = await startServer({ multi: true, port: 0 });
  const decision = {
    id: "D-NEW",
    title: "captured via multi",
    raisedBy: baseRaisedBy,
    status: { kind: "decided", options: [{ label: "A", summary: "a", verdict: "chosen" }], rationale: "because" },
    affects: [],
  };
  const r = await fetch(`${running.url}/test-proj/api/decisions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  assert.equal(r.status, 200);

  // Reopening that project's store should see the new decision
  const s = new Store(join(path, ".stele", "decisions.db"));
  assert.ok(s.getDecision("D-NEW"));
});

test("multi · registry edits are picked up via mtime watch", async () => {
  running = await startServer({ multi: true, port: 0 });
  // Initially empty
  let r = await fetch(`${running.url}/api/projects`);
  assert.deepEqual(await r.json(), []);

  // Register a new project while server is running
  const path = seedProjectIntoRegistry("late", tmpHome);
  register(path);

  // Next request should see it (no restart needed)
  r = await fetch(`${running.url}/api/projects`);
  const projects = await r.json() as Array<{ slug: string }>;
  assert.equal(projects.length, 1);
  assert.equal(projects[0].slug, "late");
});
