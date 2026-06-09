// Tests for src/projections.ts (0.1.0). resumeDigest, trace, traceEntity,
// nodeState, milestoneSummary, projectRollup, continueLast.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Store } from "./store.ts";
import {
  continueLast,
  milestoneSummary,
  nodeState,
  projectRollup,
  resumeDigest,
  trace,
  traceEntity,
} from "./projections.ts";
import { stubResolver } from "./resolver.ts";
import type { Decision } from "./types.ts";

const AT = "2026-06-09T00:00:00Z";

function bootProject(s: Store): { projectId: string; featureId: string; milestoneId: string } {
  const projectId = s.nextProjectId();
  s.putProject({ id: projectId, name: "x", path: "/x", status: "active", createdAt: AT });
  const f = s.ensureUnscopedFeature(projectId);
  const m = s.ensureUnscopedMilestone(projectId);
  return { projectId, featureId: f.id, milestoneId: m.id };
}

function mkOpen(milestoneId: string, id: string, title: string, trigger?: string, affects: { kind: string; id: string }[] = []): Decision {
  return {
    id: `${milestoneId}/${id}`, milestoneId, type: "open", status: "open",
    title,
    raisedBy: { trigger: "t", actor: "a", layer: "personal", at: AT },
    detail: trigger ? { trigger } : undefined,
    affects, createdAt: AT,
  };
}

function mkDecided(milestoneId: string, id: string, title: string, affects: { kind: string; id: string }[] = []): Decision {
  return {
    id: `${milestoneId}/${id}`, milestoneId, type: "decision",
    title,
    raisedBy: { trigger: "t", actor: "a", layer: "personal", at: AT },
    detail: { options: [{ name: "A", verdict: "chosen", chosen: true }] },
    affects, createdAt: AT,
  };
}

function mkDeferred(milestoneId: string, id: string, title: string, triggerKind: "manual" | "metric" = "manual"): Decision {
  return {
    id: `${milestoneId}/${id}`, milestoneId, type: "deferred", status: "open",
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
  const { milestoneId } = bootProject(s);
  const d = mkDecided(milestoneId, "D-01", "x");
  assert.equal(nodeState(d), "decided");
});

test("nodeState · type=decision with supersededBy → 'superseded'", () => {
  const s = new Store(":memory:");
  const { milestoneId } = bootProject(s);
  const d: Decision = { ...mkDecided(milestoneId, "D-01", "x"), supersededBy: `${milestoneId}/D-99` };
  assert.equal(nodeState(d), "superseded");
});

test("nodeState · type=deferred + status=open → 'deferred'", () => {
  const s = new Store(":memory:");
  const { milestoneId } = bootProject(s);
  assert.equal(nodeState(mkDeferred(milestoneId, "DEF-01", "x")), "deferred");
});

test("nodeState · status=resolved overrides type", () => {
  const s = new Store(":memory:");
  const { milestoneId } = bootProject(s);
  const d: Decision = { ...mkDeferred(milestoneId, "DEF-01", "x"), status: "resolved", resolvedBy: `${milestoneId}/D-99` };
  assert.equal(nodeState(d), "resolved");
});

// ---- resumeDigest ----------------------------------------------------------

test("resumeDigest · returns open + un-resolved deferred", () => {
  const s = new Store(":memory:");
  const { milestoneId } = bootProject(s);
  s.putDecision(mkOpen(milestoneId, "OQ-01", "first"));
  s.putDecision(mkOpen(milestoneId, "OQ-02", "second"));
  s.putDecision(mkDeferred(milestoneId, "DEF-01", "later"));
  s.putDecision(mkDecided(milestoneId, "D-01", "done already"));
  const items = resumeDigest(s);
  const buckets = items.map((i) => i.bucket).sort();
  assert.equal(items.length, 3);
  assert.deepEqual(buckets, ["deferred", "open", "open"]);
});

test("resumeDigest · skips status=resolved deferred", () => {
  const s = new Store(":memory:");
  const { milestoneId } = bootProject(s);
  const d = mkDeferred(milestoneId, "DEF-01", "later");
  d.status = "resolved";
  d.resolvedBy = `${milestoneId}/D-99`;
  s.putDecision(d);
  assert.equal(resumeDigest(s).length, 0);
});

test("resumeDigest · skips items resolved via incoming 'resolves' edge", () => {
  const s = new Store(":memory:");
  const { milestoneId } = bootProject(s);
  s.putDecision(mkDecided(milestoneId, "D-01", "later answer"));
  s.putDecision(mkDeferred(milestoneId, "DEF-01", "the original q"));
  s.addEdge({ from: `${milestoneId}/D-01`, to: `${milestoneId}/DEF-01`, relation: "resolves" });
  assert.equal(resumeDigest(s).length, 0);
});

test("resumeDigest · 'metric' trigger flags needsCheck=true", () => {
  const s = new Store(":memory:");
  const { milestoneId } = bootProject(s);
  s.putDecision(mkDeferred(milestoneId, "DEF-01", "wait for X", "metric"));
  s.putDecision(mkDeferred(milestoneId, "DEF-02", "manual review", "manual"));
  const items = resumeDigest(s);
  const metric = items.find((i) => i.id === `${milestoneId}/DEF-01`);
  const manual = items.find((i) => i.id === `${milestoneId}/DEF-02`);
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
  const { milestoneId } = bootProject(s);
  s.putDecision(mkDecided(milestoneId, "D-01", "x"));
  const t = await trace(s, `${milestoneId}/D-01`, stubResolver);
  assert.ok(t!.statusLine.startsWith("DECIDED"));
});

test("trace · shows incoming + outgoing edges with relation field", async () => {
  const s = new Store(":memory:");
  const { milestoneId } = bootProject(s);
  s.putDecision(mkDecided(milestoneId, "D-01", "answer"));
  s.putDecision(mkOpen(milestoneId, "OQ-01", "question"));
  s.addEdge({ from: `${milestoneId}/D-01`, to: `${milestoneId}/OQ-01`, relation: "resolves" });
  const t = await trace(s, `${milestoneId}/D-01`, stubResolver);
  assert.equal(t!.edges.length, 1);
  assert.equal(t!.edges[0].relation, "resolves");
  assert.equal(t!.edges[0].direction, "out");
});

// ---- traceEntity -----------------------------------------------------------

test("traceEntity · returns every decision that affects the ref", async () => {
  const s = new Store(":memory:");
  const { milestoneId } = bootProject(s);
  s.putDecision(mkDecided(milestoneId, "D-01", "x", [{ kind: "file", id: "a.ts" }]));
  s.putDecision(mkDecided(milestoneId, "D-02", "y", [{ kind: "file", id: "a.ts" }]));
  s.putDecision(mkDecided(milestoneId, "D-03", "z", [{ kind: "file", id: "b.ts" }]));
  const traces = await traceEntity(s, { kind: "file", id: "a.ts" }, stubResolver);
  assert.equal(traces.length, 2);
});

// ---- milestoneSummary -------------------------------------------------------

test("milestoneSummary · sorts going first then winding", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  s.putMilestone({ id: "M-a", featureId, name: "winding-one", state: "winding", startedAt: "2026-06-09T01:00:00Z" });
  s.putMilestone({ id: "M-b", featureId, name: "going-one", state: "going", startedAt: "2026-06-09T01:00:00Z" });
  s.putMilestone({ id: "M-c", featureId, name: "done-one", state: "done", startedAt: "2026-06-09T01:00:00Z" });
  const sorted = milestoneSummary(s).map((m) => m.milestone.state);
  // going first, then winding, then done (with unscoped as 'going' at the top)
  assert.ok(sorted.indexOf("going") < sorted.indexOf("winding"));
  assert.ok(sorted.indexOf("winding") < sorted.indexOf("done"));
});

test("milestoneSummary · openLoops counts open + un-resolved deferred", () => {
  const s = new Store(":memory:");
  const { milestoneId } = bootProject(s);
  s.putDecision(mkOpen(milestoneId, "OQ-01", "q1"));
  s.putDecision(mkDeferred(milestoneId, "DEF-01", "q2"));
  s.putDecision(mkDecided(milestoneId, "D-01", "ans"));
  const row = milestoneSummary(s).find((m) => m.milestone.id === milestoneId)!;
  assert.equal(row.openLoops, 2);
});

// ---- projectRollup ---------------------------------------------------------

test("projectRollup · aggregates per-state milestone counts + open loops", () => {
  const s = new Store(":memory:");
  const { projectId, featureId } = bootProject(s);
  // unscoped milestone is state='going' from boot
  s.putMilestone({ id: "M-2", featureId, name: "x", state: "winding", startedAt: AT });
  s.putMilestone({ id: "M-3", featureId, name: "y", state: "done", startedAt: AT });
  const r = projectRollup(s, projectId);
  assert.ok(r);
  assert.equal(r!.milestoneCount, 3);
  assert.equal(r!.milestonesByState.going, 1);
  assert.equal(r!.milestonesByState.winding, 1);
  assert.equal(r!.milestonesByState.done, 1);
});

// ---- continueLast ----------------------------------------------------------

test("continueLast · returns null when no sessions exist", () => {
  const s = new Store(":memory:");
  bootProject(s);
  assert.equal(continueLast(s), null);
});

test("continueLast · returns the most recent session + its milestone", () => {
  const s = new Store(":memory:");
  const { milestoneId } = bootProject(s);
  s.putSession({
    id: "ses-1", milestoneId, source: "claude-code", sourceSessionId: "xyz",
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
