// Tests for src/consolidate.ts (0.1.0). proposeEdges runs on every capture
// and suggests edges to existing pending nodes via token-jaccard + shared-
// entity boost.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Store } from "./store.ts";
import { proposeEdges } from "./consolidate.ts";
import type { Decision } from "./types.ts";

function bootProject(s: Store): { projectId: string; featureId: string; featureId: string } {
  const projectId = s.nextProjectId();
  s.putProject({
    id: projectId, name: "test", path: "/test", status: "active",
    createdAt: "2026-06-09T00:00:00Z",
  });
  const f = s.ensureUnscopedFeature(projectId);
  const m = s.ensureUnscopedFeature(projectId);
  return { projectId, featureId: f.id, featureId: m.id };
}

function mkDecided(featureId: string, id: string, title: string, affects: { kind: string; id: string }[] = []): Decision {
  return {
    id: `${featureId}/${id}`,
    featureId,
    type: "decision",
    title,
    raisedBy: { trigger: "t", actor: "a", layer: "personal", at: "2026-06-09T00:00:00Z" },
    detail: { options: [{ name: "A", verdict: "chosen", chosen: true }] },
    affects,
    createdAt: "2026-06-09T00:00:00Z",
  };
}

function mkOpen(featureId: string, id: string, title: string, trigger?: string, affects: { kind: string; id: string }[] = []): Decision {
  return {
    id: `${featureId}/${id}`,
    featureId,
    type: "open",
    status: "open",
    title,
    raisedBy: { trigger: "t", actor: "a", layer: "personal", at: "2026-06-09T00:00:00Z" },
    detail: trigger ? { trigger } : undefined,
    affects,
    createdAt: "2026-06-09T00:00:00Z",
  };
}

function mkDeferred(featureId: string, id: string, title: string, trigger: string): Decision {
  return {
    id: `${featureId}/${id}`,
    featureId,
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
  const { featureId } = bootProject(s);
  const incoming = mkDecided(featureId, "D-01", "anything");
  assert.deepEqual(proposeEdges(s, incoming), []);
});

test("proposeEdges · skips itself (already stored)", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  const d = mkOpen(featureId, "OQ-01", "self-referential question");
  s.putDecision(d);
  const out = proposeEdges(s, d);
  assert.equal(out.length, 0);
});

// ---- token overlap drives proposal -----------------------------------------

test("proposeEdges · strong title overlap → proposes resolves edge", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  s.putDecision(mkOpen(featureId, "OQ-01", "should we use sqlite for storage backend"));
  const incoming = mkDecided(featureId, "D-02", "decided to use sqlite for storage backend");
  const out = proposeEdges(s, incoming);
  assert.ok(out.length >= 1);
  assert.equal(out[0].edge.relation, "resolves");
});

test("proposeEdges · low title overlap with no shared entity → skipped", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  s.putDecision(mkOpen(featureId, "OQ-01", "completely unrelated frontend question"));
  const incoming = mkDecided(featureId, "D-02", "backend something entirely different");
  const out = proposeEdges(s, incoming);
  assert.equal(out.length, 0);
});

// ---- entity overlap is a boost ---------------------------------------------

test("proposeEdges · shared entity raises low-overlap pairs above threshold", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  s.putDecision(mkOpen(featureId, "OQ-01", "renderer concerns", undefined, [
    { kind: "file", id: "src/render.ts" },
  ]));
  const incoming = mkDecided(featureId, "D-02", "html output detail tweaks", [
    { kind: "file", id: "src/render.ts" },
  ]);
  const out = proposeEdges(s, incoming);
  assert.ok(out.length >= 1, "shared entity should be enough to propose");
});

// ---- deferred-decision reading uses detail.trigger -------------------------

test("proposeEdges · reads deferred's detail.trigger as part of the corpus", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  s.putDecision(mkDeferred(featureId, "DEF-01", "later", "we punted the migration tooling for now"));
  const incoming = mkDecided(featureId, "D-02", "migration tooling design");
  const out = proposeEdges(s, incoming);
  // The token "migration tooling" appears in both detail.trigger and incoming title.
  assert.ok(out.length >= 1);
});

// ---- never proposes depends_on (authored only) ----------------------------

test("proposeEdges · only emits 'resolves' or 'relates' (never depends_on)", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  s.putDecision(mkOpen(featureId, "OQ-01", "shared entity question", undefined, [{ kind: "file", id: "a.ts" }]));
  s.putDecision(mkOpen(featureId, "OQ-02", "another shared", undefined, [{ kind: "file", id: "a.ts" }]));
  const incoming = mkDecided(featureId, "D-03", "decided shared thing", [{ kind: "file", id: "a.ts" }]);
  const out = proposeEdges(s, incoming);
  for (const c of out) {
    assert.ok(c.edge.relation === "resolves" || c.edge.relation === "relates", `unexpected relation: ${c.edge.relation}`);
  }
});

// ---- resolved pending is filtered out -------------------------------------

test("proposeEdges · skips pending that are already status='resolved'", () => {
  const s = new Store(":memory:");
  const { featureId } = bootProject(s);
  s.putDecision({
    ...mkOpen(featureId, "OQ-01", "matching question"),
    status: "resolved",
    resolvedBy: `${featureId}/D-99`,
  });
  const incoming = mkDecided(featureId, "D-02", "matching question answered");
  const out = proposeEdges(s, incoming);
  assert.equal(out.length, 0);
});
