// Milestone + Feature + Session resolution for `decision_capture`. Lifted
// out of mcp.ts in 0.0.6-fix so it's directly unit-testable.
//
// 0.1.0 changes:
//   • Milestone has a `featureId` FK; we resolve it from milestone.draft.featureId
//     or .featureDraft, or fall back to the per-project "unscoped" Feature.
//   • Milestone state starts at "going" when a Session is opened on it
//     (formerly "active").
//   • Adds `recordSessionStart`, `recordSessionEnd`, `recordMilestoneReport`
//     helpers used by the new MCP tools `session_start` / `session_end` /
//     `milestone_report`.
//   • `mode='unscoped'` now resolves to a real Milestone (the auto-created
//     per-project unscoped milestone), so every Decision has a milestone_id
//     FK and the `<milestone>/<local>` id format works uniformly.
import { createHash } from "node:crypto";
import type { Store } from "./store.ts";
import type {
  CaptureMilestoneMode,
  CaptureSourceSession,
  Feature,
  MilestoneId,
  Milestone,
  PauseReason,
  Project,
  Session,
  SessionId,
  SessionOutcome,
  SessionProvenance,
  SessionSource,
} from "./types.ts";

export interface ResolvedMilestoneSession {
  milestoneId: MilestoneId;
  sessionId: SessionId;
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
 * Guard: every operation that creates milestones / features / sessions
 * needs to know which Project owns them. Each store has at most one Project
 * (the per-project DB invariant); this helper surfaces a clear error when
 * the Project row is missing (usually means `stele init` hasn't been run).
 */
function requireProject(store: Store): Project {
  const p = store.theProject();
  if (!p) {
    throw new Error(
      "no Project row in this store — run `stele init` first (or call ensureProject)",
    );
  }
  return p;
}

/**
 * Resolve the Feature for a milestone.draft. Either an explicit featureId,
 * a featureDraft (we create the feature), or the unscoped fallback.
 */
function resolveFeatureForDraft(
  store: Store,
  project: Project,
  draft: { featureId?: string; featureDraft?: { name: string } },
): { feature: Feature; isNew: boolean } {
  if (draft.featureId) {
    const f = store.getFeature(draft.featureId);
    if (!f) throw new Error(`feature "${draft.featureId}" does not exist`);
    return { feature: f, isNew: false };
  }
  if (draft.featureDraft) {
    const id = store.nextFeatureId();
    const f: Feature = {
      id,
      projectId: project.id,
      name: draft.featureDraft.name,
    };
    store.putFeature(f);
    return { feature: f, isNew: true };
  }
  return { feature: store.ensureUnscopedFeature(project.id), isNew: false };
}

/**
 * Wires (milestone, sourceSession) into actual rows on the Store. Returns
 * the milestone_id + session_id to stamp on the decision.
 *
 * Behaviour for `mode: "continue"`:
 *   - if the matching Session is on a *different* milestone than requested,
 *     the Session is reassigned to the requested milestone (the agent's
 *     latest judgment wins; older Decisions on that session move with it).
 *   - if the matching Session is on the same milestone, it's reused.
 *
 * Behaviour for `mode: "new"`:
 *   - a fresh Milestone (and possibly Feature) is created.
 *   - then session resolution proceeds as above.
 *
 * Behaviour for `mode: "unscoped"` (or undefined):
 *   - resolves to the auto-created unscoped Milestone + Feature; a Session
 *     is still opened so the resume strip can show the latest activity.
 */
export function resolveMilestoneAndSession(
  store: Store,
  milestone: CaptureMilestoneMode | undefined,
  sourceSession: CaptureSourceSession | undefined,
  decisionAt: string,
): ResolvedMilestoneSession {
  const notes: string[] = [];
  const project = requireProject(store);

  // 1. Resolve the milestone
  let milestoneId: MilestoneId;
  if (!milestone || milestone.mode === "unscoped") {
    const m = store.ensureUnscopedMilestone(project.id);
    milestoneId = m.id;
    notes.push(`bound to unscoped milestone ${m.id}`);
  } else if (milestone.mode === "continue") {
    const existing = store.getMilestone(milestone.id);
    if (!existing) throw new Error(`milestone "${milestone.id}" does not exist`);
    milestoneId = existing.id;
    notes.push(`continued milestone ${existing.id} "${existing.name}"`);
  } else {
    // mode: "new"
    const { feature, isNew: featureIsNew } = resolveFeatureForDraft(
      store, project, milestone.draft,
    );
    if (featureIsNew) notes.push(`opened feature ${feature.id} "${feature.name}"`);
    const id = store.nextMilestoneId();
    const m: Milestone = {
      id,
      featureId: feature.id,
      name: milestone.draft.name,
      state: "draft",
      about: milestone.draft.about,
      startedAt: decisionAt,
    };
    store.putMilestone(m);
    milestoneId = id;
    notes.push(`opened milestone ${id} "${m.name}"`);
  }

  // 2. Resolve (or create / reassign) the Session
  if (!sourceSession) {
    // No source identity — open an anonymous "manual" session.
    const id = newSessionId("manual", undefined);
    store.putSession({
      id, milestoneId, source: "manual", startedAt: decisionAt,
    });
    notes.push(`opened anonymous session ${id}`);
    advanceMilestoneFromDraft(store, milestoneId);
    return { milestoneId, sessionId: id, notes };
  }

  if (sourceSession.sourceSessionId) {
    const existing = store.findSession(sourceSession.source, sourceSession.sourceSessionId);
    if (existing) {
      if (existing.milestoneId !== milestoneId) {
        notes.push(
          `reassigned session ${existing.id} from ${existing.milestoneId} → ${milestoneId} (older decisions on this session move with it)`,
        );
        store.putSession({ ...existing, milestoneId });
      } else {
        notes.push(`reused session ${existing.id}`);
      }
      advanceMilestoneFromDraft(store, milestoneId);
      return { milestoneId, sessionId: existing.id, notes };
    }
  }

  // New Session
  const id = newSessionId(sourceSession.source, sourceSession.sourceSessionId);
  store.putSession({
    id,
    milestoneId,
    source: sourceSession.source,
    sourceSessionId: sourceSession.sourceSessionId,
    startedAt: decisionAt,
  });
  notes.push(`opened session ${id} (${sourceSession.source})`);
  advanceMilestoneFromDraft(store, milestoneId);
  return { milestoneId, sessionId: id, notes };
}

/**
 * When a session opens on a milestone in 'draft' state, advance it to 'going'.
 * Other state transitions are explicit (`session_end` may move to 'winding'
 * if outcome.type='resolved'; `milestone_report` may suggest others).
 */
function advanceMilestoneFromDraft(store: Store, milestoneId: MilestoneId): void {
  const m = store.getMilestone(milestoneId);
  if (m && m.state === "draft") store.setMilestoneState(milestoneId, "going");
}

// ===========================================================================
// 0.1.0 — explicit session_start / session_end helpers
// ===========================================================================

/**
 * Explicitly open a Session under a milestone. Used by the `session_start`
 * MCP tool. Idempotent on (source, sourceSessionId): if a Session already
 * exists for the (source, sourceSessionId) pair, returns it (and reassigns
 * to the new milestone if needed).
 */
export function recordSessionStart(
  store: Store,
  milestoneId: MilestoneId,
  sourceSession: CaptureSourceSession,
  provenance?: SessionProvenance,
  at?: string,
): Session {
  if (!store.getMilestone(milestoneId)) {
    throw new Error(`milestone "${milestoneId}" does not exist`);
  }
  const startedAt = at ?? new Date().toISOString();

  if (sourceSession.sourceSessionId) {
    const existing = store.findSession(sourceSession.source, sourceSession.sourceSessionId);
    if (existing) {
      // If the prior session was already closed, we're starting a NEW logical
      // session with the same (source, sourceSessionId). Open a fresh row —
      // don't silently revive the ended one (that leaves endedAt + outcome
      // pointing at the wrong moment in time).
      if (existing.endedAt) {
        // The UNIQUE(source, source_sess_id) constraint forces us to clear
        // the old row's source_sess_id before inserting the new row. Mark it
        // as `null` and rewrite — auditors can still find it via id.
        store.putSession({ ...existing, sourceSessionId: undefined });
      } else {
        const next: Session = {
          ...existing,
          milestoneId,
          provenance: provenance ?? existing.provenance,
        };
        store.putSession(next);
        advanceMilestoneFromDraft(store, milestoneId);
        return next;
      }
    }
  }
  const id = newSessionId(sourceSession.source, sourceSession.sourceSessionId);
  const s: Session = {
    id,
    milestoneId,
    source: sourceSession.source,
    sourceSessionId: sourceSession.sourceSessionId,
    startedAt,
    provenance,
  };
  store.putSession(s);
  advanceMilestoneFromDraft(store, milestoneId);
  return s;
}

/**
 * Close a Session with an outcome and an optional pause_reason. When
 * outcome.type='resolved', the milestone advances to 'winding' (if it was
 * 'going'). Other state changes stay explicit (use milestone_report's
 * nextStateSuggestion to nudge a richer transition).
 */
export function recordSessionEnd(
  store: Store,
  sessionId: SessionId,
  outcome: SessionOutcome,
  pauseReason?: PauseReason,
  at?: string,
): Session {
  const s = store.getSession(sessionId);
  if (!s) throw new Error(`session "${sessionId}" does not exist`);
  const endedAt = at ?? new Date().toISOString();
  const next: Session = { ...s, endedAt, outcome, pauseReason };
  store.putSession(next);

  // outcome.resolves[] + outcome.via materialise as real `resolves` edges so
  // resumeDigest stops surfacing the closed loops next time. Without this
  // the typed-resolved outcome is cosmetic only.
  if (outcome.type === "resolved" && outcome.resolves && outcome.via) {
    for (const closedId of outcome.resolves) {
      // addEdge flips target status='resolved' + writes resolved_by.
      store.addEdge({ from: outcome.via, to: closedId, relation: "resolves" });
    }
  }

  if (outcome.type === "resolved") {
    const m = store.getMilestone(s.milestoneId);
    if (m && m.state === "going") store.setMilestoneState(m.id, "winding");
  }
  return next;
}
