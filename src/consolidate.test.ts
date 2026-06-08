// Tests for src/consolidate.ts — the proposeEdges heuristic that runs on
// every capture and suggests edges to existing pending nodes.
//
// The heuristic combines token-jaccard similarity + shared-entity boost.
// We're not testing exact numeric thresholds (those are tunable) — we test
// that the *direction* of behaviour is correct: similar pending nodes get
// proposed, dissimilar ones don't, and shared entity counts more than tokens.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Store } from "./store.ts";
import { proposeEdges } from "./consolidate.ts";
import type { Decision } from "./types.ts";

const baseRaisedBy = {
  trigger: "trigger text",
  actor: "tester",
  layer: "personal" as const,
  at: "2026-06-01T00:00:00Z",
};

function mkOpen(id: string, title: string, affects: { kind: string; id: string }[] = []): Decision {
  return {
    id, title,
    raisedBy: baseRaisedBy,
    status: { kind: "open", question: title },
    affects,
  };
}

function mkDeferred(id: string, title: string, reason: string, affects: { kind: string; id: string }[] = []): Decision {
  return {
    id, title,
    raisedBy: baseRaisedBy,
    status: { kind: "deferred", current: "x", reason, revisitWhen: { kind: "manual" } },
    affects,
  };
}

function mkDecided(id: string, title: string, affects: { kind: string; id: string }[] = []): Decision {
  return {
    id, title,
    raisedBy: baseRaisedBy,
    status: {
      kind: "decided",
      options: [{ label: "A", summary: "a", verdict: "chosen" }],
      rationale: "because",
    },
    affects,
  };
}

function freshStore(): Store {
  return new Store(":memory:");
}

// ---- Empty / trivial -----------------------------------------------------

test("proposeEdges returns [] on an empty store", () => {
  const s = freshStore();
  const incoming = mkDecided("D-NEW", "anything", []);
  assert.deepEqual(proposeEdges(s, incoming), []);
});

test("proposeEdges skips fully-decided nodes (only open + deferred are candidates)", () => {
  const s = freshStore();
  s.putDecision(mkDecided("D-OLD", "completely matching title here", []));
  const incoming = mkDecided("D-NEW", "completely matching title here", []);
  assert.deepEqual(
    proposeEdges(s, incoming),
    [],
    "matching DECIDED node should not be a candidate",
  );
});

test("proposeEdges skips already-resolved deferred nodes", () => {
  const s = freshStore();
  s.putDecision(mkDeferred("DEF-1", "the same exact topic", "reason"));
  // resolve it
  s.putDecision(mkDecided("D-1", "earlier resolver"));
  s.addEdge({ from: "D-1", to: "DEF-1", kind: "resolves" });

  const incoming = mkOpen("OQ-NEW", "the same exact topic");
  const proposals = proposeEdges(s, incoming);
  const targets = proposals.map((p) => p.edge.to);
  assert.ok(!targets.includes("DEF-1"), "resolved deferred should not be a candidate");
});

// ---- Title overlap → relates ---------------------------------------------

test("proposeEdges surfaces a pending node when the incoming shares words", () => {
  const s = freshStore();
  s.putDecision(mkOpen("OQ-1", "worktree isolation strategy per session", []));
  const incoming = mkDecided("D-NEW", "worktree isolation strategy per session", []);

  const proposals = proposeEdges(s, incoming);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].edge.to, "OQ-1");
  // Same-title overlap should be high enough to propose "resolves"
  assert.equal(proposals[0].edge.kind, "resolves");
});

test("proposeEdges returns no proposals when titles are unrelated and no shared entity", () => {
  const s = freshStore();
  s.putDecision(mkOpen("OQ-1", "database backup retention policy", []));
  const incoming = mkDecided("D-NEW", "color of the dashboard sidebar", []);

  const proposals = proposeEdges(s, incoming);
  assert.deepEqual(proposals, []);
});

// ---- Shared entity boost ------------------------------------------------

test("shared entity is enough to surface even when titles barely overlap", () => {
  const s = freshStore();
  // Use vocabularies with zero overlap (incl. baseRaisedBy.trigger words)
  s.putDecision(mkOpen("OQ-1", "blue car forest", [{ kind: "file", id: "src/foo.ts" }]));
  const incoming = mkDecided(
    "D-NEW",
    "red bicycle desert",
    [{ kind: "file", id: "src/foo.ts" }],
  );

  const proposals = proposeEdges(s, incoming);
  assert.equal(proposals.length, 1, "shared entity alone should yield a proposal");
  assert.equal(proposals[0].edge.to, "OQ-1");
  // Shared entity but no title overlap → relates, not resolves
  assert.equal(proposals[0].edge.kind, "relates");
});

test("shared entity counts more confidence than title overlap alone", () => {
  const s = freshStore();
  s.putDecision(mkOpen("OQ-WITH-ENTITY", "the topic at hand here", [{ kind: "file", id: "src/foo.ts" }]));
  s.putDecision(mkOpen("OQ-WITHOUT", "the topic at hand here", []));
  const incoming = mkDecided(
    "D-NEW",
    "the topic at hand here",
    [{ kind: "file", id: "src/foo.ts" }],
  );

  const proposals = proposeEdges(s, incoming);
  assert.equal(proposals.length, 2);
  // Both should appear; the one with the shared entity should be ranked higher
  const byId = new Map(proposals.map((p) => [p.edge.to, p]));
  const withEntity = byId.get("OQ-WITH-ENTITY")!;
  const without = byId.get("OQ-WITHOUT")!;
  assert.ok(
    withEntity.confidence > without.confidence,
    `shared-entity confidence (${withEntity.confidence}) should exceed title-only (${without.confidence})`,
  );
});

test("proposals are sorted by descending confidence", () => {
  const s = freshStore();
  s.putDecision(mkOpen("OQ-LOW", "barely related text here", [{ kind: "file", id: "x.ts" }]));
  s.putDecision(mkOpen("OQ-HIGH", "the exact same topic", [{ kind: "file", id: "x.ts" }]));
  const incoming = mkDecided("D-NEW", "the exact same topic", [{ kind: "file", id: "x.ts" }]);

  const proposals = proposeEdges(s, incoming);
  for (let i = 1; i < proposals.length; i++) {
    assert.ok(
      proposals[i - 1].confidence >= proposals[i].confidence,
      "proposals not sorted by descending confidence",
    );
  }
});

// ---- Edge payload shape -------------------------------------------------

test("each EdgeCandidate carries edge, confidence (0..1), and reason", () => {
  const s = freshStore();
  s.putDecision(mkOpen("OQ-1", "shared topic here", [{ kind: "file", id: "x.ts" }]));
  const incoming = mkDecided("D-NEW", "shared topic here", [{ kind: "file", id: "x.ts" }]);

  const [p] = proposeEdges(s, incoming);
  assert.ok(p);
  assert.equal(p.edge.from, "D-NEW");
  assert.equal(p.edge.to, "OQ-1");
  assert.ok(["resolves", "relates"].includes(p.edge.kind));
  assert.ok(p.confidence >= 0 && p.confidence <= 1);
  assert.equal(typeof p.reason, "string");
  assert.ok(p.reason.length > 0);
});

test("proposeEdges never proposes a self-edge", () => {
  const s = freshStore();
  // Edge case: incoming has same id as an existing pending node (shouldn't happen
  // in normal capture, but the function should defend against it).
  s.putDecision(mkOpen("D-NEW", "same title here", []));
  const incoming = mkDecided("D-NEW", "same title here", []);

  const proposals = proposeEdges(s, incoming);
  for (const p of proposals) {
    assert.notEqual(p.edge.from, p.edge.to, "self-edge proposed");
  }
});
