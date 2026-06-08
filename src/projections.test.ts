// Tests for src/projections.ts — resumeDigest, trace, traceEntity.
//
// All three are pure read-side projections over a Store. We seed an
// in-memory SQLite via `Store(":memory:")` and assert the projection shapes.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Store } from "./store.ts";
import { resumeDigest, trace, traceEntity } from "./projections.ts";
import { stubResolver } from "./resolver.ts";
import type { Decision } from "./types.ts";

const baseRaisedBy = {
  trigger: "test",
  actor: "tester",
  layer: "personal" as const,
  at: "2026-06-01T00:00:00Z", // 8 days ago at test time; ageDays will be ≥ 7
};

function mkOpen(id: string, title: string, question = "?"): Decision {
  return {
    id,
    title,
    raisedBy: baseRaisedBy,
    status: { kind: "open", question },
    affects: [],
  };
}

function mkDeferred(
  id: string,
  title: string,
  revisitWhen: import("./types.ts").Trigger,
): Decision {
  return {
    id,
    title,
    raisedBy: baseRaisedBy,
    status: { kind: "deferred", current: "x", reason: "y", revisitWhen },
    affects: [],
  };
}

function mkDecided(id: string, title: string): Decision {
  return {
    id,
    title,
    raisedBy: baseRaisedBy,
    status: {
      kind: "decided",
      options: [{ label: "A", summary: "a", verdict: "chosen" }],
      rationale: "because",
    },
    affects: [],
  };
}

function freshStore(): Store {
  return new Store(":memory:");
}

// ---- resumeDigest --------------------------------------------------------

test("resumeDigest is empty on empty store", () => {
  const s = freshStore();
  assert.deepEqual(resumeDigest(s), []);
});

test("resumeDigest surfaces open + deferred, ignores decided/resolved", () => {
  const s = freshStore();
  s.putDecision(mkOpen("OQ-1", "open one"));
  s.putDecision(mkDeferred("DEF-1", "deferred one", { kind: "manual" }));
  s.putDecision(mkDecided("D-1", "decided one"));

  const items = resumeDigest(s);
  const ids = items.map((i) => i.id).sort();
  assert.deepEqual(ids, ["DEF-1", "OQ-1"]);
});

test("resumeDigest drops deferred that has a resolves edge", () => {
  const s = freshStore();
  s.putDecision(mkDeferred("DEF-1", "deferred one", { kind: "manual" }));
  s.putDecision(mkDecided("D-1", "later decided"));
  s.addEdge({ from: "D-1", to: "DEF-1", kind: "resolves" });

  const items = resumeDigest(s);
  assert.equal(items.length, 0, "resolved deferred should not surface");
});

test("resumeDigest flags metric trigger as needsCheck", () => {
  const s = freshStore();
  s.putDecision(mkDeferred("DEF-1", "metric defer", { kind: "metric", expr: "x > 10" }));
  s.putDecision(mkDeferred("DEF-2", "manual defer", { kind: "manual" }));

  const items = resumeDigest(s);
  const byId = new Map(items.map((i) => [i.id, i]));
  assert.equal(byId.get("DEF-1")!.needsCheck, true);
  assert.equal(byId.get("DEF-2")!.needsCheck, false);
});

test("resumeDigest flags event trigger as needsCheck", () => {
  const s = freshStore();
  s.putDecision(mkDeferred("DEF-1", "event defer", { kind: "event", name: "ships" }));

  const items = resumeDigest(s);
  assert.equal(items[0].needsCheck, true);
});

test("resumeDigest flags dependency trigger as needsCheck IFF dep is decided/resolved", () => {
  const s = freshStore();
  // Two deferred items: one depends on a decided node, one depends on an open node
  s.putDecision(mkDecided("D-1", "the dep"));
  s.putDecision(mkOpen("OQ-1", "the other dep"));
  s.putDecision(mkDeferred("DEF-1", "dep on decided", { kind: "dependency", on: "D-1" }));
  s.putDecision(mkDeferred("DEF-2", "dep on open", { kind: "dependency", on: "OQ-1" }));

  const items = resumeDigest(s);
  const byId = new Map(items.map((i) => [i.id, i]));
  assert.equal(byId.get("DEF-1")!.needsCheck, true, "dep is decided → trigger fired");
  assert.equal(byId.get("DEF-2")!.needsCheck, false, "dep is still open → don't bother");
});

test("resumeDigest sorts: needsCheck first, then oldest age first", () => {
  const s = freshStore();
  const old = { ...baseRaisedBy, at: "2026-05-01T00:00:00Z" };  // older
  const newer = { ...baseRaisedBy, at: "2026-06-05T00:00:00Z" }; // newer

  // No needsCheck, old → comes after newer-but-needsCheck
  s.putDecision({ ...mkDeferred("DEF-OLD", "old plain", { kind: "manual" }), raisedBy: old });
  s.putDecision({ ...mkDeferred("DEF-NEW-CHK", "new but due", { kind: "metric", expr: "y" }), raisedBy: newer });
  s.putDecision({ ...mkDeferred("DEF-OLD-CHK", "old AND due", { kind: "metric", expr: "z" }), raisedBy: old });

  const items = resumeDigest(s);
  // Expected order:
  //   1. DEF-OLD-CHK (needsCheck + oldest)
  //   2. DEF-NEW-CHK (needsCheck + newer)
  //   3. DEF-OLD     (not needsCheck)
  assert.equal(items[0].id, "DEF-OLD-CHK");
  assert.equal(items[1].id, "DEF-NEW-CHK");
  assert.equal(items[2].id, "DEF-OLD");
});

test("WaitingItem has trigger string for deferred only", () => {
  const s = freshStore();
  s.putDecision(mkOpen("OQ-1", "open"));
  s.putDecision(mkDeferred("DEF-1", "deferred", { kind: "event", name: "x" }));

  const items = resumeDigest(s);
  const open = items.find((i) => i.id === "OQ-1")!;
  const def = items.find((i) => i.id === "DEF-1")!;
  assert.equal(open.trigger, undefined);
  assert.ok(def.trigger, "deferred item should have trigger text");
  assert.ok(def.trigger!.includes("事件"), "should be Chinese 事件 prefix");
});

// ---- trace ---------------------------------------------------------------

test("trace returns null for missing id", async () => {
  const s = freshStore();
  const t = await trace(s, "NO-SUCH", stubResolver);
  assert.equal(t, null);
});

test("trace returns decision, statusLine, affects, edges", async () => {
  const s = freshStore();
  s.putDecision({
    ...mkDecided("D-1", "test decided"),
    affects: [
      { kind: "file", id: "src/x.ts" },
      { kind: "feature", id: "test-feature" },
    ],
  });

  const t = await trace(s, "D-1", stubResolver);
  assert.ok(t);
  assert.equal(t!.decision.id, "D-1");
  assert.ok(t!.statusLine.includes("DECIDED"));
  assert.equal(t!.affects.length, 2);
  assert.equal(t!.edges.length, 0);
});

test("trace edges include direction (in/out)", async () => {
  const s = freshStore();
  s.putDecision(mkDecided("D-1", "first"));
  s.putDecision(mkDecided("D-2", "second"));
  s.putDecision(mkDeferred("DEF-1", "defer", { kind: "manual" }));
  s.addEdge({ from: "D-2", to: "D-1", kind: "supersedes" }); // outgoing from D-2
  s.addEdge({ from: "D-1", to: "DEF-1", kind: "relates" });  // outgoing from D-1

  const t = await trace(s, "D-1", stubResolver);
  assert.ok(t);
  const dirs = t!.edges.map((e) => `${e.direction}:${e.kind}:${e.otherId}`).sort();
  assert.deepEqual(dirs, ["in:supersedes:D-2", "out:relates:DEF-1"]);
});

test("trace statusLine reflects each status kind", async () => {
  const s = freshStore();
  s.putDecision(mkOpen("OQ-1", "open", "is it?"));
  s.putDecision(mkDeferred("DEF-1", "defer", { kind: "manual" }));
  s.putDecision(mkDecided("D-1", "decided"));

  assert.ok((await trace(s, "OQ-1", stubResolver))!.statusLine.startsWith("OPEN"));
  assert.ok((await trace(s, "DEF-1", stubResolver))!.statusLine.startsWith("DEFERRED"));
  assert.ok((await trace(s, "D-1", stubResolver))!.statusLine.startsWith("DECIDED"));
});

test("trace statusLine for resolved/superseded references the resolver", async () => {
  const s = freshStore();
  s.putDecision(mkDeferred("DEF-1", "defer", { kind: "manual" }));
  s.putDecision(mkDecided("D-1", "later"));
  s.addEdge({ from: "D-1", to: "DEF-1", kind: "resolves" });
  // setStatus side-effect on resolves should flip DEF-1 to {kind:"resolved", by:"D-1"}

  const t = await trace(s, "DEF-1", stubResolver);
  assert.ok(t!.statusLine.includes("RESOLVED"));
  assert.ok(t!.statusLine.includes("D-1"));
});

// ---- traceEntity ---------------------------------------------------------

test("traceEntity returns all decisions affecting that ref", async () => {
  const s = freshStore();
  s.putDecision({
    ...mkDecided("D-1", "uses x.ts"),
    affects: [{ kind: "file", id: "src/x.ts" }],
  });
  s.putDecision({
    ...mkDecided("D-2", "uses y.ts"),
    affects: [{ kind: "file", id: "src/y.ts" }],
  });
  s.putDecision({
    ...mkOpen("OQ-1", "also uses x.ts"),
    affects: [{ kind: "file", id: "src/x.ts" }],
  });

  const traces = await traceEntity(s, { kind: "file", id: "src/x.ts" }, stubResolver);
  const ids = traces.map((t) => t.decision.id).sort();
  assert.deepEqual(ids, ["D-1", "OQ-1"]);
});

test("traceEntity returns empty for an unknown ref", async () => {
  const s = freshStore();
  s.putDecision(mkDecided("D-1", "test"));

  const traces = await traceEntity(s, { kind: "file", id: "nope" }, stubResolver);
  assert.deepEqual(traces, []);
});
