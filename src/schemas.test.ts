// Tests for src/schemas.ts (0.1.0). Pin the canonical contracts that mcp.ts
// and serve.ts both validate against — if these drift the two adapters can
// diverge.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CapturePayloadSchema,
  DecisionSchema,
  EdgeSchema,
  FeatureSchema,
  MilestoneSchema,
  PauseReasonSchema,
  ProjectSchema,
  ResumeCommandResultSchema,
  SessionOutcomeSchema,
  SessionProvenanceSchema,
  SessionSchema,
  TriggerSchema,
} from "./schemas.ts";

// ---- Project ---------------------------------------------------------------

test("ProjectSchema · valid", () => {
  const p = {
    id: "P-01", name: "stele", code: "STELE",
    path: "/x", status: "active", createdAt: "2026-06-09T00:00:00Z",
  };
  assert.equal(ProjectSchema.safeParse(p).success, true);
});

test("ProjectSchema · rejects invalid status (e.g. old 'shipped')", () => {
  const p = {
    id: "P-01", name: "stele", path: "/x", status: "shipped",
    createdAt: "2026-06-09T00:00:00Z",
  };
  assert.equal(ProjectSchema.safeParse(p).success, false);
});

// ---- Feature ---------------------------------------------------------------

test("FeatureSchema · valid with links", () => {
  const f = {
    id: "F-01", projectId: "P-01", name: "CcaaS",
    links: [{ to: "F-02", relation: "depends-on" }],
  };
  assert.equal(FeatureSchema.safeParse(f).success, true);
});

test("FeatureSchema · rejects invalid link relation", () => {
  const f = {
    id: "F-01", projectId: "P-01", name: "X",
    links: [{ to: "F-02", relation: "bogus" }],
  };
  assert.equal(FeatureSchema.safeParse(f).success, false);
});

// ---- Milestone -------------------------------------------------------------

test("MilestoneSchema · 5-state enum", () => {
  for (const state of ["draft", "going", "winding", "done", "paused"]) {
    const m = {
      id: "M-01", featureId: "F-01", name: "x",
      state, startedAt: "2026-06-09T00:00:00Z",
    };
    assert.equal(MilestoneSchema.safeParse(m).success, true, `${state} should be valid`);
  }
});

test("MilestoneSchema · rejects old 'shipped' state", () => {
  const m = {
    id: "M-01", featureId: "F-01", name: "x",
    state: "shipped", startedAt: "2026-06-09T00:00:00Z",
  };
  assert.equal(MilestoneSchema.safeParse(m).success, false);
});

// ---- Session ---------------------------------------------------------------

test("SessionSchema · with provenance + outcome", () => {
  const s = {
    id: "ses-x", milestoneId: "M-01", source: "claude-code",
    startedAt: "2026-06-09T00:00:00Z",
    provenance: { cwd: "/x", layoutAlive: true },
    outcome: { type: "advanced", summary: "ok" },
  };
  assert.equal(SessionSchema.safeParse(s).success, true);
});

test("SessionProvenanceSchema · requires layoutAlive", () => {
  assert.equal(SessionProvenanceSchema.safeParse({ cwd: "/x" }).success, false);
  assert.equal(SessionProvenanceSchema.safeParse({ cwd: "/x", layoutAlive: false }).success, true);
});

test("SessionOutcomeSchema · rejects invalid type", () => {
  assert.equal(SessionOutcomeSchema.safeParse({ type: "shipped" }).success, false);
  assert.equal(SessionOutcomeSchema.safeParse({ type: "advanced" }).success, true);
});

test("PauseReasonSchema · accepts all 6 kinds", () => {
  for (const k of ["blocked", "waiting_dep", "out_of_time", "lost_thread", "done_enough", "other"]) {
    assert.equal(PauseReasonSchema.safeParse({ kind: k }).success, true);
  }
});

// ---- Trigger ---------------------------------------------------------------

test("TriggerSchema · 4 discriminator cases", () => {
  for (const t of [
    { kind: "manual" },
    { kind: "metric", expr: "x>0" },
    { kind: "event", name: "ship" },
    { kind: "dependency", on: "M-01/D-01" },
  ]) {
    assert.equal(TriggerSchema.safeParse(t).success, true);
  }
});

test("TriggerSchema · rejects metric without expr", () => {
  assert.equal(TriggerSchema.safeParse({ kind: "metric" }).success, false);
});

// ---- Decision --------------------------------------------------------------

function baseDecided() {
  return {
    id: "M-01/D-01",
    milestoneId: "M-01",
    type: "decision" as const,
    title: "pick storage backend",
    raisedBy: {
      trigger: "user asked", actor: "agent", layer: "personal" as const,
      at: "2026-06-09T00:00:00Z",
    },
    detail: {
      options: [
        { name: "SQLite", verdict: "chosen" as const, chosen: true },
        { name: "Postgres", verdict: "rejected" as const },
      ],
    },
    affects: [],
    createdAt: "2026-06-09T00:00:00Z",
  };
}

test("DecisionSchema · type='decision' with options[]", () => {
  assert.equal(DecisionSchema.safeParse(baseDecided()).success, true);
});

test("DecisionSchema · type='decision' rejects missing detail.options", () => {
  const d = baseDecided();
  delete (d as Record<string, unknown>).detail;
  assert.equal(DecisionSchema.safeParse(d).success, false);
});

test("DecisionSchema · type='decision' allows empty options[] (no real fork)", () => {
  const d = baseDecided();
  d.detail = { options: [] };
  assert.equal(DecisionSchema.safeParse(d).success, true);
});

test("DecisionSchema · type='deferred' with revisit", () => {
  const d = {
    ...baseDecided(),
    id: "M-01/DEF-01",
    type: "deferred" as const,
    status: "open" as const,
    revisit: { trigger: { kind: "manual" as const } },
  };
  delete (d as Record<string, unknown>).detail;
  assert.equal(DecisionSchema.safeParse(d).success, true);
});

test("DecisionSchema · type='open' allows omitted detail", () => {
  const d = { ...baseDecided(), id: "M-01/OQ-01", type: "open" as const, status: "open" as const };
  delete (d as Record<string, unknown>).detail;
  assert.equal(DecisionSchema.safeParse(d).success, true);
});

// ---- Edge ------------------------------------------------------------------

test("EdgeSchema · 5 relations incl depends_on", () => {
  for (const relation of ["resolves", "supersedes", "reconciles", "relates", "depends_on"]) {
    assert.equal(
      EdgeSchema.safeParse({ from: "M-01/D-01", to: "M-01/D-02", relation }).success,
      true,
    );
  }
});

test("EdgeSchema · rejects old `kind` field name", () => {
  const e = { from: "M-01/D-01", to: "M-01/D-02", kind: "resolves" };
  assert.equal(EdgeSchema.safeParse(e).success, false);
});

// ---- CapturePayload --------------------------------------------------------

test("CapturePayloadSchema · decision only", () => {
  const p = { decision: baseDecided() };
  assert.equal(CapturePayloadSchema.safeParse(p).success, true);
});

test("CapturePayloadSchema · with tags + milestone mode=new + featureDraft", () => {
  const p = {
    decision: baseDecided(),
    milestone: {
      mode: "new",
      draft: { name: "Binary artifact", featureDraft: { name: "CcaaS" } },
    },
    tags: [{ name: "security", reason: "OWASP A1" }],
  };
  assert.equal(CapturePayloadSchema.safeParse(p).success, true);
});

// ---- Resume command --------------------------------------------------------

test("ResumeCommandResultSchema · jump mode", () => {
  const r = {
    mode: "jump",
    command: "cd /x && claude --resume abc",
    copyable: true,
  };
  assert.equal(ResumeCommandResultSchema.safeParse(r).success, true);
});
