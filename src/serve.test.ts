// Tests for src/serve.ts (0.1.0). HTTP smoke covering single-project +
// multi-tenant dispatch with the new schema (Project, Feature, Milestone
// 5-state, Decision split, Edge.relation, depends_on, session lifecycle).
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

const AT = "2026-06-09T00:00:00Z";

function bootProject(s: Store): { projectId: string; milestoneId: string } {
  const projectId = s.nextProjectId();
  s.putProject({ id: projectId, name: "test", path: "/test", status: "active", createdAt: AT });
  const m = s.ensureUnscopedMilestone(projectId);
  return { projectId, milestoneId: m.id };
}

function mkOpen(milestoneId: string, id: string, title: string): Decision {
  return {
    id: `${milestoneId}/${id}`, milestoneId, type: "open", status: "open",
    title,
    raisedBy: { trigger: "t", actor: "a", layer: "personal", at: AT },
    affects: [], createdAt: AT,
  };
}

function mkDecided(milestoneId: string, id: string, title: string): Decision {
  return {
    id: `${milestoneId}/${id}`, milestoneId, type: "decision",
    title,
    raisedBy: { trigger: "t", actor: "a", layer: "personal", at: AT },
    detail: { options: [{ name: "A", verdict: "chosen", chosen: true }] },
    affects: [], createdAt: AT,
  };
}

function seedStore(): Store {
  const s = new Store(":memory:");
  const { milestoneId } = bootProject(s);
  s.putDecision(mkOpen(milestoneId, "OQ-01", "open one"));
  s.putDecision(mkOpen(milestoneId, "OQ-02", "open two"));
  s.putDecision(mkDecided(milestoneId, "D-01", "decided one"));
  return s;
}

// Helper used by route tests that need the auto-created unscoped milestone
// id. Goes through the Store API so the test isn't coupled to the sentinel
// id format.
function unscopedMid(s: Store): string {
  const p = s.theProject()!;
  return s.ensureUnscopedMilestone(p.id).id;
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
// Static assets + SPA shell
// ============================================================================

test("GET / returns the SPA HTML shell", async () => {
  running = await startServer({ store: seedStore(), port: 0 });
  const r = await fetch(`${running.url}/`);
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(text.includes("<!DOCTYPE html>"));
});

test("GET /assets/styles/tokens.css serves CSS (nested asset path)", async () => {
  running = await startServer({ store: seedStore(), port: 0 });
  const r = await fetch(`${running.url}/assets/styles/tokens.css`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/css/);
});

// 0.2.0-snapshot.7 — the SPA boots into the Projects overview which calls
// GET /api/projects. The multi-tenant dispatcher serves this; single-project
// mode needs a synthetic one-element response so the SPA doesn't 404 on its
// own entry page.
test("GET /api/projects in single-project mode returns one synthetic entry", async () => {
  running = await startServer({ store: seedStore(), port: 0 });
  const r = await fetch(`${running.url}/api/projects`);
  assert.equal(r.status, 200);
  const list = await r.json() as Array<{ slug: string; name: string; openLoops: number }>;
  assert.ok(Array.isArray(list), "response must be an array");
  assert.equal(list.length, 1, "single-project mode must surface exactly one entry");
  assert.ok(typeof list[0].slug === "string" && list[0].slug.length > 0);
});

// 0.2.0-snapshot.7 — the SPA's slug-prefixed routes (/<slug>/, /<slug>/api/...)
// must work uniformly in single-project mode by treating the first segment as
// cosmetic and dispatching to the single store.
test("GET /<anything>/ serves the SPA shell in single-project mode", async () => {
  running = await startServer({ store: seedStore(), port: 0 });
  const r = await fetch(`${running.url}/some-cosmetic-slug/`);
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.match(body, /<!DOCTYPE html>/);
});

test("GET /<anything>/api/resume strips slug and dispatches in single mode", async () => {
  running = await startServer({ store: seedStore(), port: 0 });
  const r = await fetch(`${running.url}/some-cosmetic-slug/api/resume`);
  assert.equal(r.status, 200);
  // Same payload as bare /api/resume
  const items = await r.json() as Array<{ id: string }>;
  assert.ok(Array.isArray(items));
});

// ============================================================================
// Decision / Edge / resume — core projections
// ============================================================================

test("GET /api/resume returns open + un-resolved deferred items", async () => {
  running = await startServer({ store: seedStore(), port: 0 });
  const r = await fetch(`${running.url}/api/resume`);
  const items = await r.json() as Array<{ id: string; bucket: string }>;
  assert.equal(items.length, 2);
});

test("GET /api/decisions returns all", async () => {
  running = await startServer({ store: seedStore(), port: 0 });
  const r = await fetch(`${running.url}/api/decisions`);
  const list = await r.json() as Array<{ id: string }>;
  assert.equal(list.length, 3);
});

test("GET /api/decisions/<milestone>/<local> returns trace (slash in id is supported)", async () => {
  const s = seedStore();
  const decisionId = `${unscopedMid(s)}/D-01`;
  running = await startServer({ store: s, port: 0 });
  // The route gobbles the whole tail after `/api/decisions/`, including slashes.
  const r = await fetch(`${running.url}/api/decisions/${decisionId}`);
  assert.equal(r.status, 200);
  const t = await r.json() as { decision: { id: string }; statusLine: string };
  assert.equal(t.decision.id, decisionId);
  assert.ok(t.statusLine.includes("DECIDED"));
});

test("GET /api/decisions/NOPE returns 404", async () => {
  running = await startServer({ store: seedStore(), port: 0 });
  const r = await fetch(`${running.url}/api/decisions/NOPE`);
  assert.equal(r.status, 404);
});

test("GET /api/next-id requires milestone parameter", async () => {
  running = await startServer({ store: seedStore(), port: 0 });
  const r = await fetch(`${running.url}/api/next-id?prefix=D`);
  assert.equal(r.status, 400);
});

test("GET /api/next-id?prefix=D&milestone=... returns <milestone>/<local>", async () => {
  const s = seedStore();
  running = await startServer({ store: s, port: 0 });
  const milestoneId = unscopedMid(s); // the auto-generated id from ensureUnscopedMilestone with projectId P-01
  const r = await fetch(`${running.url}/api/next-id?prefix=D&milestone=${encodeURIComponent(milestoneId)}`);
  // Existing decided one is M-01-unscoped/D-01, next should be D-02
  assert.equal(r.status, 200);
  const id = await r.json();
  assert.equal(id, `${milestoneId}/D-02`);
});

test("POST /api/edges with relation: 'resolves' flips target to resolved", async () => {
  const s = seedStore();
  const milestoneId = unscopedMid(s);
  running = await startServer({ store: s, port: 0 });
  const r = await fetch(`${running.url}/api/edges`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      from: `${milestoneId}/D-01`, to: `${milestoneId}/OQ-01`, relation: "resolves",
    }),
  });
  assert.equal(r.status, 200);
  const d = s.getDecision(`${milestoneId}/OQ-01`)!;
  assert.equal(d.status, "resolved");
  assert.equal(d.resolvedBy, `${milestoneId}/D-01`);
});

test("POST /api/edges with depends_on (new in 0.1.0) is accepted", async () => {
  const s = seedStore();
  const milestoneId = unscopedMid(s);
  running = await startServer({ store: s, port: 0 });
  const r = await fetch(`${running.url}/api/edges`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      from: `${milestoneId}/D-01`, to: `${milestoneId}/OQ-01`, relation: "depends_on",
    }),
  });
  assert.equal(r.status, 200);
});

test("POST /api/edges with old 'kind' field is rejected", async () => {
  running = await startServer({ store: seedStore(), port: 0 });
  const r = await fetch(`${running.url}/api/edges`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: "x", to: "y", kind: "resolves" }),
  });
  assert.equal(r.status, 400);
});

// ============================================================================
// Project / Feature / Milestone — 0.1.0 new entities
// ============================================================================

test("GET /api/project returns the single Project + rollup", async () => {
  running = await startServer({ store: seedStore(), port: 0 });
  const r = await fetch(`${running.url}/api/project`);
  assert.equal(r.status, 200);
  const body = await r.json() as { project: { name: string }; rollup: { milestoneCount: number } };
  assert.equal(body.project.name, "test");
  assert.ok(body.rollup.milestoneCount >= 1);
});

test("POST /api/features creates a new Feature", async () => {
  running = await startServer({ store: seedStore(), port: 0 });
  const r = await fetch(`${running.url}/api/features`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "CcaaS" }),
  });
  assert.equal(r.status, 200);
  const f = await r.json() as { id: string; name: string };
  assert.equal(f.name, "CcaaS");
});

test("GET /api/milestones returns the summary (state field)", async () => {
  running = await startServer({ store: seedStore(), port: 0 });
  const r = await fetch(`${running.url}/api/milestones`);
  const list = await r.json() as Array<{ milestone: { state: string } }>;
  assert.ok(list.length >= 1);
  assert.ok(["draft", "going", "winding", "done", "paused"].includes(list[0].milestone.state));
});

test("GET /api/milestones/:id/report returns a draft", async () => {
  const s = seedStore();
  const milestoneId = unscopedMid(s);
  running = await startServer({ store: s, port: 0 });
  const r = await fetch(`${running.url}/api/milestones/${encodeURIComponent(milestoneId)}/report`);
  assert.equal(r.status, 200);
  const draft = await r.json() as { milestoneId: string; openLoops: unknown[] };
  assert.equal(draft.milestoneId, milestoneId);
  // The 2 open decisions from the seed
  assert.equal(draft.openLoops.length, 2);
});

// ============================================================================
// Session lifecycle
// ============================================================================

test("POST /api/sessions/start opens a session under a milestone", async () => {
  const s = seedStore();
  const milestoneId = unscopedMid(s);
  running = await startServer({ store: s, port: 0 });
  const r = await fetch(`${running.url}/api/sessions/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      milestoneId,
      sourceSession: { source: "claude-code", sourceSessionId: "abc" },
      provenance: { cwd: "/x", layoutAlive: true },
    }),
  });
  assert.equal(r.status, 200);
  const sess = await r.json() as { id: string; provenance: { layoutAlive: boolean } };
  assert.equal(sess.provenance.layoutAlive, true);
});

test("POST /api/sessions/:id/end writes outcome + pauseReason", async () => {
  const s = seedStore();
  const milestoneId = unscopedMid(s);
  s.putSession({ id: "ses-x", milestoneId, source: "manual", startedAt: AT });
  running = await startServer({ store: s, port: 0 });
  const r = await fetch(`${running.url}/api/sessions/ses-x/end`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      outcome: { type: "advanced", summary: "ok" },
      pauseReason: { kind: "out_of_time" },
    }),
  });
  assert.equal(r.status, 200);
  assert.equal(s.getSession("ses-x")!.outcome!.type, "advanced");
  assert.equal(s.getSession("ses-x")!.pauseReason!.kind, "out_of_time");
});

test("GET /api/sessions/:id/resume-command returns mode + command", async () => {
  const s = seedStore();
  const milestoneId = unscopedMid(s);
  s.putSession({
    id: "ses-x", milestoneId, source: "claude-code", sourceSessionId: "xyz",
    startedAt: AT,
    provenance: { cwd: "/home/me", layoutAlive: false },
  });
  running = await startServer({ store: s, port: 0 });
  const r = await fetch(`${running.url}/api/sessions/ses-x/resume-command`);
  const body = await r.json() as { mode: string; command: string; copyable: boolean };
  assert.equal(body.mode, "rebuild");
  assert.ok(body.command.includes("claude --resume xyz"));
  assert.equal(body.copyable, true);
});

// ============================================================================
// Tags + config (carried over from 0.0.7 — these stay green)
// ============================================================================

test("GET /api/tags returns active by default", async () => {
  const s = seedStore();
  s.putTag({
    id: "tag-a", name: "active", color: "#0d5245",
    kind: "scope", origin: "you", status: "active", createdAt: AT,
  });
  running = await startServer({ store: s, port: 0 });
  const r = await fetch(`${running.url}/api/tags`);
  const body = await r.json() as Array<{ id: string }>;
  assert.equal(body.length, 1);
});

test("POST /api/tags follows tag_policy (default propose)", async () => {
  const s = seedStore();
  running = await startServer({ store: s, port: 0 });
  const r = await fetch(`${running.url}/api/tags`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "security",
      reason: "OWASP",
      targets: [{ kind: "decision", id: "M-01-unscoped/D-01" }],
    }),
  });
  assert.equal(r.status, 200);
  const body = await r.json() as { kind: string };
  assert.equal(body.kind, "pending");
});

test("GET /api/config returns defaults inline", async () => {
  running = await startServer({ store: seedStore(), port: 0 });
  const r = await fetch(`${running.url}/api/config`);
  const body = await r.json() as { _defaults: { tag_policy: string } };
  assert.equal(body._defaults.tag_policy, "propose");
});

// ============================================================================
// Multi-tenant routing
// ============================================================================

function seedProjectIntoRegistry(slug: string, tmpHome: string): string {
  const projDir = mkdtempSync(join(tmpHome, `proj-`));
  mkdirSync(join(projDir, ".stele"));
  // Boot a fresh store at that path and create a Project row so the routes work
  const dbPath = join(projDir, ".stele", "decisions.db");
  const s = new Store(dbPath);
  const pid = s.nextProjectId();
  s.putProject({
    id: pid, name: slug, path: projDir, status: "active", createdAt: AT,
  });
  s.ensureUnscopedFeature(pid);
  return projDir;
}

test("multi · GET /api/projects returns the registered list", async () => {
  running = await startServer({ multi: true, port: 0 });
  let r = await fetch(`${running.url}/api/projects`);
  assert.deepEqual(await r.json(), []);

  const path1 = seedProjectIntoRegistry("alpha", tmpHome);
  register(path1);
  r = await fetch(`${running.url}/api/projects`);
  const projects = await r.json() as Array<{ slug: string }>;
  assert.equal(projects.length, 1);
});

test("multi · GET /<slug>/api/project returns that project's row", async () => {
  const path = seedProjectIntoRegistry("alpha", tmpHome);
  const reg = register(path);
  saveRegistry({ projects: [{ slug: reg.slug, path, addedAt: AT }] });
  running = await startServer({ multi: true, port: 0 });
  const r = await fetch(`${running.url}/${reg.slug}/api/project`);
  assert.equal(r.status, 200);
});
