// Tests for src/schemas.ts — the Zod source of truth shared by mcp.ts and
// serve.ts. The bugs we want to catch here are SHAPE drift: if the schema
// accepts a payload that types.ts wouldn't, or vice versa, one adapter
// silently disagrees with the other.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CapturePayloadSchema,
  DecisionSchema,
  EdgeSchema,
  TriggerSchema,
} from "./schemas.ts";

// ---- TriggerSchema (the most regression-prone — must stay structured) ----

test("Trigger accepts manual kind", () => {
  assert.equal(TriggerSchema.safeParse({ kind: "manual" }).success, true);
});

test("Trigger accepts metric with expr", () => {
  assert.equal(
    TriggerSchema.safeParse({ kind: "metric", expr: "x > 10" }).success,
    true,
  );
});

test("Trigger accepts event with name", () => {
  assert.equal(
    TriggerSchema.safeParse({ kind: "event", name: "ships" }).success,
    true,
  );
});

test("Trigger accepts dependency with on", () => {
  assert.equal(
    TriggerSchema.safeParse({ kind: "dependency", on: "D-04" }).success,
    true,
  );
});

test("Trigger rejects free-text-only string", () => {
  assert.equal(TriggerSchema.safeParse("when it breaks").success, false);
});

test("Trigger rejects metric without expr", () => {
  assert.equal(TriggerSchema.safeParse({ kind: "metric" }).success, false);
});

test("Trigger rejects unknown kind", () => {
  assert.equal(
    TriggerSchema.safeParse({ kind: "vibes", text: "later" }).success,
    false,
  );
});

// ---- DecisionSchema — happy paths -----------------------------------------

const baseRaised = {
  trigger: "test",
  actor: "tester",
  layer: "personal",
  at: "2026-06-08T00:00:00Z",
};

test("Decision · decided · happy path", () => {
  const r = DecisionSchema.safeParse({
    id: "D-99",
    title: "test?",
    raisedBy: baseRaised,
    status: {
      kind: "decided",
      options: [{ label: "A", summary: "the a option", verdict: "chosen" }],
      rationale: "because",
    },
    affects: [{ kind: "file", id: "src/x.ts" }],
  });
  assert.equal(r.success, true);
});

test("Decision · deferred · WITH structured revisitWhen", () => {
  const r = DecisionSchema.safeParse({
    id: "DEF-99",
    title: "defer?",
    raisedBy: baseRaised,
    status: {
      kind: "deferred",
      current: "x",
      reason: "y",
      revisitWhen: { kind: "metric", expr: "z" },
    },
    affects: [],
  });
  assert.equal(r.success, true);
});

test("Decision · open · with question", () => {
  const r = DecisionSchema.safeParse({
    id: "OQ-99",
    title: "open?",
    raisedBy: baseRaised,
    status: { kind: "open", question: "is it?" },
    affects: [],
  });
  assert.equal(r.success, true);
});

// ---- DecisionSchema — the regressions ------------------------------------

test("Decision · deferred · MISSING revisitWhen is REJECTED (this was the bug)", () => {
  // A deferred decision without revisitWhen is invisible to resume forever —
  // the schema must enforce structured triggers.
  const r = DecisionSchema.safeParse({
    id: "DEF-99",
    title: "defer?",
    raisedBy: baseRaised,
    status: { kind: "deferred", current: "x", reason: "y" },
    affects: [],
  });
  assert.equal(r.success, false);
});

test("Decision · deferred · FREE-TEXT revisitWhen is REJECTED", () => {
  const r = DecisionSchema.safeParse({
    id: "DEF-99",
    title: "defer?",
    raisedBy: baseRaised,
    status: {
      kind: "deferred",
      current: "x",
      reason: "y",
      revisitWhen: "when bored",
    },
    affects: [],
  });
  assert.equal(r.success, false);
});

test("Decision · missing required field (id) rejected", () => {
  const r = DecisionSchema.safeParse({
    title: "no id",
    raisedBy: baseRaised,
    status: { kind: "open", question: "?" },
    affects: [],
  });
  assert.equal(r.success, false);
});

test("Decision · unknown layer rejected", () => {
  const r = DecisionSchema.safeParse({
    id: "D-99",
    title: "test",
    raisedBy: { ...baseRaised, layer: "galaxy" },
    status: { kind: "open", question: "?" },
    affects: [],
  });
  assert.equal(r.success, false);
});

test("Decision · decided option with bad verdict rejected", () => {
  const r = DecisionSchema.safeParse({
    id: "D-99",
    title: "test",
    raisedBy: baseRaised,
    status: {
      kind: "decided",
      options: [{ label: "A", summary: "x", verdict: "maybe" }],
      rationale: "because",
    },
    affects: [],
  });
  assert.equal(r.success, false);
});

// ---- EdgeSchema ----------------------------------------------------------

test("Edge with resolves kind", () => {
  const r = EdgeSchema.safeParse({ from: "D-1", to: "DEF-2", kind: "resolves" });
  assert.equal(r.success, true);
});

test("Edge with optional note", () => {
  const r = EdgeSchema.safeParse({
    from: "D-1",
    to: "D-2",
    kind: "relates",
    note: "see also",
  });
  assert.equal(r.success, true);
});

test("Edge with unknown kind rejected", () => {
  const r = EdgeSchema.safeParse({ from: "D-1", to: "D-2", kind: "vibes" });
  assert.equal(r.success, false);
});

test("Edge missing from rejected", () => {
  const r = EdgeSchema.safeParse({ to: "D-2", kind: "relates" });
  assert.equal(r.success, false);
});

// ---- CapturePayloadSchema -----------------------------------------------

test("CapturePayload · decision only (no edges)", () => {
  const r = CapturePayloadSchema.safeParse({
    decision: {
      id: "D-1",
      title: "t",
      raisedBy: baseRaised,
      status: { kind: "open", question: "?" },
      affects: [],
    },
  });
  assert.equal(r.success, true);
});

test("CapturePayload · decision + edges array", () => {
  const r = CapturePayloadSchema.safeParse({
    decision: {
      id: "D-1",
      title: "t",
      raisedBy: baseRaised,
      status: { kind: "open", question: "?" },
      affects: [],
    },
    edges: [{ from: "D-1", to: "DEF-2", kind: "resolves" }],
  });
  assert.equal(r.success, true);
});
