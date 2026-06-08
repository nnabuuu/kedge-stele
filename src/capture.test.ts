// Tests for src/capture.ts — resolveMilestoneAndSession.
//
// This is the part of decision_capture that wires the agent's milestone +
// sourceSession judgment into Store rows. The 0.0.6 release shipped with a
// silent-incoherence bug (milestone-id mismatch on session reuse); this
// suite pins the fixed behaviour as a regression test.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Store } from "./store.ts";
import { resolveMilestoneAndSession } from "./capture.ts";
import type { Milestone } from "./types.ts";

const AT = "2026-06-09T00:00:00Z";

function freshStoreWithMilestone(id: string, title = "test"): Store {
  const s = new Store(":memory:");
  s.putMilestone({
    id, title,
    status: "active",
    startedAt: "2026-06-01T00:00:00Z",
  });
  return s;
}

// ---- mode: "unscoped" ---------------------------------------------------

test("unscoped mode returns null/null and writes nothing", () => {
  const s = new Store(":memory:");
  const r = resolveMilestoneAndSession(
    s, { mode: "unscoped" },
    { source: "claude-code", sourceSessionId: "abc" },
    AT,
  );
  assert.equal(r.milestoneId, null);
  assert.equal(r.sessionId, null);
  assert.equal(s.allMilestones().length, 0);
});

test("undefined milestone is treated as unscoped", () => {
  const s = new Store(":memory:");
  const r = resolveMilestoneAndSession(s, undefined, undefined, AT);
  assert.equal(r.milestoneId, null);
  assert.equal(r.sessionId, null);
});

// ---- mode: "new" --------------------------------------------------------

test("mode:new creates milestone + session and stamps both", () => {
  const s = new Store(":memory:");
  const r = resolveMilestoneAndSession(
    s,
    { mode: "new", draft: { title: "ship X", intent: "we want X because Y" } },
    { source: "claude-code", sourceSessionId: "claude-abc" },
    AT,
  );
  assert.ok(r.milestoneId);
  assert.ok(r.sessionId);
  const m = s.getMilestone(r.milestoneId!)!;
  assert.equal(m.title, "ship X");
  assert.equal(m.intent, "we want X because Y");
  assert.equal(m.status, "active");
  const ses = s.getSession(r.sessionId!)!;
  assert.equal(ses.source, "claude-code");
  assert.equal(ses.sourceSessionId, "claude-abc");
  assert.equal(ses.milestoneId, m.id);
});

test("mode:new without sourceSession opens an anonymous 'manual' session", () => {
  const s = new Store(":memory:");
  const r = resolveMilestoneAndSession(
    s,
    { mode: "new", draft: { title: "no source identity" } },
    undefined,
    AT,
  );
  assert.ok(r.sessionId);
  const ses = s.getSession(r.sessionId!)!;
  assert.equal(ses.source, "manual");
  assert.equal(ses.sourceSessionId, undefined);
});

// ---- mode: "continue" ---------------------------------------------------

test("mode:continue on missing milestone throws", () => {
  const s = new Store(":memory:");
  assert.throws(() => {
    resolveMilestoneAndSession(
      s,
      { mode: "continue", id: "M-NOPE" },
      { source: "claude-code", sourceSessionId: "abc" },
      AT,
    );
  }, /does not exist/);
});

test("mode:continue with new sourceSessionId creates a fresh session under that milestone", () => {
  const s = freshStoreWithMilestone("M-01");
  const r = resolveMilestoneAndSession(
    s,
    { mode: "continue", id: "M-01" },
    { source: "claude-code", sourceSessionId: "first-time" },
    AT,
  );
  assert.equal(r.milestoneId, "M-01");
  assert.ok(r.sessionId);
  const ses = s.getSession(r.sessionId!)!;
  assert.equal(ses.milestoneId, "M-01");
  assert.equal(ses.sourceSessionId, "first-time");
});

test("mode:continue with an existing matching session REUSES it", () => {
  const s = freshStoreWithMilestone("M-01");
  // First capture
  const r1 = resolveMilestoneAndSession(
    s,
    { mode: "continue", id: "M-01" },
    { source: "claude-code", sourceSessionId: "stable-sid" },
    AT,
  );
  // Second capture with same sourceSessionId + same milestone
  const r2 = resolveMilestoneAndSession(
    s,
    { mode: "continue", id: "M-01" },
    { source: "claude-code", sourceSessionId: "stable-sid" },
    AT,
  );
  assert.equal(r2.sessionId, r1.sessionId, "same conversation should land on the same session");
  // And the notes should say "reused"
  assert.ok(r2.notes.some((n) => n.includes("reused")));
});

// ---- CR1 regression: milestone-mismatch reassignment -------------------

test("CR1 — agent re-assigns conversation to a different milestone → Session moves with it", () => {
  const s = new Store(":memory:");
  // Two active milestones
  const M1: Milestone = { id: "M-01", title: "first attempt", status: "active", startedAt: AT };
  const M2: Milestone = { id: "M-02", title: "real direction", status: "active", startedAt: AT };
  s.putMilestone(M1);
  s.putMilestone(M2);

  // First capture: agent says we're on M-01
  const r1 = resolveMilestoneAndSession(
    s,
    { mode: "continue", id: "M-01" },
    { source: "claude-code", sourceSessionId: "same-conv" },
    AT,
  );
  assert.equal(r1.milestoneId, "M-01");
  const sessionId = r1.sessionId!;
  assert.equal(s.getSession(sessionId)!.milestoneId, "M-01");

  // Second capture in the same Claude session: agent realised this is
  // really on M-02 (the user pivoted, or the agent re-read context).
  const r2 = resolveMilestoneAndSession(
    s,
    { mode: "continue", id: "M-02" },
    { source: "claude-code", sourceSessionId: "same-conv" },
    AT,
  );

  // The returned milestoneId is M-02 (what the agent asked for)
  assert.equal(r2.milestoneId, "M-02");
  // The session is the SAME row (dedup worked)
  assert.equal(r2.sessionId, sessionId);
  // AND CRITICALLY: the Session in the store now points at M-02, not M-01.
  // Without the CR1 fix, the Session row would still say M-01 — silently
  // contradicting the milestoneId we returned.
  assert.equal(
    s.getSession(sessionId)!.milestoneId,
    "M-02",
    "Session row was not reassigned — the 0.0.6 mismatch bug is back",
  );

  // The note records the move so it's auditable
  assert.ok(
    r2.notes.some((n) => n.includes("reassigned")),
    "no audit trail for the milestone reassignment",
  );

  // Decisions that already pointed at this Session are NOT moved per-row,
  // but their milestone projection follows the Session, so they appear
  // under M-02 going forward. Verify via decisionsInMilestone.
  s.putDecision({
    id: "D-1",
    title: "first decision",
    raisedBy: {
      trigger: "x", actor: "x", layer: "personal", at: AT,
    },
    status: { kind: "open", question: "?" },
    affects: [],
    sessionId,
  });
  assert.deepEqual(
    s.decisionsInMilestone("M-02").map((d) => d.id),
    ["D-1"],
    "decision should follow the session into the new milestone",
  );
  assert.deepEqual(
    s.decisionsInMilestone("M-01").map((d) => d.id),
    [],
    "old milestone should be empty after the session moved",
  );
});

// ---- notes audit ---------------------------------------------------------

test("notes mention the milestone id + title on continue", () => {
  const s = freshStoreWithMilestone("M-01", "ship something");
  const r = resolveMilestoneAndSession(
    s,
    { mode: "continue", id: "M-01" },
    { source: "claude-code", sourceSessionId: "x" },
    AT,
  );
  assert.ok(r.notes.some((n) => n.includes("M-01") && n.includes("ship something")));
});

test("notes mention the milestone id + title on new", () => {
  const s = new Store(":memory:");
  const r = resolveMilestoneAndSession(
    s,
    { mode: "new", draft: { title: "kick off X" } },
    { source: "claude-code", sourceSessionId: "x" },
    AT,
  );
  assert.ok(r.notes.some((n) => n.includes("kick off X")));
});
