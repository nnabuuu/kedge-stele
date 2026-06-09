// Tests for milestones in the 0.1.0 store. Covers the 5-state enum
// (draft/going/winding/done/paused), feature_id FK, about, sequenceAfter,
// and the new helpers.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Store } from "./store.ts";
import type { Milestone } from "./types.ts";

function bootProject(s: Store): { projectId: string; featureId: string } {
  const projectId = s.nextProjectId();
  s.putProject({
    id: projectId, name: "test", path: "/test", status: "active",
    createdAt: "2026-06-09T00:00:00Z",
  });
  const f = s.ensureUnscopedFeature(projectId);
  return { projectId, featureId: f.id };
}

function mkMilestone(
  featureId: string,
  id: string,
  name: string,
  state: Milestone["state"] = "draft",
): Milestone {
  return { id, featureId, name, state, startedAt: "2026-06-09T00:00:00Z" };
}

// ---- CRUD ------------------------------------------------------------------

test("putMilestone + getMilestone roundtrips", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  s.putMilestone(mkMilestone(featureId, "M-01", "first", "going"));
  const m = s.getMilestone("M-01");
  assert.ok(m);
  assert.equal(m!.name, "first");
  assert.equal(m!.state, "going");
});

test("putMilestone twice = upsert", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  s.putMilestone(mkMilestone(featureId, "M-01", "first", "draft"));
  s.putMilestone(mkMilestone(featureId, "M-01", "first-renamed", "going"));
  const m = s.getMilestone("M-01")!;
  assert.equal(m.name, "first-renamed");
  assert.equal(m.state, "going");
});

test("getMilestone returns null for missing id", () => {
  const s = new Store(":memory:");
  assert.equal(s.getMilestone("NOPE"), null);
});

// ---- 5-state enum ----------------------------------------------------------

test("byMilestoneState filters across all 5 states", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  for (const [id, state] of [
    ["M-01", "draft"], ["M-02", "going"], ["M-03", "winding"],
    ["M-04", "done"], ["M-05", "paused"],
  ] as const) {
    s.putMilestone(mkMilestone(featureId, id, id, state));
  }
  assert.equal(s.byMilestoneState("draft").length, 1);
  assert.equal(s.byMilestoneState("going").length, 1);
  assert.equal(s.byMilestoneState("winding").length, 1);
  assert.equal(s.byMilestoneState("done").length, 1);
  assert.equal(s.byMilestoneState("paused").length, 1);
});

test("setMilestoneState transitions and stamps completedAt on done", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  s.putMilestone(mkMilestone(featureId, "M-01", "x", "going"));
  s.setMilestoneState("M-01", "winding");
  assert.equal(s.getMilestone("M-01")!.state, "winding");
  assert.equal(s.getMilestone("M-01")!.completedAt, undefined);
  s.setMilestoneState("M-01", "done");
  const m = s.getMilestone("M-01")!;
  assert.equal(m.state, "done");
  assert.ok(m.completedAt);
});

test("setMilestoneState throws for missing milestone", () => {
  const s = new Store(":memory:");
  assert.throws(() => s.setMilestoneState("NOPE", "going"));
});

// ---- nextMilestoneId -------------------------------------------------------

test("nextMilestoneId starts at M-01", () => {
  const s = new Store(":memory:");
  bootProject(s);
  assert.equal(s.nextMilestoneId(), "M-01");
});

test("nextMilestoneId honors existing sequence", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  s.putMilestone(mkMilestone(featureId, "M-01", "a"));
  s.putMilestone(mkMilestone(featureId, "M-03", "c"));
  assert.equal(s.nextMilestoneId(), "M-04");
});

// ---- milestonesInFeature ---------------------------------------------------

test("milestonesInFeature groups by feature", () => {
  const s = new Store(":memory:");
  const { projectId, featureId } = bootProject(s);
  const f2id = s.nextFeatureId();
  s.putFeature({ id: f2id, projectId, name: "other" });
  s.putMilestone(mkMilestone(featureId, "M-01", "a"));
  s.putMilestone(mkMilestone(featureId, "M-02", "b"));
  s.putMilestone(mkMilestone(f2id, "M-03", "c"));
  assert.equal(s.milestonesInFeature(featureId).length, 2);
  assert.equal(s.milestonesInFeature(f2id).length, 1);
});

// ---- ensureUnscopedMilestone is idempotent ---------------------------------

test("ensureUnscopedMilestone creates once, returns existing thereafter", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  const m1 = s.ensureUnscopedMilestone(projectId);
  const m2 = s.ensureUnscopedMilestone(projectId);
  assert.equal(m1.id, m2.id);
  assert.equal(s.allMilestones().filter((m) => m.id === m1.id).length, 1);
});

test("ensureUnscopedMilestone lazy-creates unscoped feature too", () => {
  const s = new Store(":memory:");
  const projectId = s.nextProjectId();
  s.putProject({
    id: projectId, name: "x", path: "/x", status: "active",
    createdAt: "2026-06-09T00:00:00Z",
  });
  const m = s.ensureUnscopedMilestone(projectId);
  const f = s.getFeature(m.featureId);
  assert.ok(f);
  assert.equal(f!.name, "unscoped");
});

// ---- about + sequenceAfter persist through roundtrip ----------------------

test("about + sequenceAfter persist through put/get", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  const m: Milestone = {
    id: "M-01", featureId, name: "x", state: "going",
    about: "one-liner background",
    sequenceAfter: ["M-99", "M-100"],
    startedAt: "2026-06-09T00:00:00Z",
  };
  s.putMilestone(m);
  const got = s.getMilestone("M-01")!;
  assert.equal(got.about, "one-liner background");
  assert.deepEqual(got.sequenceAfter, ["M-99", "M-100"]);
});

// ---- Sessions × milestones -------------------------------------------------

test("sessionsInMilestone returns sessions FK-bound to this milestone", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  s.putMilestone(mkMilestone(featureId, "M-01", "a"));
  s.putMilestone(mkMilestone(featureId, "M-02", "b"));
  s.putSession({ id: "ses-1", milestoneId: "M-01", source: "manual", startedAt: "2026-06-09T01:00:00Z" });
  s.putSession({ id: "ses-2", milestoneId: "M-02", source: "manual", startedAt: "2026-06-09T02:00:00Z" });
  assert.equal(s.sessionsInMilestone("M-01").length, 1);
  assert.equal(s.sessionsInMilestone("M-02").length, 1);
});

test("latestSessionInMilestone returns most recent by startedAt", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  s.putMilestone(mkMilestone(featureId, "M-01", "x"));
  s.putSession({ id: "ses-a", milestoneId: "M-01", source: "manual", startedAt: "2026-06-09T01:00:00Z" });
  s.putSession({ id: "ses-b", milestoneId: "M-01", source: "manual", startedAt: "2026-06-09T03:00:00Z" });
  s.putSession({ id: "ses-c", milestoneId: "M-01", source: "manual", startedAt: "2026-06-09T02:00:00Z" });
  assert.equal(s.latestSessionInMilestone("M-01")!.id, "ses-b");
});

// ---- Decisions × milestones ------------------------------------------------

test("decisionsInMilestone follows milestone_id column", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  s.putMilestone(mkMilestone(featureId, "M-01", "x"));
  s.putDecision({
    id: "M-01/D-01", milestoneId: "M-01", type: "decision",
    title: "d1",
    raisedBy: { trigger: "t", actor: "a", layer: "personal", at: "2026-06-09T00:00:00Z" },
    detail: { options: [] },
    affects: [], createdAt: "2026-06-09T00:00:00Z",
  });
  s.putDecision({
    id: "M-01/D-02", milestoneId: "M-01", type: "decision",
    title: "d2",
    raisedBy: { trigger: "t", actor: "a", layer: "personal", at: "2026-06-09T00:00:00Z" },
    detail: { options: [] },
    affects: [], createdAt: "2026-06-09T00:00:00Z",
  });
  assert.equal(s.decisionsInMilestone("M-01").length, 2);
});

test("nextLocalDecisionId scoped to milestone+type, picks D/DEF/OQ prefix", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  s.putMilestone(mkMilestone(featureId, "M-01", "x"));
  assert.equal(s.nextLocalDecisionId("M-01", "decision"), "M-01/D-01");
  assert.equal(s.nextLocalDecisionId("M-01", "deferred"), "M-01/DEF-01");
  assert.equal(s.nextLocalDecisionId("M-01", "open"), "M-01/OQ-01");
  s.putDecision({
    id: "M-01/D-01", milestoneId: "M-01", type: "decision",
    title: "d",
    raisedBy: { trigger: "t", actor: "a", layer: "personal", at: "2026-06-09T00:00:00Z" },
    detail: { options: [] },
    affects: [], createdAt: "2026-06-09T00:00:00Z",
  });
  assert.equal(s.nextLocalDecisionId("M-01", "decision"), "M-01/D-02");
});
