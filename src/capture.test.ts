// Tests for src/capture.ts (0.1.0). resolveMilestoneAndSession wires the
// agent's milestone + sourceSession judgment into actual Project/Feature/
// Milestone/Session rows; recordSessionStart/End are the explicit
// session_start / session_end helpers.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Store } from "./store.ts";
import {
  recordSessionEnd,
  recordSessionStart,
  resolveMilestoneAndSession,
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

test("mode='unscoped' binds to the auto-created unscoped milestone", () => {
  const s = new Store(":memory:");
  bootProject(s);
  const r = resolveMilestoneAndSession(s, { mode: "unscoped" }, undefined, AT);
  assert.ok(r.milestoneId);
  assert.ok(r.sessionId);
  const m = s.getMilestone(r.milestoneId)!;
  assert.equal(m.name, "unscoped");
});

test("mode=undefined behaves like mode='unscoped'", () => {
  const s = new Store(":memory:");
  bootProject(s);
  const r = resolveMilestoneAndSession(s, undefined, undefined, AT);
  assert.ok(r.milestoneId);
  const m = s.getMilestone(r.milestoneId)!;
  assert.equal(m.name, "unscoped");
});

// ---- mode = continue -------------------------------------------------------

test("mode='continue' reuses the named milestone", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  // Set up an explicit milestone under a real feature
  const fid = s.nextFeatureId();
  s.putFeature({ id: fid, projectId, name: "Backend" });
  s.putMilestone({ id: "M-01", featureId: fid, name: "First", state: "going", startedAt: AT });

  const r = resolveMilestoneAndSession(s, { mode: "continue", id: "M-01" }, undefined, AT);
  assert.equal(r.milestoneId, "M-01");
});

test("mode='continue' rejects unknown milestone id", () => {
  const s = new Store(":memory:");
  bootProject(s);
  assert.throws(() =>
    resolveMilestoneAndSession(s, { mode: "continue", id: "M-NOPE" }, undefined, AT),
  );
});

// ---- mode = new ------------------------------------------------------------

test("mode='new' with featureDraft creates Feature + Milestone in one shot", () => {
  const s = new Store(":memory:");
  bootProject(s);
  const r = resolveMilestoneAndSession(
    s,
    { mode: "new", draft: { name: "Binary artifact", featureDraft: { name: "CcaaS" } } },
    undefined, AT,
  );
  const m = s.getMilestone(r.milestoneId)!;
  assert.equal(m.name, "Binary artifact");
  const f = s.getFeature(m.featureId)!;
  assert.equal(f.name, "CcaaS");
});

test("mode='new' with existing featureId uses it without creating a new Feature", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  const fid = s.nextFeatureId();
  s.putFeature({ id: fid, projectId, name: "Backend" });

  const r = resolveMilestoneAndSession(
    s, { mode: "new", draft: { name: "x", featureId: fid } },
    undefined, AT,
  );
  const m = s.getMilestone(r.milestoneId)!;
  assert.equal(m.featureId, fid);
  // Should NOT have created a second feature with the same project
  assert.equal(s.featuresIn(projectId).length, 1);
});

test("mode='new' without featureId or featureDraft falls back to unscoped feature", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  const r = resolveMilestoneAndSession(
    s, { mode: "new", draft: { name: "free-form" } },
    undefined, AT,
  );
  const m = s.getMilestone(r.milestoneId)!;
  const f = s.getFeature(m.featureId)!;
  assert.equal(f.name, "unscoped");
  assert.equal(f.projectId, projectId);
});

test("first session on a new milestone advances state draft → going", () => {
  const s = new Store(":memory:");
  bootProject(s);
  const r = resolveMilestoneAndSession(
    s, { mode: "new", draft: { name: "x" } },
    undefined, AT,
  );
  const m = s.getMilestone(r.milestoneId)!;
  assert.equal(m.state, "going");
});

// ---- session dedup ---------------------------------------------------------

test("sourceSession + sourceSessionId dedup: two captures collapse to one Session", () => {
  const s = new Store(":memory:");
  bootProject(s);
  const ctx = { source: "claude-code" as const, sourceSessionId: "abc123" };
  const r1 = resolveMilestoneAndSession(s, { mode: "unscoped" }, ctx, AT);
  const r2 = resolveMilestoneAndSession(s, { mode: "unscoped" }, ctx, AT);
  assert.equal(r1.sessionId, r2.sessionId);
});

test("milestone-mismatch: existing session gets reassigned to the new milestone", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  const fid = s.nextFeatureId();
  s.putFeature({ id: fid, projectId, name: "x" });
  s.putMilestone({ id: "M-03", featureId: fid, name: "old", state: "going", startedAt: AT });
  s.putMilestone({ id: "M-04", featureId: fid, name: "new", state: "going", startedAt: AT });

  const ctx = { source: "claude-code" as const, sourceSessionId: "abc" };
  const r1 = resolveMilestoneAndSession(s, { mode: "continue", id: "M-03" }, ctx, AT);
  assert.equal(s.getSession(r1.sessionId)!.milestoneId, "M-03");
  const r2 = resolveMilestoneAndSession(s, { mode: "continue", id: "M-04" }, ctx, AT);
  assert.equal(r2.sessionId, r1.sessionId);
  assert.equal(s.getSession(r2.sessionId)!.milestoneId, "M-04");
});

// ---- recordSessionStart ----------------------------------------------------

test("recordSessionStart creates a new session with provenance", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  const m = s.ensureUnscopedMilestone(projectId);
  const sess = recordSessionStart(
    s, m.id,
    { source: "claude-code", sourceSessionId: "xyz" },
    { cwd: "/home/me", layoutAlive: true },
  );
  assert.equal(sess.milestoneId, m.id);
  assert.equal(sess.provenance!.cwd, "/home/me");
  assert.equal(sess.provenance!.layoutAlive, true);
});

test("recordSessionStart is idempotent on (source, sourceSessionId)", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  const m = s.ensureUnscopedMilestone(projectId);
  const a = recordSessionStart(s, m.id, { source: "claude-code", sourceSessionId: "x" });
  const b = recordSessionStart(s, m.id, { source: "claude-code", sourceSessionId: "x" });
  assert.equal(a.id, b.id);
});

// ---- recordSessionEnd ------------------------------------------------------

test("recordSessionEnd writes outcome + pauseReason", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  const m = s.ensureUnscopedMilestone(projectId);
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

test("recordSessionEnd with outcome.type='resolved' advances milestone going → winding", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  const m = s.ensureUnscopedMilestone(projectId);
  // boot session moves state from draft → going inside recordSessionStart
  const sess = recordSessionStart(s, m.id, { source: "manual" });
  assert.equal(s.getMilestone(m.id)!.state, "going");
  recordSessionEnd(s, sess.id, { type: "resolved", summary: "ok" });
  assert.equal(s.getMilestone(m.id)!.state, "winding");
});
