// Milestone + Session resolution for decision_capture. Lifted out of mcp.ts
// in 0.0.6-fix so it's directly unit-testable (mcp.ts boots the MCP server
// at import time, which is not a great fit for `node --test`).
//
// The caller (mcp.ts) supplies a Store and the optional `milestone` /
// `sourceSession` fields from CapturePayload; we return the milestone id
// and session id to stamp on the resulting Decision, plus human-readable
// notes for the capture-result text.
import { createHash } from "node:crypto";
import type { Store } from "./store.ts";
import type {
  CaptureMilestoneMode,
  CaptureSourceSession,
  Milestone,
} from "./types.ts";

export interface ResolvedMilestoneSession {
  milestoneId: string | null;
  sessionId: string | null;
  notes: string[];
}

export function newSessionId(source: string, sourceSessionId: string | undefined): string {
  // The UNIQUE(source, source_sess_id) constraint in the store is the real
  // dedup guarantee; the local id just needs to be primary-key-unique.
  const seed = `${source}|${sourceSessionId ?? Math.random()}|${Date.now()}`;
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  return `ses-${hash}`;
}

/**
 * Wires (milestone, sourceSession) into actual rows on the Store. Returns
 * the session_id to stamp on the decision (or null if unscoped).
 *
 * Behaviour for `mode: "continue"`:
 *   - if the matching Session is on a *different* milestone than requested,
 *     the Session is reassigned to the requested milestone (the agent's
 *     latest judgment wins; older Decisions on that session move with it).
 *   - if the matching Session is on the same milestone, it's reused.
 *
 * Behaviour for `mode: "new"`:
 *   - a fresh Milestone is created via `store.nextMilestoneId()`.
 *   - then session resolution proceeds as above.
 *
 * Behaviour for `mode: "unscoped"` (or undefined):
 *   - both milestoneId and sessionId stay null; no store writes happen.
 */
export function resolveMilestoneAndSession(
  store: Store,
  milestone: CaptureMilestoneMode | undefined,
  sourceSession: CaptureSourceSession | undefined,
  decisionAt: string,
): ResolvedMilestoneSession {
  const notes: string[] = [];

  if (!milestone || milestone.mode === "unscoped") {
    return { milestoneId: null, sessionId: null, notes };
  }

  // 1. Resolve the milestone
  let milestoneId: string;
  if (milestone.mode === "continue") {
    const existing = store.getMilestone(milestone.id);
    if (!existing) throw new Error(`milestone "${milestone.id}" does not exist`);
    milestoneId = existing.id;
    notes.push(`continued milestone ${existing.id} "${existing.title}"`);
  } else {
    // mode: "new"
    const id = store.nextMilestoneId();
    const m: Milestone = {
      id,
      title: milestone.draft.title,
      intent: milestone.draft.intent,
      status: "active",
      startedAt: decisionAt,
    };
    store.putMilestone(m);
    milestoneId = id;
    notes.push(`opened milestone ${id} "${m.title}"`);
  }

  // 2. Resolve (or create / reassign) the session
  if (!sourceSession) {
    // No source identity — create an anonymous "manual" session under the
    // milestone. NB: this WILL produce a new Session per capture; UI users
    // running through /decision without a sourceSessionId get phantom
    // sessions. Documented limitation pending a better fallback.
    const id = newSessionId("manual", undefined);
    store.putSession({
      id,
      milestoneId,
      source: "manual",
      startedAt: decisionAt,
    });
    notes.push(`opened anonymous session ${id}`);
    return { milestoneId, sessionId: id, notes };
  }

  // We have a sourceSession — try to dedup
  if (sourceSession.sourceSessionId) {
    const existing = store.findSession(sourceSession.source, sourceSession.sourceSessionId);
    if (existing) {
      if (existing.milestoneId !== milestoneId) {
        // Agent re-assigned a conversation mid-session (e.g. realised the
        // earlier decisions actually belong to a different milestone).
        // Reattach the Session — older Decisions on it move with it, which
        // matches the user's mental model. The note records the move so
        // it's auditable.
        notes.push(
          `reassigned session ${existing.id} from ${existing.milestoneId} → ${milestoneId} (older decisions on this session move with it)`,
        );
        store.putSession({ ...existing, milestoneId });
      } else {
        notes.push(`reused session ${existing.id}`);
      }
      return { milestoneId, sessionId: existing.id, notes };
    }
  }

  // Create a new Session
  const id = newSessionId(sourceSession.source, sourceSession.sourceSessionId);
  store.putSession({
    id,
    milestoneId,
    source: sourceSession.source,
    sourceSessionId: sourceSession.sourceSessionId,
    startedAt: decisionAt,
  });
  notes.push(`opened session ${id} (${sourceSession.source})`);
  return { milestoneId, sessionId: id, notes };
}
