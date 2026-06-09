// Projections — read-side views computed live over the decision graph.
// "什么在等我", "这件事是怎么发生的", "milestone 上发生了什么".
//
// 0.1.0 changes:
//   • Status discriminated union → split (type + status + resolved_by +
//     superseded_by). nodeState is derived here, never stored.
//   • Trigger lives inside Revisit: `decision.revisit?.trigger`.
//   • Milestone state is the 5-state enum; sort order updated accordingly.
//   • `edges.relation` (not `.kind`).
//   • Adds `projectRollup` for the Projects page; `milestoneTimeline` for
//     the Project page's main column.
import type { Store } from "./store.ts";
import type {
  Decision,
  DecisionId,
  DecisionType,
  EntityRef,
  Milestone,
  MilestoneId,
  MilestoneState,
  PauseReason,
  Project,
  ProjectId,
  Session,
  Trigger,
} from "./types.ts";
import type { EntityResolver } from "./resolver.ts";

const DAY = 86_400_000;

function ageDays(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / DAY));
}

function triggerText(t: Trigger): string {
  switch (t.kind) {
    case "manual": return "手动复审";
    case "metric": return `指标: ${t.expr}`;
    case "event": return `事件: ${t.name}`;
    case "dependency": return `依赖: ${t.on}`;
  }
}

/**
 * Does this deferred/open decision's revisit trigger look like it has fired?
 *
 * For `metric`/`event` triggers the POC can't evaluate them (no live metrics),
 * so it flags them as "needs check" — surfacing them rather than silently
 * leaving them buried is the whole point of the resume layer.
 *
 * For `dependency` triggers, fired iff the dependency target reached a
 * resolved-equivalent state (decision-without-supersession OR resolved
 * deferred/open). This matches "the thing I was waiting on is now answered".
 */
function triggerNeedsCheck(store: Store, t: Trigger): boolean {
  if (t.kind === "metric" || t.kind === "event") return true;
  if (t.kind === "dependency") {
    const dep = store.getDecision(t.on);
    if (!dep) return false;
    // type='decision' && !supersededBy  → "decided"
    if (dep.type === "decision" && !dep.supersededBy) return true;
    // (deferred|open) && status='resolved' → "resolved"
    if ((dep.type === "deferred" || dep.type === "open") && dep.status === "resolved") return true;
  }
  return false;
}

// ===========================================================================
// nodeState — derived view-side label. Never stored.
// ===========================================================================

export type NodeState =
  | "decided"
  | "deferred"
  | "superseded"
  | "resolved"
  | "open"
  | "conflicted";

export function nodeState(d: Decision): NodeState {
  if (d.type === "decision") return d.supersededBy ? "superseded" : "decided";
  if (d.status === "resolved") return "resolved";
  return d.type === "deferred" ? "deferred" : "open";
}

// ===========================================================================
// resumeDigest — "什么在等我"
// ===========================================================================

export interface WaitingItem {
  id: DecisionId;
  title: string;
  bucket: "open" | "deferred";
  ageDays: number;
  detail: string;       // the question (open) or the trigger prose (deferred)
  trigger?: string;     // deferred only — structured trigger as text
  needsCheck: boolean;  // trigger may have fired
}

/**
 * Every genuine open loop, externalised so it doesn't live in your head.
 * Ordering: needs-check first, then oldest first.
 *
 * The store query is the discriminator: open decisions with no resolution,
 * plus deferred decisions with no resolution. The status column carries the
 * "is this still open" flag — we don't need to also walk edges to find out.
 */
export function resumeDigest(store: Store): WaitingItem[] {
  const items: WaitingItem[] = [];

  // Open decisions where the resolution status hasn't moved to resolved.
  for (const d of store.byDecisionType("open")) {
    if (d.status === "resolved" || store.isResolved(d.id)) continue;
    items.push({
      id: d.id,
      title: d.title,
      bucket: "open",
      ageDays: ageDays(d.raisedBy.at),
      detail: d.detail?.trigger ?? d.title,
      needsCheck: d.revisit ? triggerNeedsCheck(store, d.revisit.trigger) : false,
    });
  }

  // Deferred decisions ditto.
  for (const d of store.byDecisionType("deferred")) {
    if (d.status === "resolved" || store.isResolved(d.id)) continue;
    items.push({
      id: d.id,
      title: d.title,
      bucket: "deferred",
      ageDays: ageDays(d.raisedBy.at),
      detail: d.detail?.trigger ?? d.title,
      trigger: d.revisit ? triggerText(d.revisit.trigger) : undefined,
      needsCheck: d.revisit ? triggerNeedsCheck(store, d.revisit.trigger) : false,
    });
  }

  // needs-check first, then oldest first.
  return items.sort(
    (a, b) => Number(b.needsCheck) - Number(a.needsCheck) || b.ageDays - a.ageDays,
  );
}

// ===========================================================================
// trace — "这件事是怎么发生的"
// ===========================================================================

export interface TraceEdge {
  relation: string;
  otherId: DecisionId;
  otherTitle: string;
  direction: "out" | "in";
  note?: string;
}

export interface Trace {
  decision: Decision;
  statusLine: string;
  affects: { ref: EntityRef; label: string; href?: string }[];
  edges: TraceEdge[];
}

function statusLine(store: Store, d: Decision): string {
  const ns = nodeState(d);
  switch (ns) {
    case "open":
      return `OPEN — ${d.detail?.trigger ?? d.title}`;
    case "decided": {
      const chosen = d.detail?.options?.find((o) => o.verdict === "chosen");
      const why = chosen ? `${chosen.name}${chosen.desc ? ": " + chosen.desc : ""}` : "?";
      return `DECIDED — 选了 ${why}`;
    }
    case "deferred": {
      const tr = d.revisit ? triggerText(d.revisit.trigger) : "无触发";
      return `DEFERRED — ${d.detail?.trigger ?? d.title} (复审: ${tr})`;
    }
    case "resolved": {
      const by = d.resolvedBy ? store.getDecision(d.resolvedBy) : null;
      return `RESOLVED — 由 ${d.resolvedBy ?? "?"}${by ? " (" + by.title + ")" : ""} 解决`;
    }
    case "superseded":
      return `SUPERSEDED — 被 ${d.supersededBy ?? "?"} 取代`;
    case "conflicted":
      return `CONFLICTED — (reserved; not produced in 0.1.0)`;
  }
}

export async function trace(
  store: Store,
  id: DecisionId,
  resolver: EntityResolver,
): Promise<Trace | null> {
  const d = store.getDecision(id);
  if (!d) return null;

  const edges: TraceEdge[] = [];
  for (const e of store.edgesFrom(id)) {
    const o = store.getDecision(e.to);
    edges.push({
      relation: e.relation,
      otherId: e.to,
      otherTitle: o?.title ?? "?",
      direction: "out",
      note: e.note,
    });
  }
  for (const e of store.edgesTo(id)) {
    const o = store.getDecision(e.from);
    edges.push({
      relation: e.relation,
      otherId: e.from,
      otherTitle: o?.title ?? "?",
      direction: "in",
      note: e.note,
    });
  }

  const affects: Trace["affects"] = [];
  for (const ref of d.affects) {
    const r = await resolver.resolve(ref);
    affects.push({ ref, label: r?.label ?? `${ref.kind}:${ref.id}`, href: r?.href });
  }

  return { decision: d, statusLine: statusLine(store, d), affects, edges };
}

export async function traceEntity(
  store: Store,
  ref: EntityRef,
  resolver: EntityResolver,
): Promise<Trace[]> {
  const ds = store.decisionsAffecting(ref);
  const out: Trace[] = [];
  for (const d of ds) {
    const t = await trace(store, d.id, resolver);
    if (t) out.push(t);
  }
  return out;
}

// ===========================================================================
// Milestone projections
// ===========================================================================

export interface MilestoneSummary {
  milestone: Milestone;
  sessionCount: number;
  decisionCount: number;
  openLoops: number;      // open + un-resolved deferred
  lastActivity: string;   // ISO of most recent session.startedAt or milestone.startedAt
}

// 5-state display order — "going" surfaces first, then winding, paused, draft,
// done (done milestones get pushed to the bottom so the list shows what needs
// attention).
const MILESTONE_STATE_ORDER: Record<MilestoneState, number> = {
  going: 0,
  winding: 1,
  paused: 2,
  draft: 3,
  done: 4,
};

export function milestoneSummary(store: Store): MilestoneSummary[] {
  const out: MilestoneSummary[] = [];
  for (const m of store.allMilestones()) {
    const sessions = store.sessionsInMilestone(m.id);
    const decisions = store.decisionsInMilestone(m.id);
    let openLoops = 0;
    for (const d of decisions) {
      const ns = nodeState(d);
      if (ns === "open" || ns === "deferred") openLoops++;
    }
    const lastActivity = sessions
      .map((s) => s.startedAt)
      .reduce((max, t) => (t > max ? t : max), m.startedAt);
    out.push({
      milestone: m,
      sessionCount: sessions.length,
      decisionCount: decisions.length,
      openLoops,
      lastActivity,
    });
  }
  return out.sort((a, b) => {
    if (a.milestone.state !== b.milestone.state) {
      return MILESTONE_STATE_ORDER[a.milestone.state] - MILESTONE_STATE_ORDER[b.milestone.state];
    }
    return b.lastActivity.localeCompare(a.lastActivity);
  });
}

export interface MilestoneDetail {
  milestone: Milestone;
  sessions: Array<{ session: Session; decisions: Decision[] }>;
  unscopedDecisions: Decision[];  // decisions bound to the milestone but no session (rare; here for completeness)
}

export function milestoneDetail(store: Store, id: MilestoneId): MilestoneDetail | null {
  const m = store.getMilestone(id);
  if (!m) return null;
  const sessions = store.sessionsInMilestone(id);
  const buckets = sessions.map((session) => ({
    session,
    decisions: store.decisionsInSession(session.id),
  }));
  const sessionDecisionIds = new Set<DecisionId>();
  for (const b of buckets) for (const d of b.decisions) sessionDecisionIds.add(d.id);
  const unscoped = store.decisionsInMilestone(id).filter((d) => !sessionDecisionIds.has(d.id));
  return { milestone: m, sessions: buckets, unscopedDecisions: unscoped };
}

// ===========================================================================
// Project rollup — the entry-page summary
// ===========================================================================

export interface ProjectRollup {
  project: Project;
  openLoops: number;       // sum across all milestones
  dueLoops: number;        // open loops whose revisit trigger looks fired
  lastActivity: string;    // most recent session.startedAt
  milestonesByState: Record<MilestoneState, number>;
  milestoneCount: number;
  decisionCount: number;
}

/**
 * One row per project. Aggregates counts across the project's milestones.
 * For a per-project Store there's exactly one row; the caller can also
 * walk this across registry entries to build the multi-project overview.
 */
export function projectRollup(store: Store, projectId: ProjectId): ProjectRollup | null {
  const project = store.getProject(projectId);
  if (!project) return null;

  const features = store.featuresIn(projectId);
  const featureIds = new Set(features.map((f) => f.id));
  const milestones = store.allMilestones().filter((m) => featureIds.has(m.featureId));

  const milestonesByState: Record<MilestoneState, number> = {
    draft: 0, going: 0, winding: 0, done: 0, paused: 0,
  };
  let decisionCount = 0;
  let openLoops = 0;
  let dueLoops = 0;
  let lastActivity = project.createdAt;

  for (const m of milestones) {
    milestonesByState[m.state]++;
    if (m.startedAt > lastActivity) lastActivity = m.startedAt;
    for (const s of store.sessionsInMilestone(m.id)) {
      if (s.startedAt > lastActivity) lastActivity = s.startedAt;
    }
    for (const d of store.decisionsInMilestone(m.id)) {
      decisionCount++;
      const ns = nodeState(d);
      if (ns === "open" || ns === "deferred") {
        openLoops++;
        if (d.revisit && triggerNeedsCheck(store, d.revisit.trigger)) dueLoops++;
      }
    }
  }

  return {
    project,
    openLoops,
    dueLoops,
    lastActivity,
    milestonesByState,
    milestoneCount: milestones.length,
    decisionCount,
  };
}

// ===========================================================================
// continue_last — "继续上次的对话"
// ===========================================================================

export interface ContinueLastResult {
  session: Session;
  milestone: Milestone;
  // Surface the last session's outcome + pause_reason so the agent can
  // read them back to the user before they decide to jump back in.
  lastOutcome?: Session["outcome"];
  lastPauseReason?: PauseReason;
}

/**
 * Find the most recent Session (in this whole store, or scoped to one
 * project / milestone) so the agent can offer to continue it.
 *
 * Returns null if there are no sessions yet.
 */
export function continueLast(store: Store, scope?: { milestoneId?: MilestoneId }): ContinueLastResult | null {
  const session = scope?.milestoneId
    ? store.latestSessionInMilestone(scope.milestoneId)
    : store.latestSession();
  if (!session) return null;
  const milestone = store.getMilestone(session.milestoneId);
  if (!milestone) return null;
  return {
    session,
    milestone,
    lastOutcome: session.outcome,
    lastPauseReason: session.pauseReason,
  };
}
