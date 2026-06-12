// Tests for features in the 0.3.0 store. Covers the 5-state enum
// (draft/going/winding/done/paused), project FK, about, sequenceAfter,
// and the per-feature helpers. (0.3.0 collapsed the umbrella Feature →
// Milestone layering: Features now hang directly off Project.)
import { test } from "node:test";
import assert from "node:assert/strict";

import { Store } from "./store.ts";
import type { Decision, Feature } from "./types.ts";

function bootProject(s: Store): { projectId: string } {
  const projectId = s.nextProjectId();
  s.putProject({
    id: projectId, name: "test", path: "/test", status: "active",
    createdAt: "2026-06-09T00:00:00Z",
  });
  return { projectId };
}

function mkFeature(
  projectId: string,
  id: string,
  name: string,
  state: Feature["state"] = "draft",
): Feature {
  return { id, projectId, name, state, startedAt: "2026-06-09T00:00:00Z" };
}

// ---- CRUD ------------------------------------------------------------------

test("putFeature + getFeature roundtrips", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  s.putFeature(mkFeature(projectId, "F-01", "first", "going"));
  const m = s.getFeature("F-01");
  assert.ok(m);
  assert.equal(m!.name, "first");
  assert.equal(m!.state, "going");
});

test("putFeature twice = upsert", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  s.putFeature(mkFeature(projectId, "F-01", "first", "draft"));
  s.putFeature(mkFeature(projectId, "F-01", "first-renamed", "going"));
  const m = s.getFeature("F-01")!;
  assert.equal(m.name, "first-renamed");
  assert.equal(m.state, "going");
});

test("getFeature returns null for missing id", () => {
  const s = new Store(":memory:");
  assert.equal(s.getFeature("NOPE"), null);
});

// ---- 5-state enum ----------------------------------------------------------

test("byFeatureState filters across all 5 states", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  for (const [id, state] of [
    ["F-01", "draft"], ["F-02", "going"], ["F-03", "winding"],
    ["F-04", "done"], ["F-05", "paused"],
  ] as const) {
    s.putFeature(mkFeature(projectId, id, id, state));
  }
  assert.equal(s.byFeatureState("draft").length, 1);
  assert.equal(s.byFeatureState("going").length, 1);
  assert.equal(s.byFeatureState("winding").length, 1);
  assert.equal(s.byFeatureState("done").length, 1);
  assert.equal(s.byFeatureState("paused").length, 1);
});

test("setFeatureState transitions and stamps completedAt on done", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  s.putFeature(mkFeature(projectId, "F-01", "x", "going"));
  s.setFeatureState("F-01", "winding");
  assert.equal(s.getFeature("F-01")!.state, "winding");
  assert.equal(s.getFeature("F-01")!.completedAt, undefined);
  s.setFeatureState("F-01", "done");
  const m = s.getFeature("F-01")!;
  assert.equal(m.state, "done");
  assert.ok(m.completedAt);
});

test("setFeatureState throws for missing feature", () => {
  const s = new Store(":memory:");
  assert.throws(() => s.setFeatureState("NOPE", "going"));
});

// ---- nextFeatureId -------------------------------------------------------

test("nextFeatureId starts at F-01", () => {
  const s = new Store(":memory:");
  bootProject(s);
  assert.equal(s.nextFeatureId(), "F-01");
});

test("nextFeatureId honors existing sequence", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  s.putFeature(mkFeature(projectId, "F-01", "a"));
  s.putFeature(mkFeature(projectId, "F-03", "c"));
  assert.equal(s.nextFeatureId(), "F-04");
});

// ---- featuresInProject ---------------------------------------------------

test("featuresInProject groups by project", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  const otherProjectId = s.nextProjectId();
  s.putProject({
    id: otherProjectId, name: "other", path: "/other", status: "active",
    createdAt: "2026-06-09T00:00:00Z",
  });
  s.putFeature(mkFeature(projectId, "F-01", "a"));
  s.putFeature(mkFeature(projectId, "F-02", "b"));
  s.putFeature(mkFeature(otherProjectId, "F-03", "c"));
  assert.equal(s.featuresInProject(projectId).length, 2);
  assert.equal(s.featuresInProject(otherProjectId).length, 1);
});

// ---- ensureUnscopedFeature is idempotent ---------------------------------

test("ensureUnscopedFeature creates once, returns existing thereafter", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  const m1 = s.ensureUnscopedFeature(projectId);
  const m2 = s.ensureUnscopedFeature(projectId);
  assert.equal(m1.id, m2.id);
  assert.equal(s.allFeatures().filter((m) => m.id === m1.id).length, 1);
});

test("ensureUnscopedFeature hangs the feature off the project", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  const m = s.ensureUnscopedFeature(projectId);
  assert.equal(m.projectId, projectId);
  assert.equal(m.name, "unscoped");
  assert.equal(m.state, "going");
});

// ---- about + sequenceAfter persist through roundtrip ----------------------

test("about + sequenceAfter persist through put/get", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  const m: Feature = {
    id: "F-01", projectId, name: "x", state: "going",
    about: "one-liner background",
    sequenceAfter: ["F-99", "F-100"],
    startedAt: "2026-06-09T00:00:00Z",
  };
  s.putFeature(m);
  const got = s.getFeature("F-01")!;
  assert.equal(got.about, "one-liner background");
  assert.deepEqual(got.sequenceAfter, ["F-99", "F-100"]);
});

// ---- Sessions × features -------------------------------------------------

test("sessionsInFeature returns sessions FK-bound to this feature", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  s.putFeature(mkFeature(projectId, "F-01", "a"));
  s.putFeature(mkFeature(projectId, "F-02", "b"));
  s.putSession({ id: "ses-1", featureId: "F-01", source: "manual", startedAt: "2026-06-09T01:00:00Z" });
  s.putSession({ id: "ses-2", featureId: "F-02", source: "manual", startedAt: "2026-06-09T02:00:00Z" });
  assert.equal(s.sessionsInFeature("F-01").length, 1);
  assert.equal(s.sessionsInFeature("F-02").length, 1);
});

test("latestSessionInFeature returns most recent by startedAt", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  s.putFeature(mkFeature(projectId, "F-01", "x"));
  s.putSession({ id: "ses-a", featureId: "F-01", source: "manual", startedAt: "2026-06-09T01:00:00Z" });
  s.putSession({ id: "ses-b", featureId: "F-01", source: "manual", startedAt: "2026-06-09T03:00:00Z" });
  s.putSession({ id: "ses-c", featureId: "F-01", source: "manual", startedAt: "2026-06-09T02:00:00Z" });
  assert.equal(s.latestSessionInFeature("F-01")!.id, "ses-b");
});

// ---- Decisions × features ------------------------------------------------

test("decisionsInFeature follows feature_id column", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  s.putFeature(mkFeature(projectId, "F-01", "x"));
  s.putDecision({
    id: "F-01/D-01", featureId: "F-01", type: "decision",
    title: "d1",
    raisedBy: { trigger: "t", actor: "a", layer: "personal", at: "2026-06-09T00:00:00Z" },
    detail: { options: [] },
    affects: [], createdAt: "2026-06-09T00:00:00Z",
  });
  s.putDecision({
    id: "F-01/D-02", featureId: "F-01", type: "decision",
    title: "d2",
    raisedBy: { trigger: "t", actor: "a", layer: "personal", at: "2026-06-09T00:00:00Z" },
    detail: { options: [] },
    affects: [], createdAt: "2026-06-09T00:00:00Z",
  });
  assert.equal(s.decisionsInFeature("F-01").length, 2);
});

test("nextLocalDecisionId scoped to feature+type, picks D/DEF/OQ prefix", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  s.putFeature(mkFeature(projectId, "F-01", "x"));
  assert.equal(s.nextLocalDecisionId("F-01", "decision"), "F-01/D-01");
  assert.equal(s.nextLocalDecisionId("F-01", "deferred"), "F-01/DEF-01");
  assert.equal(s.nextLocalDecisionId("F-01", "open"), "F-01/OQ-01");
  s.putDecision({
    id: "F-01/D-01", featureId: "F-01", type: "decision",
    title: "d",
    raisedBy: { trigger: "t", actor: "a", layer: "personal", at: "2026-06-09T00:00:00Z" },
    detail: { options: [] },
    affects: [], createdAt: "2026-06-09T00:00:00Z",
  });
  assert.equal(s.nextLocalDecisionId("F-01", "decision"), "F-01/D-02");
});

// ---- markFeatureComplete ---------------------------------------------------

function mkDec(
  featureId: string,
  id: string,
  type: "decision" | "deferred" | "open",
  status?: "open" | "resolved",
): Decision {
  return {
    id, featureId, type, status,
    title: id,
    raisedBy: { trigger: "t", actor: "a", layer: "personal", at: "2026-06-09T00:00:00Z" },
    affects: [],
    detail: type === "decision" ? { options: [] } : undefined,
    createdAt: "2026-06-09T00:00:00Z",
  };
}

test("markFeatureComplete closes open/deferred loops + sets done", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  s.putFeature(mkFeature(projectId, "F-01", "feat", "going"));
  s.putDecision(mkDec("F-01", "F-01/D-01", "decision"));
  s.putDecision(mkDec("F-01", "F-01/DEF-01", "deferred", "open"));
  s.putDecision(mkDec("F-01", "F-01/OQ-01", "open", "open"));

  const { closed } = s.markFeatureComplete("F-01", { by: "test", reason: "shipped" });
  assert.deepEqual([...closed].sort(), ["F-01/DEF-01", "F-01/OQ-01"]);

  const f = s.getFeature("F-01")!;
  assert.equal(f.state, "done");
  assert.ok(f.completedAt);

  for (const id of ["F-01/DEF-01", "F-01/OQ-01"]) {
    const d = s.getDecision(id)!;
    assert.equal(d.status, "resolved");
    assert.ok(d.closedManually);
    assert.equal(d.closedManually!.by, "test");
    assert.equal(d.closedManually!.reason, "shipped");
    assert.ok(d.closedManually!.at);
    assert.equal(d.resolvedBy, undefined); // hand-close has no resolver
  }

  const dec = s.getDecision("F-01/D-01")!; // the decided one is untouched
  assert.equal(dec.status, undefined);
  assert.equal(dec.closedManually, undefined);
});

test("markFeatureComplete is idempotent + throws on unknown feature", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  s.putFeature(mkFeature(projectId, "F-01", "feat", "going"));
  s.putDecision(mkDec("F-01", "F-01/OQ-01", "open", "open"));
  s.markFeatureComplete("F-01");
  assert.deepEqual(s.markFeatureComplete("F-01").closed, []); // second run closes nothing
  assert.equal(s.getFeature("F-01")!.state, "done");
  assert.throws(() => s.markFeatureComplete("NOPE"), /no such feature/);
});
