// Tests for src/consolidate.ts (0.1.0). proposeEdges runs on every capture
// and suggests edges to existing pending nodes via token-jaccard + shared-
// entity boost.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Store } from "./store.ts";
import { proposeEdges } from "./consolidate.ts";
import type { Decision } from "./types.ts";

function bootProject(s: Store): { projectId: string; featureId: string; milestoneId: string } {
  const projectId = s.nextProjectId();
  s.putProject({
    id: projectId, name: "test", path: "/test", status: "active",
    createdAt: "2026-06-09T00:00:00Z",
  });
  const f = s.ensureUnscopedFeature(projectId);
  const m = s.ensureUnscopedMilestone(projectId);
  return { projectId, featureId: f.id, milestoneId: m.id };
}

function mkDecided(milestoneId: string, id: string, title: string, affects: { kind: string; id: string }[] = []): Decision {
  return {
    id: `${milestoneId}/${id}`,
    milestoneId,
    type: "decision",
    title,
    raisedBy: { trigger: "t", actor: "a", layer: "personal", at: "2026-06-09T00:00:00Z" },
    detail: { options: [{ name: "A", verdict: "chosen", chosen: true }] },
    affects,
    createdAt: "2026-06-09T00:00:00Z",
  };
}

function mkOpen(milestoneId: string, id: string, title: string, trigger?: string, affects: { kind: string; id: string }[] = []): Decision {
  return {
    id: `${milestoneId}/${id}`,
    milestoneId,
    type: "open",
    status: "open",
    title,
    raisedBy: { trigger: "t", actor: "a", layer: "personal", at: "2026-06-09T00:00:00Z" },
    detail: trigger ? { trigger } : undefined,
    affects,
    createdAt: "2026-06-09T00:00:00Z",
  };
}

function mkDeferred(milestoneId: string, id: string, title: string, trigger: string): Decision {
  return {
    id: `${milestoneId}/${id}`,
    milestoneId,
    type: "deferred",
    status: "open",
    title,
    raisedBy: { trigger: "t", actor: "a", layer: "personal", at: "2026-06-09T00:00:00Z" },
    revisit: { trigger: { kind: "manual" } },
    detail: { trigger },
    affects: [],
    createdAt: "2026-06-09T00:00:00Z",
  };
}

// ---- baseline behaviour ----------------------------------------------------

test("proposeEdges · no pending nodes → empty", () => {
  const s = new Store(":memory:");
  const { milestoneId } = bootProject(s);
  const incoming = mkDecided(milestoneId, "D-01", "anything");
  assert.deepEqual(proposeEdges(s, incoming), []);
});

test("proposeEdges · skips itself (already stored)", () => {
  const s = new Store(":memory:");
  const { milestoneId } = bootProject(s);
  const d = mkOpen(milestoneId, "OQ-01", "self-referential question");
  s.putDecision(d);
  const out = proposeEdges(s, d);
  assert.equal(out.length, 0);
});

// ---- token overlap drives proposal -----------------------------------------

test("proposeEdges · strong title overlap → proposes resolves edge", () => {
  const s = new Store(":memory:");
  const { milestoneId } = bootProject(s);
  s.putDecision(mkOpen(milestoneId, "OQ-01", "should we use sqlite for storage backend"));
  const incoming = mkDecided(milestoneId, "D-02", "decided to use sqlite for storage backend");
  const out = proposeEdges(s, incoming);
  assert.ok(out.length >= 1);
  assert.equal(out[0].edge.relation, "resolves");
});

test("proposeEdges · low title overlap with no shared entity → skipped", () => {
  const s = new Store(":memory:");
  const { milestoneId } = bootProject(s);
  s.putDecision(mkOpen(milestoneId, "OQ-01", "completely unrelated frontend question"));
  const incoming = mkDecided(milestoneId, "D-02", "backend something entirely different");
  const out = proposeEdges(s, incoming);
  assert.equal(out.length, 0);
});

// ---- entity overlap is a boost ---------------------------------------------

test("proposeEdges · shared entity raises low-overlap pairs above threshold", () => {
  const s = new Store(":memory:");
  const { milestoneId } = bootProject(s);
  s.putDecision(mkOpen(milestoneId, "OQ-01", "renderer concerns", undefined, [
    { kind: "file", id: "src/render.ts" },
  ]));
  const incoming = mkDecided(milestoneId, "D-02", "html output detail tweaks", [
    { kind: "file", id: "src/render.ts" },
  ]);
  const out = proposeEdges(s, incoming);
  assert.ok(out.length >= 1, "shared entity should be enough to propose");
});

// ---- deferred-decision reading uses detail.trigger -------------------------

test("proposeEdges · reads deferred's detail.trigger as part of the corpus", () => {
  const s = new Store(":memory:");
  const { milestoneId } = bootProject(s);
  s.putDecision(mkDeferred(milestoneId, "DEF-01", "later", "we punted the migration tooling for now"));
  const incoming = mkDecided(milestoneId, "D-02", "migration tooling design");
  const out = proposeEdges(s, incoming);
  // The token "migration tooling" appears in both detail.trigger and incoming title.
  assert.ok(out.length >= 1);
});

// ---- never proposes depends_on (authored only) ----------------------------

test("proposeEdges · only emits 'resolves' or 'relates' (never depends_on)", () => {
  const s = new Store(":memory:");
  const { milestoneId } = bootProject(s);
  s.putDecision(mkOpen(milestoneId, "OQ-01", "shared entity question", undefined, [{ kind: "file", id: "a.ts" }]));
  s.putDecision(mkOpen(milestoneId, "OQ-02", "another shared", undefined, [{ kind: "file", id: "a.ts" }]));
  const incoming = mkDecided(milestoneId, "D-03", "decided shared thing", [{ kind: "file", id: "a.ts" }]);
  const out = proposeEdges(s, incoming);
  for (const c of out) {
    assert.ok(c.edge.relation === "resolves" || c.edge.relation === "relates", `unexpected relation: ${c.edge.relation}`);
  }
});

// ---- resolved pending is filtered out -------------------------------------

test("proposeEdges · skips pending that are already status='resolved'", () => {
  const s = new Store(":memory:");
  const { milestoneId } = bootProject(s);
  s.putDecision({
    ...mkOpen(milestoneId, "OQ-01", "matching question"),
    status: "resolved",
    resolvedBy: `${milestoneId}/D-99`,
  });
  const incoming = mkDecided(milestoneId, "D-02", "matching question answered");
  const out = proposeEdges(s, incoming);
  assert.equal(out.length, 0);
});
