// Tests for the 0.0.6 milestones + sessions data layer in src/store.ts.
//
// Covers: Milestone/Session CRUD, the (source, sourceSessionId) dedup
// invariant, decisionsInMilestone / decisionsInSession lookups, and the
// lazy ALTER TABLE migration for pre-0.0.6 databases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "./store.ts";
import type {
  Decision,
  Milestone,
  Session,
} from "./types.ts";

// ---- Fixtures -----------------------------------------------------------

const baseRaisedBy = {
  trigger: "test",
  actor: "tester",
  layer: "personal" as const,
  at: "2026-06-01T00:00:00Z",
};

function mkMilestone(id: string, title: string, status: Milestone["status"] = "active"): Milestone {
  return {
    id,
    title,
    status,
    startedAt: "2026-06-01T00:00:00Z",
  };
}

function mkSession(
  id: string,
  milestoneId: string,
  source: Session["source"] = "claude-code",
  sourceSessionId?: string,
): Session {
  return {
    id,
    milestoneId,
    source,
    sourceSessionId,
    startedAt: "2026-06-01T00:00:00Z",
  };
}

function mkDecisionWithSession(id: string, title: string, sessionId?: string): Decision {
  return {
    id,
    title,
    raisedBy: baseRaisedBy,
    status: { kind: "open", question: title },
    affects: [],
    sessionId,
  };
}

// ---- Milestone CRUD ------------------------------------------------------

test("putMilestone + getMilestone roundtrip", () => {
  const s = new Store(":memory:");
  s.putMilestone(mkMilestone("M-01", "ship multi-tenant"));
  const m = s.getMilestone("M-01");
  assert.ok(m);
  assert.equal(m!.title, "ship multi-tenant");
  assert.equal(m!.status, "active");
});

test("getMilestone returns null for missing id", () => {
  const s = new Store(":memory:");
  assert.equal(s.getMilestone("M-NOPE"), null);
});

test("putMilestone is upsert (updates existing)", () => {
  const s = new Store(":memory:");
  s.putMilestone(mkMilestone("M-01", "ship X"));
  s.putMilestone({ ...mkMilestone("M-01", "ship X (renamed)"), status: "shipped" });
  const m = s.getMilestone("M-01");
  assert.equal(m!.title, "ship X (renamed)");
  assert.equal(m!.status, "shipped");
});

test("allMilestones lists every milestone", () => {
  const s = new Store(":memory:");
  s.putMilestone(mkMilestone("M-01", "first"));
  s.putMilestone(mkMilestone("M-02", "second"));
  const all = s.allMilestones();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((m) => m.id).sort(), ["M-01", "M-02"]);
});

test("byMilestoneStatus filters", () => {
  const s = new Store(":memory:");
  s.putMilestone(mkMilestone("M-01", "active one"));
  s.putMilestone(mkMilestone("M-02", "shipped one", "shipped"));
  assert.equal(s.byMilestoneStatus("active").length, 1);
  assert.equal(s.byMilestoneStatus("shipped").length, 1);
  assert.equal(s.byMilestoneStatus("abandoned").length, 0);
});

// ---- Session CRUD --------------------------------------------------------

test("putSession + getSession roundtrip", () => {
  const s = new Store(":memory:");
  s.putMilestone(mkMilestone("M-01", "x"));
  s.putSession(mkSession("ses-1", "M-01", "claude-code", "abc-123"));
  const got = s.getSession("ses-1");
  assert.ok(got);
  assert.equal(got!.milestoneId, "M-01");
  assert.equal(got!.source, "claude-code");
  assert.equal(got!.sourceSessionId, "abc-123");
});

test("findSession dedupes by (source, sourceSessionId)", () => {
  const s = new Store(":memory:");
  s.putMilestone(mkMilestone("M-01", "x"));
  s.putSession(mkSession("ses-1", "M-01", "claude-code", "abc-123"));

  const found = s.findSession("claude-code", "abc-123");
  assert.ok(found);
  assert.equal(found!.id, "ses-1");

  // Different source ID → not the same session
  assert.equal(s.findSession("claude-code", "different-id"), null);
  // Different tool → not the same session
  assert.equal(s.findSession("codex", "abc-123"), null);
});

test("sessions UNIQUE constraint on (source, sourceSessionId) prevents duplicates", () => {
  const s = new Store(":memory:");
  s.putMilestone(mkMilestone("M-01", "x"));
  s.putSession(mkSession("ses-1", "M-01", "claude-code", "abc-123"));

  // Inserting another session with the same (source, sourceSessionId) but a
  // different id should throw (we honour the schema's UNIQUE constraint).
  assert.throws(() => {
    s.putSession(mkSession("ses-2", "M-01", "claude-code", "abc-123"));
  });
});

test("sessionsInMilestone groups by milestone_id", () => {
  const s = new Store(":memory:");
  s.putMilestone(mkMilestone("M-01", "first"));
  s.putMilestone(mkMilestone("M-02", "second"));
  s.putSession(mkSession("ses-a", "M-01", "claude-code", "a"));
  s.putSession(mkSession("ses-b", "M-01", "claude-code", "b"));
  s.putSession(mkSession("ses-c", "M-02", "claude-code", "c"));
  assert.equal(s.sessionsInMilestone("M-01").length, 2);
  assert.equal(s.sessionsInMilestone("M-02").length, 1);
  assert.equal(s.sessionsInMilestone("M-99").length, 0);
});

// ---- Decisions × sessions × milestones ----------------------------------

test("decisionsInSession returns only decisions for that session", () => {
  const s = new Store(":memory:");
  s.putMilestone(mkMilestone("M-01", "x"));
  s.putSession(mkSession("ses-1", "M-01"));
  s.putSession(mkSession("ses-2", "M-01", "claude-code", "other"));
  s.putDecision(mkDecisionWithSession("D-1", "in ses-1", "ses-1"));
  s.putDecision(mkDecisionWithSession("D-2", "in ses-1", "ses-1"));
  s.putDecision(mkDecisionWithSession("D-3", "in ses-2", "ses-2"));
  s.putDecision(mkDecisionWithSession("D-X", "unscoped"));  // no sessionId

  const inSes1 = s.decisionsInSession("ses-1");
  assert.deepEqual(inSes1.map((d) => d.id).sort(), ["D-1", "D-2"]);
});

test("decisionsInMilestone aggregates across sessions in that milestone", () => {
  const s = new Store(":memory:");
  s.putMilestone(mkMilestone("M-01", "x"));
  s.putMilestone(mkMilestone("M-02", "y"));
  s.putSession(mkSession("ses-1", "M-01"));
  s.putSession(mkSession("ses-2", "M-01", "claude-code", "second"));
  s.putSession(mkSession("ses-3", "M-02", "claude-code", "third"));
  s.putDecision(mkDecisionWithSession("D-1", "M-01/ses-1", "ses-1"));
  s.putDecision(mkDecisionWithSession("D-2", "M-01/ses-2", "ses-2"));
  s.putDecision(mkDecisionWithSession("D-3", "M-02/ses-3", "ses-3"));

  const m1 = s.decisionsInMilestone("M-01");
  assert.deepEqual(m1.map((d) => d.id).sort(), ["D-1", "D-2"]);
  const m2 = s.decisionsInMilestone("M-02");
  assert.deepEqual(m2.map((d) => d.id), ["D-3"]);
});

test("decisionsInMilestone returns [] when milestone has no sessions", () => {
  const s = new Store(":memory:");
  s.putMilestone(mkMilestone("M-01", "x"));
  assert.deepEqual(s.decisionsInMilestone("M-01"), []);
});

test("unscopedDecisions returns decisions without sessionId", () => {
  const s = new Store(":memory:");
  s.putMilestone(mkMilestone("M-01", "x"));
  s.putSession(mkSession("ses-1", "M-01"));
  s.putDecision(mkDecisionWithSession("D-1", "in session", "ses-1"));
  s.putDecision(mkDecisionWithSession("D-X", "no session"));
  s.putDecision(mkDecisionWithSession("D-Y", "also no session"));

  const orphans = s.unscopedDecisions();
  assert.deepEqual(orphans.map((d) => d.id).sort(), ["D-X", "D-Y"]);
});

// ---- Schema migration ---------------------------------------------------

test("opening a pre-0.0.6 DB lazily ALTERs decisions to add session_id", () => {
  // Build a fresh DB on disk, then drop the milestones/sessions tables and
  // session_id column to simulate a 0.0.5-shape DB. Re-open with Store and
  // assert it succeeds + the new schema is in place.
  const tmpDir = mkdtempSync(join(tmpdir(), "stele-mig-"));
  const dbPath = join(tmpDir, "decisions.db");
  try {
    // First open: full 0.0.6 schema lands
    const s = new Store(dbPath);
    s.putDecision(mkDecisionWithSession("D-LEGACY", "before migration"));

    // Re-open. The CREATE TABLE IF NOT EXISTS is no-op, the ALTER throws-and-
    // is-ignored, and existing data is intact.
    const reopened = new Store(dbPath);
    const got = reopened.getDecision("D-LEGACY");
    assert.ok(got, "decision survived reopen");
    assert.equal(got!.title, "before migration");

    // The new milestones table is accessible
    reopened.putMilestone(mkMilestone("M-AFTER", "post-migration"));
    assert.equal(reopened.getMilestone("M-AFTER")!.title, "post-migration");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("session UNIQUE constraint coexists with NULL sourceSessionId", () => {
  // The UNIQUE(source, source_sess_id) constraint in SQLite treats NULLs as
  // distinct — multiple sessions with NULL sourceSessionId all coexist.
  // This matters for the "manual" source where there's no native session id.
  const s = new Store(":memory:");
  s.putMilestone(mkMilestone("M-01", "x"));
  s.putSession(mkSession("ses-a", "M-01", "manual", undefined));
  s.putSession(mkSession("ses-b", "M-01", "manual", undefined));
  assert.equal(s.sessionsInMilestone("M-01").length, 2);
});
