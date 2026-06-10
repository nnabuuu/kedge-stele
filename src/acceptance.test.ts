// End-to-end acceptance scenario, split into named stages.
//
// Walks through the full happy path: Project bootstrap → Feature →
// session_start → decision capture → tag → depends_on edge → session_end
// → resume. Each stage is a separate test using a shared module-level Store
// so a failure pinpoints the offending step.
//
// 0.3.0: the Project → Feature → Milestone → Session → Decision chain
// collapsed into Project → Feature → Session → Decision (the umbrella
// Feature layer is gone; what used to be a Milestone IS the new Feature).
import { test } from "node:test";
import assert from "node:assert/strict";

import { Store } from "./store.ts";
import {
  recordSessionEnd,
  recordSessionStart,
} from "./capture.ts";
import { applyCaptureTags } from "./tags.ts";
import {
  continueLast,
  featureSummary,
  nodeState,
  resumeDigest,
} from "./projections.ts";
import type { Decision } from "./types.ts";

const AT = "2026-06-09T00:00:00Z";

// Shared world. Each stage builds on the previous one.
const s = new Store(":memory:");
let projectId: string;
let featureId: string;
let sessionId: string;
let decidedId: string;
let openId: string;

test("acceptance · stage 1 · `stele init` shape: Project + unscoped Feature", () => {
  projectId = s.nextProjectId();
  s.putProject({
    id: projectId, name: "test-project", code: "TEST",
    path: "/tmp/test", status: "active", createdAt: AT,
  });
  s.ensureUnscopedFeature(projectId);
  assert.ok(s.theProject(), "Project row must exist after init");
});

test("acceptance · stage 2 · open a real Feature (state=draft)", () => {
  featureId = s.nextFeatureId();
  s.putFeature({
    id: featureId, projectId, name: "Binary artifact + SSE auth",
    state: "draft", about: "Wire up streaming auth", startedAt: AT,
  });
  assert.equal(s.getFeature(featureId)!.state, "draft");
});

test("acceptance · stage 4 · session_start advances feature draft → going", () => {
  const session = recordSessionStart(
    s, featureId,
    { source: "claude-code", sourceSessionId: "cc-abc-123" },
    { cwd: "/tmp/test", layoutAlive: true, zellijSession: "jijian" },
  );
  sessionId = session.id;
  assert.equal(s.getFeature(featureId)!.state, "going");
});

test("acceptance · stage 5 · decision_capture with rich detail body", () => {
  decidedId = s.nextLocalDecisionId(featureId, "decision");
  const decision: Decision = {
    id: decidedId,
    featureId,
    sessionId,
    type: "decision",
    title: "Pick storage backend",
    raisedBy: {
      trigger: "user asked about persistence",
      actor: "agent", layer: "personal", at: AT,
    },
    detail: {
      optionAxis: "Backend",
      trigger: "user asked about persistence",
      constraint: "must be zero-deps and embedded",
      options: [
        { name: "SQLite", desc: "embedded", verdict: "chosen", chosen: true, why: "zero-deps wins" },
        { name: "Postgres", desc: "server", verdict: "rejected", why: "deployment overhead" },
      ],
      why: ["SQLite is local-first by default; nothing to provision."],
      locks: { in: "Local-first design", out: "Server-side fanout" },
      artifact: { file: "src/store.ts" },
    },
    affects: [{ kind: "file", id: "src/store.ts" }],
    createdAt: AT,
  };
  s.putDecision(decision);
  assert.equal(nodeState(decision), "decided");
});

test("acceptance · stage 6 · tag policy=propose queues a pending proposal", () => {
  const tagResult = applyCaptureTags(
    s,
    [{ name: "backend", reason: "category mark" }],
    decidedId,
  );
  assert.equal(tagResult.pending.length, 1);
});

test("acceptance · stage 7 · open question + depends_on edge", () => {
  openId = s.nextLocalDecisionId(featureId, "open");
  const openDecision: Decision = {
    id: openId, featureId, sessionId,
    type: "open", status: "open",
    title: "What about WAL?",
    raisedBy: { trigger: "follow-up", actor: "agent", layer: "personal", at: AT },
    affects: [], createdAt: AT,
  };
  s.putDecision(openDecision);
  s.addEdge({ from: openId, to: decidedId, relation: "depends_on" });
  // depends_on is non-mutating — verify the source isn't auto-resolved
  assert.equal(s.getDecision(openId)!.status, "open");
});

test("acceptance · stage 8 · session_end writes outcome + pause_reason", () => {
  const closed = recordSessionEnd(
    s, sessionId,
    { type: "advanced", summary: "wired storage backend" },
    { kind: "out_of_time", note: "tests next" },
  );
  assert.equal(closed.outcome!.type, "advanced");
  assert.equal(closed.pauseReason!.kind, "out_of_time");
  // 'advanced' alone doesn't transition feature state; stays at 'going'
  assert.equal(s.getFeature(featureId)!.state, "going");
});

test("acceptance · stage 9 · resumeDigest surfaces the one open loop", () => {
  const items = resumeDigest(s);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, openId);
});

test("acceptance · stage 10 · continueLast reads the closed session back", () => {
  const last = continueLast(s);
  assert.ok(last);
  assert.equal(last!.session.id, sessionId);
  assert.equal(last!.lastPauseReason!.kind, "out_of_time");
});

test("acceptance · stage 11 · featureSummary reflects the activity", () => {
  const summary = featureSummary(s).find((m) => m.feature.id === featureId)!;
  assert.equal(summary.openLoops, 1);
  assert.equal(summary.decisionCount, 2);
});

test("acceptance · stage 12 · session_end with outcome.resolves[] materialises a resolves edge", () => {
  // Open a fresh session, then close it with outcome.type='resolved' pointing
  // at the still-open question. The edge should land and resumeDigest empty.
  const s2 = recordSessionStart(s, featureId, { source: "manual" });
  const closingId = s.nextLocalDecisionId(featureId, "decision");
  s.putDecision({
    id: closingId, featureId, sessionId: s2.id,
    type: "decision",
    title: "Yes, enable WAL",
    raisedBy: { trigger: "answer", actor: "agent", layer: "personal", at: AT },
    detail: { options: [{ name: "WAL on", verdict: "chosen", chosen: true }] },
    affects: [], createdAt: AT,
  });
  recordSessionEnd(s, s2.id, {
    type: "resolved",
    summary: "closed the WAL question",
    resolves: [openId],
    via: closingId,
  });
  assert.equal(s.getDecision(openId)!.status, "resolved");
  assert.equal(s.getDecision(openId)!.resolvedBy, closingId);
  assert.equal(resumeDigest(s).length, 0, "no open loops left");
});
