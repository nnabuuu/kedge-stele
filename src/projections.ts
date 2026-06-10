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
  EdgeRelation,
  EntityRef,
  Feature,
  FeatureId,
  Milestone,
  MilestoneId,
  MilestoneState,
  PauseReason,
  Project,
  ProjectId,
  ProjectStatus,
  Session,
  SessionId,
  SessionOutcome,
  Trigger,
} from "./types.ts";
import type { ProjectEntry } from "./registry.ts";
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

// ===========================================================================
// Trace stitch — the cross-session resolves arc behind a decision
// ===========================================================================

export interface TraceStitchSession {
  id: SessionId;
  startedAt: string;
  milestoneId: MilestoneId;
  milestoneName?: string;
}

export interface TraceStitchDecision {
  id: DecisionId;
  title: string;
  type: DecisionType;
  sessionId?: SessionId;
}

export interface TraceStitch {
  // The resolving decision (the one that closed the loop) — typically the
  // newer of the pair.
  resolver: TraceStitchDecision;
  // The decision that was resolved — typically the older deferred loop.
  resolved: TraceStitchDecision;
  // Sessions in which each side was captured. earlier/later derived by
  // startedAt; either may be undefined if the decision lacks a sessionId.
  earlierSession?: TraceStitchSession;
  laterSession?: TraceStitchSession;
  // Whole-day gap between earlier→later session start. Undefined if either
  // session is unknown.
  daysSpanned?: number;
  // The `resolves` edge note, if recorded.
  edgeNote?: string;
}

/**
 * For a focal decision id, find a `resolves` edge it participates in and
 * report it as a cross-session stitch — IF the two sides are in different
 * sessions. Same-session resolves don't qualify (no "stitching across time"
 * to surface).
 */
export function traceStitch(store: Store, decisionId: DecisionId): TraceStitch | null {
  const focal = store.getDecision(decisionId);
  if (!focal) return null;

  // Find ANY resolves edge involving this decision. Outgoing means this
  // decision resolves something else; incoming means something else
  // resolves this decision.
  let resolverId: DecisionId | null = null;
  let resolvedId: DecisionId | null = null;
  let edgeNote: string | undefined;

  for (const e of store.edgesFrom(decisionId)) {
    if (e.relation === "resolves") {
      resolverId = decisionId;
      resolvedId = e.to;
      edgeNote = e.note;
      break;
    }
  }
  if (!resolverId) {
    for (const e of store.edgesTo(decisionId)) {
      if (e.relation === "resolves") {
        resolverId = e.from;
        resolvedId = decisionId;
        edgeNote = e.note;
        break;
      }
    }
  }
  if (!resolverId || !resolvedId) return null;

  const resolverDec = store.getDecision(resolverId);
  const resolvedDec = store.getDecision(resolvedId);
  if (!resolverDec || !resolvedDec) return null;

  const resolverSession = resolverDec.sessionId ? store.getSession(resolverDec.sessionId) : null;
  const resolvedSession = resolvedDec.sessionId ? store.getSession(resolvedDec.sessionId) : null;

  // Same session → not a cross-session stitch; don't surface.
  if (resolverSession && resolvedSession && resolverSession.id === resolvedSession.id) {
    return null;
  }

  const enrich = (s: Session | null): TraceStitchSession | undefined => {
    if (!s) return undefined;
    return {
      id: s.id,
      startedAt: s.startedAt,
      milestoneId: s.milestoneId,
      milestoneName: store.getMilestone(s.milestoneId)?.name,
    };
  };

  // Pick the older as "earlier", newer as "later".
  let earlier: Session | null = null;
  let later: Session | null = null;
  if (resolverSession && resolvedSession) {
    if (resolvedSession.startedAt <= resolverSession.startedAt) {
      earlier = resolvedSession;
      later = resolverSession;
    } else {
      earlier = resolverSession;
      later = resolvedSession;
    }
  } else {
    earlier = resolvedSession ?? resolverSession;
    later = null;
  }

  let daysSpanned: number | undefined;
  if (earlier && later) {
    daysSpanned = Math.round(
      (Date.parse(later.startedAt) - Date.parse(earlier.startedAt)) / 86_400_000,
    );
  }

  const decRef = (d: Decision): TraceStitchDecision => ({
    id: d.id,
    title: d.title,
    type: d.type,
    sessionId: d.sessionId,
  });

  return {
    resolver: decRef(resolverDec),
    resolved: decRef(resolvedDec),
    earlierSession: enrich(earlier),
    laterSession: enrich(later),
    daysSpanned,
    edgeNote,
  };
}

// ===========================================================================
// Feature rail — left navigation on the Project page
// ===========================================================================

export interface FeatureRailMilestoneTag {
  id: string;
  name: string;
  color: string;
}

export interface FeatureRailMilestone {
  id: MilestoneId;
  name: string;
  state: MilestoneState;
  sessionCount: number;
  decisionCount: number;
  openLoops: number;
  lastActivity: string | null;   // most recent session.startedAt, falls back to milestone.startedAt
  tags: FeatureRailMilestoneTag[];
}

export interface FeatureRailEntry {
  feature: Feature;
  milestones: FeatureRailMilestone[];
}

/**
 * The Project page's left rail: features → milestones, sorted so the
 * milestone you most likely want to resume floats to the top.
 *
 * Milestones within a feature sort by state (going > winding > paused >
 * draft > done) then by lastActivity desc. Features sort by count of
 * active milestones desc. Empty features are dropped.
 *
 * Assumes single-project stores (the daemon's per-slug model); for
 * multi-project stores we walk the first project's features.
 */
export function featureRail(store: Store): FeatureRailEntry[] {
  const projects = store.allProjects();
  const project = projects[0];
  if (!project) return [];

  const features = store.featuresIn(project.id);
  const milestonesByFeature = new Map<string, Milestone[]>();
  for (const m of store.allMilestones()) {
    const arr = milestonesByFeature.get(m.featureId) ?? [];
    arr.push(m);
    milestonesByFeature.set(m.featureId, arr);
  }

  const STATE_RANK: Record<MilestoneState, number> = {
    going: 0, winding: 1, paused: 2, draft: 3, done: 4,
  };

  const entries: FeatureRailEntry[] = features.map((feature) => {
    const ms = milestonesByFeature.get(feature.id) ?? [];
    const milestones: FeatureRailMilestone[] = ms.map((m) => {
      const sessions = store.sessionsInMilestone(m.id);
      const decisions = store.decisionsInMilestone(m.id);
      const openLoops = decisions.filter((d) => {
        const ns = nodeState(d);
        return ns === "open" || ns === "deferred";
      }).length;
      const lastSession = sessions[sessions.length - 1];
      const tags = store.taggingsForTarget("milestone", m.id).map((t) => ({
        id: t.id, name: t.name, color: t.color,
      }));
      return {
        id: m.id,
        name: m.name,
        state: m.state,
        sessionCount: sessions.length,
        decisionCount: decisions.length,
        openLoops,
        lastActivity: lastSession?.startedAt ?? m.startedAt ?? null,
        tags,
      };
    });
    milestones.sort((a, b) => {
      const r = STATE_RANK[a.state] - STATE_RANK[b.state];
      if (r !== 0) return r;
      return (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "");
    });
    return { feature, milestones };
  });

  entries.sort((a, b) => {
    const active = (e: FeatureRailEntry) =>
      e.milestones.filter((m) => m.state === "going" || m.state === "winding").length;
    return active(b) - active(a);
  });

  return entries.filter((e) => e.milestones.length > 0);
}

// ===========================================================================
// Multi-project overview — the data behind GET /api/projects
// ===========================================================================

export interface TopMilestoneSession {
  id: SessionId;
  startedAt: string;
  endedAt?: string;
  outcome?: SessionOutcome;
  summary?: string;        // outcome.summary preferred, falls back to session.summary
}

export interface TopMilestone {
  id: MilestoneId;
  name: string;
  state: MilestoneState;
  feature: string;         // feature name
  lastSession: TopMilestoneSession | null;
}

export interface ProjectListSummary {
  // identity (from registry)
  slug: string;
  path: string;
  addedAt: string;
  // identity (from the project's own Store; null if .stele/ has no Project row)
  id: ProjectId | null;
  name: string;            // falls back to slug if no Project row
  code?: string;
  status: ProjectStatus | null;
  // counts
  openLoops: number;
  dueLoops: number;
  needsCheck: number;      // open/deferred decisions whose revisit trigger fired
  featureCount: number;
  milestonesByState: Record<MilestoneState, number>;
  decisionCount: number;
  // recency
  lastActivity: string | null;
  // headline milestone for the global resume strip + per-card preview
  topMilestone: TopMilestone | null;
  // edge cases
  missing?: boolean;       // .stele/decisions.db absent or unopenable
}

/**
 * For each registered project, walk its Store and compose the row that the
 * Projects overview page needs. Multi-tenant only — single-project mode
 * never hits this. The caller (serve.ts:handleProjects) is responsible for
 * supplying the resolved {entry, store} pairs; we don't open Stores here.
 */
export function projectListSummary(
  rows: Array<{ entry: ProjectEntry; store: Store | null; needsCheck?: number }>,
): ProjectListSummary[] {
  return rows.map(({ entry, store, needsCheck = 0 }) => {
    if (!store) {
      return {
        slug: entry.slug,
        path: entry.path,
        addedAt: entry.addedAt,
        id: null,
        name: entry.slug,
        status: null,
        openLoops: 0,
        dueLoops: 0,
        needsCheck: 0,
        featureCount: 0,
        milestonesByState: { draft: 0, going: 0, winding: 0, done: 0, paused: 0 },
        decisionCount: 0,
        lastActivity: null,
        topMilestone: null,
        missing: true,
      };
    }

    const projects = store.allProjects();
    const project = projects[0] ?? null;
    if (!project) {
      // .stele/decisions.db exists but no Project row yet — `stele init` was
      // run but no decision has been captured. Surface enough to render a
      // bare card.
      return {
        slug: entry.slug,
        path: entry.path,
        addedAt: entry.addedAt,
        id: null,
        name: entry.slug,
        status: null,
        openLoops: 0,
        dueLoops: 0,
        needsCheck: 0,
        featureCount: 0,
        milestonesByState: { draft: 0, going: 0, winding: 0, done: 0, paused: 0 },
        decisionCount: 0,
        lastActivity: null,
        topMilestone: null,
      };
    }

    const rollup = projectRollup(store, project.id);
    if (!rollup) {
      // unreachable — getProject returned non-null
      return {
        slug: entry.slug,
        path: entry.path,
        addedAt: entry.addedAt,
        id: project.id,
        name: project.name,
        code: project.code,
        status: project.status,
        openLoops: 0,
        dueLoops: 0,
        needsCheck: 0,
        featureCount: 0,
        milestonesByState: { draft: 0, going: 0, winding: 0, done: 0, paused: 0 },
        decisionCount: 0,
        lastActivity: null,
        topMilestone: null,
      };
    }

    // Find the most-recent session across the project's milestones.
    const features = store.featuresIn(project.id);
    const featureById = new Map<string, Feature>(features.map((f) => [f.id, f]));
    const milestones = store
      .allMilestones()
      .filter((m) => featureById.has(m.featureId));

    let top: TopMilestone | null = null;
    let topStartedAt = "";
    for (const m of milestones) {
      const sessions = store.sessionsInMilestone(m.id);
      // sessionsInMilestone returns ascending by startedAt (per Store)
      const last = sessions[sessions.length - 1];
      if (!last) continue;
      if (last.startedAt > topStartedAt) {
        topStartedAt = last.startedAt;
        top = {
          id: m.id,
          name: m.name,
          state: m.state,
          feature: featureById.get(m.featureId)?.name ?? "",
          lastSession: {
            id: last.id,
            startedAt: last.startedAt,
            endedAt: last.endedAt,
            outcome: last.outcome,
            summary: last.outcome?.summary ?? last.summary,
          },
        };
      }
    }

    return {
      slug: entry.slug,
      path: entry.path,
      addedAt: entry.addedAt,
      id: project.id,
      name: project.name,
      code: project.code,
      status: project.status,
      openLoops: rollup.openLoops,
      dueLoops: rollup.dueLoops,
      needsCheck,
      featureCount: features.length,
      milestonesByState: rollup.milestonesByState,
      decisionCount: rollup.decisionCount,
      lastActivity: rollup.lastActivity,
      topMilestone: top,
    };
  });
}

// ===========================================================================
// Decision graph slice — interactive Decision Graph page
// ===========================================================================

export type GraphNodeState =
  | "decided" | "deferred" | "resolved" | "superseded" | "open" | "conflicted";

export interface GraphSliceNode {
  id: DecisionId;
  title: string;
  type: DecisionType;
  state: GraphNodeState;
  milestoneId: MilestoneId;
  featureId?: FeatureId;
  sessionId?: SessionId;
  tags: Array<{ id: string; name: string; color: string }>;
}

export interface GraphSliceEdge {
  from: DecisionId;
  to: DecisionId;
  relation: EdgeRelation;
  note?: string;
}

export interface GraphSliceFeature {
  id: FeatureId;
  name: string;
}

export interface GraphSliceMilestone {
  id: MilestoneId;
  name: string;
  state: MilestoneState;
  featureId: FeatureId;
}

export interface GraphSlice {
  nodes: GraphSliceNode[];
  edges: GraphSliceEdge[];
  // Pivot data for the UI's filter pills (always returns the full set so
  // the user can broaden the filter without a second round-trip).
  features: GraphSliceFeature[];
  milestones: GraphSliceMilestone[];
}

export interface GraphSliceFilter {
  feature?: FeatureId;
  milestone?: MilestoneId;
  tag?: string;     // tag id OR tag name (case-insensitive)
}

/**
 * Return the decision graph as `{nodes, edges}` plus the feature + milestone
 * pivot lists. Filters narrow the scope (feature, milestone, tag) but
 * pivots remain global so the UI can switch filters without a refetch.
 */
export function graphSlice(store: Store, filter?: GraphSliceFilter): GraphSlice {
  const projects = store.allProjects();
  const project = projects[0];
  if (!project) {
    return { nodes: [], edges: [], features: [], milestones: [] };
  }

  // Pivots — always full project scope.
  const features = store.featuresIn(project.id);
  const featureIds = new Set(features.map((f) => f.id));
  const allMilestones = store.allMilestones().filter((m) => featureIds.has(m.featureId));

  // Apply filter to scope which milestones / decisions land in the slice.
  let scopedMilestones = allMilestones;
  if (filter?.feature) {
    scopedMilestones = scopedMilestones.filter((m) => m.featureId === filter.feature);
  }
  if (filter?.milestone) {
    scopedMilestones = scopedMilestones.filter((m) => m.id === filter.milestone);
  }
  const milestoneById = new Map(scopedMilestones.map((m) => [m.id, m]));

  let decisions = store
    .allDecisions()
    .filter((d) => milestoneById.has(d.milestoneId));

  // Tag filter is decision-level
  if (filter?.tag) {
    const tag = store.getTag(filter.tag) ?? store.findTagByName(filter.tag);
    if (!tag) {
      return {
        nodes: [],
        edges: [],
        features: features.map((f) => ({ id: f.id, name: f.name })),
        milestones: allMilestones.map((m) => ({
          id: m.id, name: m.name, state: m.state, featureId: m.featureId,
        })),
      };
    }
    const taggedDecisionIds = new Set(
      store
        .targetsForTag(tag.id)
        .filter((t) => t.kind === "decision")
        .map((t) => t.id),
    );
    decisions = decisions.filter((d) => taggedDecisionIds.has(d.id));
  }

  const nodeIdSet = new Set(decisions.map((d) => d.id));

  const nodes: GraphSliceNode[] = decisions.map((d) => {
    const m = milestoneById.get(d.milestoneId);
    return {
      id: d.id,
      title: d.title,
      type: d.type,
      state: nodeState(d) as GraphNodeState,
      milestoneId: d.milestoneId,
      featureId: m?.featureId,
      sessionId: d.sessionId,
      tags: store.taggingsForTarget("decision", d.id).map((t) => ({
        id: t.id, name: t.name, color: t.color,
      })),
    };
  });

  // Collect edges where both ends survived the filter. edgesFrom(d.id)
  // iterates from one side so we see each edge exactly once.
  const edges: GraphSliceEdge[] = [];
  for (const d of decisions) {
    for (const e of store.edgesFrom(d.id)) {
      if (nodeIdSet.has(e.to)) {
        edges.push({
          from: e.from,
          to: e.to,
          relation: e.relation,
          note: e.note,
        });
      }
    }
  }

  return {
    nodes,
    edges,
    features: features.map((f) => ({ id: f.id, name: f.name })),
    milestones: allMilestones.map((m) => ({
      id: m.id, name: m.name, state: m.state, featureId: m.featureId,
    })),
  };
}
