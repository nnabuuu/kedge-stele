// Tests for src/projections.ts (0.1.0). resumeDigest, trace, traceEntity,
// nodeState, featureSummary, projectRollup, continueLast.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Store } from "./store.ts";
import {
  continueLast,
  featureSummary,
  nodeState,
  projectRollup,
  resumeDigest,
  trace,
  traceEntity,
} from "./projections.ts";
import { stubResolver } from "./resolver.ts";
import type { Decision } from "./types.ts";

const AT = "2026-06-09T00:00:00Z";

function bootProject(s: Store): { projectId: string; featureId: string } {
  const projectId = s.nextProjectId();
  s.putProject({ id: projectId, name: "x", path: "/x", status: "active", createdAt: AT });
  const f = s.ensureUnscopedFeature(projectId);
  return { projectId, featureId: f.id };
}

function mkOpen(featureId: string, id: string, title: string, trigger?: string, affects: { kind: string; id: string }[] = []): Decision {
  return {
    id: `${featureId}/${id}`, featureId, type: "open", status: "open",
    title,
    raisedBy: { trigger: "t", actor: "a", layer: "personal", at: AT },
    detail: trigger ? { trigger } : undefined,
    affects, createdAt: AT,
  };
}

function mkDecided(featureId: string, id: string, title: string, affects: { kind: string; id: string }[] = []): Decision {
  return {
    id: `${featureId}/${id}`, featureId, type: "decision",
    title,
    raisedBy: { trigger: "t", actor: "a", layer: "personal", at: AT },
    detail: { options: [{ name: "A", verdict: "chosen", chosen: true }] },
    affects, createdAt: AT,
  };
}

function mkDeferred(featureId: string, id: string, title: string, triggerKind: "manual" | "metric" = "manual"): Decision {
  return {
    id: `${featureId}/${id}`, featureId, type: "deferred", status: "open",
    title,
    raisedBy: { trigger: "t", actor: "a", layer: "personal", at: AT },
    revisit: { trigger: triggerKind === "manual" ? { kind: "manual" } : { kind: "metric", expr: "x>5" } },
    detail: { trigger: "deferred-prose" },
    affects: [], createdAt: AT,
  };
}

// ---- nodeState -------------------------------------------------------------

test("nodeState · type=decision → 'decided' (no supersededBy)", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  const d = mkDecided(featureId, "D-01", "x");
  assert.equal(nodeState(d), "decided");
});

test("nodeState · type=decision with supersededBy → 'superseded'", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  const d: Decision = { ...mkDecided(featureId, "D-01", "x"), supersededBy: `${featureId}/D-99` };
  assert.equal(nodeState(d), "superseded");
});

test("nodeState · type=deferred + status=open → 'deferred'", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  assert.equal(nodeState(mkDeferred(featureId, "DEF-01", "x")), "deferred");
});

test("nodeState · status=resolved overrides type", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  const d: Decision = { ...mkDeferred(featureId, "DEF-01", "x"), status: "resolved", resolvedBy: `${featureId}/D-99` };
  assert.equal(nodeState(d), "resolved");
});

// ---- resumeDigest ----------------------------------------------------------

test("resumeDigest · returns open + un-resolved deferred", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  s.putDecision(mkOpen(featureId, "OQ-01", "first"));
  s.putDecision(mkOpen(featureId, "OQ-02", "second"));
  s.putDecision(mkDeferred(featureId, "DEF-01", "later"));
  s.putDecision(mkDecided(featureId, "D-01", "done already"));
  const items = resumeDigest(s);
  const buckets = items.map((i) => i.bucket).sort();
  assert.equal(items.length, 3);
  assert.deepEqual(buckets, ["deferred", "open", "open"]);
});

test("resumeDigest · skips status=resolved deferred", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  const d = mkDeferred(featureId, "DEF-01", "later");
  d.status = "resolved";
  d.resolvedBy = `${featureId}/D-99`;
  s.putDecision(d);
  assert.equal(resumeDigest(s).length, 0);
});

test("resumeDigest · skips items resolved via incoming 'resolves' edge", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  s.putDecision(mkDecided(featureId, "D-01", "later answer"));
  s.putDecision(mkDeferred(featureId, "DEF-01", "the original q"));
  s.addEdge({ from: `${featureId}/D-01`, to: `${featureId}/DEF-01`, relation: "resolves" });
  assert.equal(resumeDigest(s).length, 0);
});

test("resumeDigest · 'metric' trigger flags needsCheck=true", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  s.putDecision(mkDeferred(featureId, "DEF-01", "wait for X", "metric"));
  s.putDecision(mkDeferred(featureId, "DEF-02", "manual review", "manual"));
  const items = resumeDigest(s);
  const metric = items.find((i) => i.id === `${featureId}/DEF-01`);
  const manual = items.find((i) => i.id === `${featureId}/DEF-02`);
  assert.equal(metric!.needsCheck, true);
  assert.equal(manual!.needsCheck, false);
});

// ---- trace -----------------------------------------------------------------

test("trace · returns null for unknown id", async () => {
  const s = new Store(":memory:");
  bootProject(s);
  const t = await trace(s, "NOPE", stubResolver);
  assert.equal(t, null);
});

test("trace · statusLine reflects nodeState", async () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  s.putDecision(mkDecided(featureId, "D-01", "x"));
  const t = await trace(s, `${featureId}/D-01`, stubResolver);
  assert.ok(t!.statusLine.startsWith("DECIDED"));
});

test("trace · shows incoming + outgoing edges with relation field", async () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  s.putDecision(mkDecided(featureId, "D-01", "answer"));
  s.putDecision(mkOpen(featureId, "OQ-01", "question"));
  s.addEdge({ from: `${featureId}/D-01`, to: `${featureId}/OQ-01`, relation: "resolves" });
  const t = await trace(s, `${featureId}/D-01`, stubResolver);
  assert.equal(t!.edges.length, 1);
  assert.equal(t!.edges[0].relation, "resolves");
  assert.equal(t!.edges[0].direction, "out");
});

// ---- traceEntity -----------------------------------------------------------

test("traceEntity · returns every decision that affects the ref", async () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  s.putDecision(mkDecided(featureId, "D-01", "x", [{ kind: "file", id: "a.ts" }]));
  s.putDecision(mkDecided(featureId, "D-02", "y", [{ kind: "file", id: "a.ts" }]));
  s.putDecision(mkDecided(featureId, "D-03", "z", [{ kind: "file", id: "b.ts" }]));
  const traces = await traceEntity(s, { kind: "file", id: "a.ts" }, stubResolver);
  assert.equal(traces.length, 2);
});

// ---- featureSummary -------------------------------------------------------

test("featureSummary · sorts going first then winding", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  s.putFeature({ id: "F-a", projectId, name: "winding-one", state: "winding", startedAt: "2026-06-09T01:00:00Z" });
  s.putFeature({ id: "F-b", projectId, name: "going-one", state: "going", startedAt: "2026-06-09T01:00:00Z" });
  s.putFeature({ id: "F-c", projectId, name: "done-one", state: "done", startedAt: "2026-06-09T01:00:00Z" });
  const sorted = featureSummary(s).map((m) => m.feature.state);
  // going first, then winding, then done (with unscoped as 'going' at the top)
  assert.ok(sorted.indexOf("going") < sorted.indexOf("winding"));
  assert.ok(sorted.indexOf("winding") < sorted.indexOf("done"));
});

test("featureSummary · openLoops counts open + un-resolved deferred", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  s.putDecision(mkOpen(featureId, "OQ-01", "q1"));
  s.putDecision(mkDeferred(featureId, "DEF-01", "q2"));
  s.putDecision(mkDecided(featureId, "D-01", "ans"));
  const row = featureSummary(s).find((m) => m.feature.id === featureId)!;
  assert.equal(row.openLoops, 2);
});

// ---- projectRollup ---------------------------------------------------------

test("projectRollup · aggregates per-state feature counts + open loops", () => {
  const s = new Store(":memory:");
  const { projectId } = bootProject(s);
  // unscoped feature is state='going' from boot
  s.putFeature({ id: "F-2", projectId, name: "x", state: "winding", startedAt: AT });
  s.putFeature({ id: "F-3", projectId, name: "y", state: "done", startedAt: AT });
  const r = projectRollup(s, projectId);
  assert.ok(r);
  assert.equal(r!.featureCount, 3);
  assert.equal(r!.featuresByState.going, 1);
  assert.equal(r!.featuresByState.winding, 1);
  assert.equal(r!.featuresByState.done, 1);
});

// ---- continueLast ----------------------------------------------------------

test("continueLast · returns null when no sessions exist", () => {
  const s = new Store(":memory:");
  bootProject(s);
  assert.equal(continueLast(s), null);
});

test("continueLast · returns the most recent session + its feature", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  s.putSession({
    id: "ses-1", featureId, source: "claude-code", sourceSessionId: "xyz",
    startedAt: "2026-06-09T05:00:00Z",
    outcome: { type: "advanced", summary: "got far" },
    pauseReason: { kind: "out_of_time" },
  });
  const r = continueLast(s);
  assert.ok(r);
  assert.equal(r!.session.id, "ses-1");
  assert.equal(r!.lastOutcome!.summary, "got far");
  assert.equal(r!.lastPauseReason!.kind, "out_of_time");
});
