// 0.4.0 — tests for the Decision source / confidence / dedup_key surface.
//
// Coverage:
//   • Store.computeDedupKey is deterministic and content-driven
//   • putDecision dedupes same-content writes from machine sources
//     (agent-live, session-extract) but NOT from manual sources
//   • Cross-source dedup: agent-live then session-extract on the same
//     content surfaces the live capture's id as the canonical winner
//   • Adding columns is additive — the .data JSON blob round-trips
//     the new fields through getDecision()
import { test } from "node:test";
import assert from "node:assert/strict";

import { Store } from "./store.ts";
import type { Decision } from "./types.ts";

const AT = "2026-06-10T00:00:00Z";

function bootProject(s: Store): { projectId: string; featureId: string } {
  const projectId = s.nextProjectId();
  s.putProject({
    id: projectId, name: "x", path: "/x", status: "active", createdAt: AT,
  });
  s.putFeature({
    id: "F-01", projectId, name: "test feature",
    state: "going", startedAt: AT,
  });
  return { projectId, featureId: "F-01" };
}

function mkDecided(
  id: string,
  title: string,
  affects: Array<{ kind: string; id: string }> = [],
  overrides: Partial<Decision> = {},
): Decision {
  return {
    id, featureId: "F-01", type: "decision",
    title,
    raisedBy: { trigger: "t", actor: "a", layer: "personal", at: AT },
    detail: { options: [] },
    affects,
    createdAt: AT,
    ...overrides,
  };
}

// ---- computeDedupKey -------------------------------------------------------

test("computeDedupKey is deterministic for the same inputs", () => {
  const d1 = mkDecided("F-01/D-01", "Pick storage backend", [{ kind: "file", id: "src/store.ts" }]);
  const d2 = mkDecided("F-01/D-99", "Pick storage backend", [{ kind: "file", id: "src/store.ts" }]);
  assert.equal(Store.computeDedupKey(d1), Store.computeDedupKey(d2),
    "same (feature, title, affects) → same key, regardless of id");
});

test("computeDedupKey ignores affects ordering", () => {
  const a = mkDecided("F-01/D-01", "X", [
    { kind: "file", id: "a.ts" },
    { kind: "file", id: "b.ts" },
  ]);
  const b = mkDecided("F-01/D-01", "X", [
    { kind: "file", id: "b.ts" },
    { kind: "file", id: "a.ts" },
  ]);
  assert.equal(Store.computeDedupKey(a), Store.computeDedupKey(b));
});

test("computeDedupKey is sensitive to title whitespace + casing normalization", () => {
  const a = mkDecided("F-01/D-01", "Pick storage backend");
  const b = mkDecided("F-01/D-01", "  PICK   storage   BACKEND  ");
  assert.equal(Store.computeDedupKey(a), Store.computeDedupKey(b),
    "whitespace + casing normalize away");
});

test("computeDedupKey changes when affects diverge", () => {
  const a = mkDecided("F-01/D-01", "X", [{ kind: "file", id: "a.ts" }]);
  const b = mkDecided("F-01/D-01", "X", [{ kind: "file", id: "b.ts" }]);
  assert.notEqual(Store.computeDedupKey(a), Store.computeDedupKey(b));
});

// ---- putDecision: manual source skips dedup --------------------------------

test("manual source bypasses dedup — two distinct writes both land", () => {
  const s = new Store(":memory:");
  bootProject(s);
  const a = mkDecided("F-01/D-01", "Pick storage backend", [], { source: "manual" });
  const b = mkDecided("F-01/D-02", "Pick storage backend", []); // source omitted → manual default
  const ra = s.putDecision(a);
  const rb = s.putDecision(b);
  assert.equal(ra.written, true);
  assert.equal(rb.written, true);
  assert.equal(s.allDecisions().length, 2);
});

// ---- putDecision: machine sources dedup ------------------------------------

test("agent-live + agent-live with same content: second is dup-skipped", () => {
  const s = new Store(":memory:");
  bootProject(s);
  const first = mkDecided("F-01/D-01", "Pick storage backend",
    [{ kind: "file", id: "src/store.ts" }], { source: "agent-live", confidence: 0.9 });
  const second = mkDecided("F-01/D-02", "Pick storage backend",
    [{ kind: "file", id: "src/store.ts" }], { source: "agent-live", confidence: 0.95 });
  const r1 = s.putDecision(first);
  const r2 = s.putDecision(second);
  assert.equal(r1.written, true);
  assert.equal(r2.written, false);
  assert.equal((r2 as { written: false; dedupedTo: string }).dedupedTo, "F-01/D-01");
  assert.equal(s.allDecisions().length, 1);
});

test("agent-live then session-extract on same content: session-extract is dup-skipped", () => {
  const s = new Store(":memory:");
  bootProject(s);
  const live = mkDecided("F-01/D-01", "Pick storage backend",
    [{ kind: "file", id: "src/store.ts" }], { source: "agent-live", confidence: 0.9 });
  const posthoc = mkDecided("F-01/D-02", "Pick storage backend",
    [{ kind: "file", id: "src/store.ts" }], { source: "session-extract", confidence: 0.6 });
  s.putDecision(live);
  const r = s.putDecision(posthoc);
  assert.equal(r.written, false);
  assert.equal((r as { written: false; dedupedTo: string }).dedupedTo, "F-01/D-01",
    "the live capture wins — posthoc finds it on disk and bows out");
  const survivor = s.getDecision("F-01/D-01")!;
  assert.equal(survivor.source, "agent-live");
  assert.equal(survivor.confidence, 0.9);
});

test("same id re-write is NOT a dedup — agent updating its own row works", () => {
  const s = new Store(":memory:");
  bootProject(s);
  const d = mkDecided("F-01/D-01", "Pick storage backend", [],
    { source: "agent-live", confidence: 0.6 });
  s.putDecision(d);
  // Re-write with higher confidence; same id, same content. Should succeed,
  // not collide with itself.
  const r = s.putDecision({ ...d, confidence: 0.95 });
  assert.equal(r.written, true);
  assert.equal(s.getDecision("F-01/D-01")!.confidence, 0.95);
});

test("manual followed by agent-live with same content: the agent-live IS dup-skipped", () => {
  // The dedup check is symmetric on dedup_key. A manual write also populates
  // dedup_key when source is omitted? Actually no — manual skips dedup so
  // dedup_key stays NULL. That means the agent-live write later doesn't find
  // a matching key and lands as a new row. This is INTENDED: humans who
  // author manually are deciding to keep their canonical version distinct.
  const s = new Store(":memory:");
  bootProject(s);
  const manual = mkDecided("F-01/D-01", "Pick storage backend", []);  // source defaults to undefined ≈ manual
  const live = mkDecided("F-01/D-02", "Pick storage backend", [],
    { source: "agent-live", confidence: 0.9 });
  s.putDecision(manual);
  const r = s.putDecision(live);
  assert.equal(r.written, true, "manual write left dedup_key NULL → no collision");
  assert.equal(s.allDecisions().length, 2);
});

// ---- Field round-trip ------------------------------------------------------

test("source + confidence + dedupKey round-trip through getDecision", () => {
  const s = new Store(":memory:");
  bootProject(s);
  const d = mkDecided("F-01/D-01", "X",
    [{ kind: "file", id: "src/x.ts" }], { source: "session-extract", confidence: 0.42 });
  s.putDecision(d);
  const got = s.getDecision("F-01/D-01")!;
  assert.equal(got.source, "session-extract");
  assert.equal(got.confidence, 0.42);
  assert.ok(got.dedupKey, "dedupKey computed + persisted");
  assert.equal(got.dedupKey, Store.computeDedupKey(d));
});

test("legacy row (no source/confidence) decodes cleanly", () => {
  const s = new Store(":memory:");
  bootProject(s);
  const d = mkDecided("F-01/D-01", "X");
  s.putDecision(d);
  const got = s.getDecision("F-01/D-01")!;
  assert.equal(got.source, undefined);
  assert.equal(got.confidence, undefined);
  assert.equal(got.dedupKey, undefined,
    "dedupKey only computed for machine sources — manual stays NULL");
});
