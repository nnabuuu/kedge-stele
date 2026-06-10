// Tests for src/capture.ts (0.1.0). resolveFeatureAndSession wires the
// agent's feature + sourceSession judgment into actual Project/Feature/
// Feature/Session rows; recordSessionStart/End are the explicit
// session_start / session_end helpers.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Store } from "./store.ts";
import {
  recordSessionEnd,
  recordSessionStart,
  resolveFeatureAndSession,
} from "./capture.ts";

const AT = "2026-06-09T00:00:00Z";

function bootProject(s: Store): { projectId: string } {
  const projectId = s.nextProjectId();
  s.putProject({
    id: projectId, name: "test", path: "/test", status: "active",
    createdAt: AT,
  });
  return { projectId };
}

// ---- mode = unscoped -------------------------------------------------------

test("mode='unscoped' binds to the auto-created unscoped feature", () => {
  const s = new Store(":memory:");
  bootProject(s);
  const r = resolveFeatureAndSession(s, { mode: "unscoped" }, undefined, AT);
  assert.ok(r.featureId);
  assert.ok(r.sessionId);
  const m = s.getFeature(r.featureId)!;
  assert.equal(m.name, "unscoped");
});

test("mode=undefined behaves like mode='unscoped'", () => {
  const s = new Store(":memory:");
  bootProject(s);
  const r = resolveFeatureAndSession(s, undefined, undefined, AT);
  assert.ok(r.featureId);
  const m = s.getFeature(r.featureId)!;
  assert.equal(m.name, "unscoped");
});

// ---- mode = continue -------------------------------------------------------

test("mode='continue' reuses the named feature", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  s.putFeature({ id: "F-01", projectId, name: "First", state: "going", startedAt: AT });

  const r = resolveFeatureAndSession(s, { mode: "continue", id: "F-01" }, undefined, AT);
  assert.equal(r.featureId, "F-01");
});

test("mode='continue' rejects unknown feature id", () => {
  const s = new Store(":memory:");
  bootProject(s);
  assert.throws(() =>
    resolveFeatureAndSession(s, { mode: "continue", id: "F-NOPE" }, undefined, AT),
  );
});

// ---- mode = new ------------------------------------------------------------

test("mode='new' creates a fresh Feature with state='draft'", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  const r = resolveFeatureAndSession(
    s, { mode: "new", draft: { name: "Binary artifact" } },
    undefined, AT,
  );
  const m = s.getFeature(r.featureId)!;
  assert.equal(m.name, "Binary artifact");
  assert.equal(m.projectId, projectId);
  // First session auto-advances state from 'draft' to 'going'.
  assert.equal(m.state, "going");
});

test("mode='new' threads the draft 'about' field through", () => {
  const s = new Store(":memory:");
  bootProject(s);
  const r = resolveFeatureAndSession(
    s,
    { mode: "new", draft: { name: "Binary artifact", about: "SSE auth + arbitrary uploads" } },
    undefined, AT,
  );
  const m = s.getFeature(r.featureId)!;
  assert.equal(m.about, "SSE auth + arbitrary uploads");
});

test("first session on a new feature advances state draft → going", () => {
  const s = new Store(":memory:");
  bootProject(s);
  const r = resolveFeatureAndSession(
    s, { mode: "new", draft: { name: "x" } },
    undefined, AT,
  );
  const m = s.getFeature(r.featureId)!;
  assert.equal(m.state, "going");
});

// ---- session dedup ---------------------------------------------------------

test("sourceSession + sourceSessionId dedup: two captures collapse to one Session", () => {
  const s = new Store(":memory:");
  bootProject(s);
  const ctx = { source: "claude-code" as const, sourceSessionId: "abc123" };
  const r1 = resolveFeatureAndSession(s, { mode: "unscoped" }, ctx, AT);
  const r2 = resolveFeatureAndSession(s, { mode: "unscoped" }, ctx, AT);
  assert.equal(r1.sessionId, r2.sessionId);
});

test("feature-mismatch: existing session gets reassigned to the new feature", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  s.putFeature({ id: "F-03", projectId, name: "old", state: "going", startedAt: AT });
  s.putFeature({ id: "F-04", projectId, name: "new", state: "going", startedAt: AT });

  const ctx = { source: "claude-code" as const, sourceSessionId: "abc" };
  const r1 = resolveFeatureAndSession(s, { mode: "continue", id: "F-03" }, ctx, AT);
  assert.equal(s.getSession(r1.sessionId)!.featureId, "F-03");
  const r2 = resolveFeatureAndSession(s, { mode: "continue", id: "F-04" }, ctx, AT);
  assert.equal(r2.sessionId, r1.sessionId);
  assert.equal(s.getSession(r2.sessionId)!.featureId, "F-04");
});

// ---- recordSessionStart ----------------------------------------------------

test("recordSessionStart creates a new session with provenance", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  const m = s.ensureUnscopedFeature(projectId);
  const sess = recordSessionStart(
    s, m.id,
    { source: "claude-code", sourceSessionId: "xyz" },
    { cwd: "/home/me", layoutAlive: true },
  );
  assert.equal(sess.featureId, m.id);
  assert.equal(sess.provenance!.cwd, "/home/me");
  assert.equal(sess.provenance!.layoutAlive, true);
});

test("recordSessionStart is idempotent on (source, sourceSessionId)", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  const m = s.ensureUnscopedFeature(projectId);
  const a = recordSessionStart(s, m.id, { source: "claude-code", sourceSessionId: "x" });
  const b = recordSessionStart(s, m.id, { source: "claude-code", sourceSessionId: "x" });
  assert.equal(a.id, b.id);
});

// ---- recordSessionEnd ------------------------------------------------------

test("recordSessionEnd writes outcome + pauseReason", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  const m = s.ensureUnscopedFeature(projectId);
  const sess = recordSessionStart(s, m.id, { source: "manual" });
  const closed = recordSessionEnd(
    s, sess.id,
    { type: "advanced", summary: "wrote tests" },
    { kind: "out_of_time", note: "back tomorrow" },
  );
  assert.equal(closed.outcome!.type, "advanced");
  assert.equal(closed.pauseReason!.kind, "out_of_time");
  assert.ok(closed.endedAt);
});

test("recordSessionEnd with outcome.type='resolved' advances feature going → winding", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  const m = s.ensureUnscopedFeature(projectId);
  // boot session moves state from draft → going inside recordSessionStart
  const sess = recordSessionStart(s, m.id, { source: "manual" });
  assert.equal(s.getFeature(m.id)!.state, "going");
  recordSessionEnd(s, sess.id, { type: "resolved", summary: "ok" });
  assert.equal(s.getFeature(m.id)!.state, "winding");
});
