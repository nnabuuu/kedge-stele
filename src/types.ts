// ---------------------------------------------------------------------------
// 实录 / Stele · domain model (0.3.0 schema source of truth)
//
// The store holds a graph. Nodes are `Decision` records; edges (typed by
// `relation`) connect them. Every projection (resume / trace / feature
// timeline / by-tag) is a LIVE query over this graph — we never cache the
// rendered view. Adding a `resolves` edge today retroactively updates how
// a three-week-old report renders, because the report re-queries the live
// node.
//
// Layering (0.3.0+): Project → Feature → Session → Decision,
// with Tag and the Edge graph cutting across.
//
// Breaking changes from 0.2.x:
//   • Schema collapses one layer. The old umbrella `Feature` (CcaaS / Live
//     Lesson) is removed; its naming becomes a tag. The old `Milestone`
//     becomes the new `Feature`, carrying state (5-state), `about`, dates,
//     and a NEW rolling `summary` written by `/stele:feature`.
//   • Session loses `outcome` and `pauseReason` (legacy types remain for
//     one release while phase 3 removes the MCP tools that wrote them).
//   • Decision FK renamed: `milestoneId` → `featureId`. id format stays
//     `<featureId>/<local>`.
//   • Tag target kind: `'milestone' | 'decision'` → `'feature' | 'decision'`.
//
// IntentDelta stays deferred-but-on-purpose (no bundle layer yet).
// ---------------------------------------------------------------------------

// ---- Primitive ids --------------------------------------------------------

export type ProjectId = string;       // "P-<short>", e.g. "P-01"
export type FeatureId = string;       // "F-<NN>" (was MilestoneId in 0.2.x)
export type SessionId = string;       // "ses-<short hash>"
export type DecisionId = string;      // "<featureId>/<local>" e.g. "F-01/D-04"
export type TagId = string;           // "tag-<short hash>"

export type BundleVersion = string;
export type BundlePath = string;      // addressable path inside an intent bundle

// The ONLY coupling point to an external ontology. In the POC it stays
// opaque: affects edges carry an EntityRef, and a (stub) EntityResolver
// hydrates it. Swap the resolver for a real one later; nothing upstream moves.
export type EntityRef = { kind: string; id: string };

// ---- IntentDelta — deferred-but-on-purpose --------------------------------
// Stored, never folded into an effective bundle, never conflict-checked.
// Needs a bundle layer the POC omits. Don't add fold/conflict logic without
// that layer.
export type IntentDelta = {
  baseVersion: BundleVersion;
  patches: { path: BundlePath; op: "set" | "add" | "remove"; value?: unknown }[];
};

// ---- Governance + ambient identity ---------------------------------------

export type GovLayer = "district" | "school" | "personal";

// ===========================================================================
// Project
// ===========================================================================
//
// Was 0.0.7: registry.json {slug, path, addedAt} only.
// 0.1.0+: a real DB row per cwd with status + display fields.
// ---------------------------------------------------------------------------

export type ProjectStatus = "active" | "winding" | "dormant" | "archived";

export interface Project {
  id: ProjectId;
  name: string;                // display name, e.g. "即见 Jijian"
  code?: string;               // short uppercase tag, e.g. "MONOREPO"
  path: string;                // repo root / cwd
  status: ProjectStatus;
  createdAt: string;           // ISO
}

// ===========================================================================
// Feature  (0.3.0 — was Milestone; now a direct child of Project)
// ===========================================================================
//
// • `draft`   — opened, no captured work yet
// • `going`   — active work in progress
// • `winding` — wrapping up, mostly done
// • `done`    — shipped / closed successfully
// • `paused`  — explicitly halted, pickup later
//
// `sequenceAfter` carries feature ids that came before this one — the
// design's "推进顺序前驱". Used by the Project page to draw arrows.
// `summary` is the rolling text written by /stele:feature on each call —
// replace, not append.
// ---------------------------------------------------------------------------

export type FeatureState = "draft" | "going" | "winding" | "done" | "paused";

export interface Feature {
  id: FeatureId;
  projectId: ProjectId;        // direct child of Project (no umbrella layer)
  name: string;                // "Binary artifact + SSE auth"
  state: FeatureState;
  about?: string;              // one-line context / core problem
  summary?: string;            // rolling, replaced on each /stele:feature call
  sequenceAfter?: FeatureId[];
  startedAt: string;
  completedAt?: string;        // set when state moves to `done`
}

// ===========================================================================
// Session  (provenance only — no agent-managed lifecycle in 0.3.0)
// ===========================================================================

export type SessionSource =
  | "claude-code"
  | "codex"
  | "opencode"
  | "cursor"
  | "manual"
  | "unknown";

// Provenance — historically decided whether `resume_command` returned a
// "jump" (zellij layout still alive) or a "rebuild". 0.3.0 dropped that
// MCP tool, but the shape stays useful as capture-time metadata.
export interface SessionProvenance {
  cwd: string;
  zellijSession?: string;
  zellijTab?: string;
  zellijPane?: string;
  layoutAlive: boolean;
}

// LEGACY (kept for one release while old data + capture paths drain).
// 0.3.0's agent-facing surface no longer reflects per-session — there is
// no `session_end` MCP tool. These types remain so existing rows can be
// decoded without a migration; new captures should not produce them.
export type SessionOutcomeType = "advanced" | "resolved" | "touched";

export interface SessionOutcome {
  type: SessionOutcomeType;
  summary?: string;
  resolves?: DecisionId[];
  via?: DecisionId;
}

export type PauseReasonKind =
  | "blocked"
  | "waiting_dep"
  | "out_of_time"
  | "lost_thread"
  | "done_enough"
  | "other";

export interface PauseReason {
  kind: PauseReasonKind;
  note?: string;
}

export interface Session {
  id: SessionId;
  featureId: FeatureId;        // (was milestoneId in 0.2.x)
  source: SessionSource;
  // For source="claude-code" this is the cc_session_id used by `claude --resume`.
  // Persisted so jumpback always has it available.
  sourceSessionId?: string;
  startedAt: string;
  endedAt?: string;
  provenance?: SessionProvenance;
  // LEGACY — populated only on rows captured before 0.3.0.
  outcome?: SessionOutcome;
  pauseReason?: PauseReason;
  summary?: string;            // legacy free-text — superseded by outcome.summary
}

// ===========================================================================
// Decision  (split shape + rich detail)
// ===========================================================================
//
// 0.1.0 split the discriminant into separate columns:
//
//   type            kind of node:      decision | deferred | open
//   status          resolution state:  null (for type='decision') | open | resolved
//   resolvedBy      who closed it      (when status='resolved')
//   supersededBy    who replaced it    (decisions only)
//
// nodeState (derived at projection time, not stored):
//   type='decision' && !supersededBy           → "decided"
//   type='decision' && supersededBy            → "superseded"
//   type='deferred' && status!='resolved'      → "deferred"
//   type='open'     && status!='resolved'      → "open"
//   (deferred|open) && status='resolved'       → "resolved"
//   conflicted                                  → "conflicted" (reserved; not produced)
// ---------------------------------------------------------------------------

export type DecisionType = "decision" | "deferred" | "open";

// nullable for type='decision'
export type DecisionResolutionStatus = "open" | "resolved";

export type Verdict = "chosen" | "rejected";

export interface DecisionOption {
  name: string;                // "Approach A", "SQLite", ...
  desc?: string;               // one-line description
  verdict: Verdict;
  why?: string;                // why chosen / why rejected
  chosen?: boolean;            // convenience flag (== verdict==='chosen')
}

export interface DecisionLocks {
  in?: string;                 // what this decision locks IN — what gets cheap/easy
  out?: string;                // what it locks OUT — what becomes expensive
}

export interface DecisionArtifact {
  file?: string;
  commit?: string;
}

// The rich body. Required when type='decision' (a real choice was made).
// Optional for deferred/open (they're often just questions waiting on a trigger).
export interface DecisionDetail {
  optionAxis?: string;         // e.g. "Approach", "Storage backend"
  trigger?: string;            // prose surfacing — "the thing that surfaced this"
  constraint?: string;         // the hard limit that made the choice non-obvious
  options?: DecisionOption[];  // weighed alternatives
  why?: string[];              // free-text rationale paragraphs
  locks?: DecisionLocks;
  artifact?: DecisionArtifact; // primary artifact (file/commit) tied to the decision
}

// Revisit is the trigger that makes a deferred decision come due. Structured
// so the projection layer can compute `due` deterministically without scanning
// prose. Free-text triggers are invisible to resume — never accept them.
export type Trigger =
  | { kind: "manual" }
  | { kind: "metric"; expr: string }      // e.g. "schools > 50"
  | { kind: "event"; name: string }       // e.g. "first solution delete flow ships"
  | { kind: "dependency"; on: DecisionId }; // due when `on` reaches decided/resolved

export interface Revisit {
  trigger: Trigger;
  cond?: string;               // optional human description of the trigger condition
}

// 0.4.0 — provenance of the capture path. Lets the UI distinguish
// machine-extracted nodes from human-/agent-authored ones so review can be
// batched. Default 'manual' for legacy rows (the column is nullable, so
// pre-0.4 captures decode unchanged).
export type DecisionSource =
  | "manual"          // human-authored — seed.ts, CLI add, web capture form
  | "agent-live"      // live agent in-flight via standing instruction (Stop hook directive)
  | "session-extract"; // hook-spawned subagent post-hoc over the transcript

export interface Decision {
  id: DecisionId;              // `<featureId>/<local>` (e.g. `F-01/D-04`)
  featureId: FeatureId;        // FK — required; "unscoped/<local>" decisions go under the auto-created unscoped feature
  sessionId?: SessionId;       // FK to the producing session (may be absent for seeded/manual)
  type: DecisionType;
  status?: DecisionResolutionStatus;  // null for type='decision'; 'open'|'resolved' for deferred/open
  resolvedBy?: DecisionId;     // when status='resolved'
  supersededBy?: DecisionId;   // type='decision' that's been replaced
  title: string;               // phrase as a question for type='deferred'/'open'
  scope?: string;              // Runtime / Backend / Design / Security ...
  raisedBy: {
    trigger: string;           // prose surface — "what conversation move triggered this"
    actor: string;             // ambient identity
    layer: GovLayer;
    at: string;                // ISO timestamp
  };
  revisit?: Revisit;           // structured re-trigger for deferred/open
  detail?: DecisionDetail;     // rich body; required when type='decision'
  affects: EntityRef[];
  artifacts?: { file: string; commit?: string }[];  // legacy top-level — prefer detail.artifact
  sourceReport?: string;       // provenance of seeded records (HTML report path)
  // 0.4.0 — capture provenance + dedup. `source` defaults to 'manual' when omitted;
  // `confidence` is only meaningful when source !== 'manual'.
  source?: DecisionSource;
  confidence?: number;         // 0..1
  // `dedupKey` is computed by Store.putDecision from (featureId, title, affects);
  // never set by callers. UNIQUE in DDL — second write with same key returns a
  // skipped-duplicate marker instead of inserting.
  dedupKey?: string;
  createdAt: string;
}

// ===========================================================================
// Edge  (relation rename + depends_on)
// ===========================================================================

export type EdgeRelation =
  | "resolves"      // source closes target — flips target.status='resolved'
  | "supersedes"    // source replaces target — flips target.supersededBy=source.id
  | "reconciles"    // non-mutating
  | "relates"       // non-mutating
  | "depends_on";   // source needs target — non-mutating; drives revisit `dependency` triggers

export interface Edge {
  from: DecisionId;
  to: DecisionId;
  relation: EdgeRelation;
  note?: string;
}

// ===========================================================================
// Tags  (carried over from 0.0.7 unchanged except for target-kind rename)
// ===========================================================================

export type TagOrigin = "you" | "agent";
export type TagStatus = "active" | "archived";

export interface Tag {
  id: TagId;
  name: string;                // unique COLLATE NOCASE in the store
  color: string;               // hex, e.g. "#942929"
  kind?: string;               // default "scope"
  origin: TagOrigin;
  status: TagStatus;
  createdAt: string;
}

export type TaggingTargetKind = "feature" | "decision";  // (was 'milestone' in 0.2.x)

export interface Tagging {
  tagId: TagId;
  targetKind: TaggingTargetKind;
  targetId: string;
}

export type ProposalOutcome = "pending" | "blocked" | "auto_adopted";

export interface TagProposal {
  id: string;                  // "tp-<short hash>"
  name: string;
  suggestedColor?: string;
  reason?: string;
  targets: { kind: TaggingTargetKind; id: string }[];
  outcome: ProposalOutcome;
  createdAt: string;
}

export type TagPolicy = "auto" | "propose" | "locked";

export interface CaptureTagRequest {
  name: string;
  reason?: string;
  suggestedColor?: string;
}

// ===========================================================================
// CapturePayload — the on-the-wire shape decision_capture sends to the MCP server
// ===========================================================================
//
// `unscoped` is the back-compat escape hatch — the conversation genuinely
// isn't goal-targeted. Resolves to the auto-created unscoped Feature.
// ---------------------------------------------------------------------------

export type CaptureFeatureMode =     // (was CaptureMilestoneMode in 0.2.x)
  | { mode: "continue"; id: FeatureId }
  | { mode: "new"; draft: { name: string; about?: string } }
  | { mode: "unscoped" };

export interface CaptureSourceSession {
  source: SessionSource;
  sourceSessionId?: string;
}

export interface CapturePayload {
  decision: Decision;
  edges?: Edge[];
  feature?: CaptureFeatureMode;      // (was milestone in 0.2.x)
  sourceSession?: CaptureSourceSession;
  // Skip feature wiring entirely and bind the decision to an already-open session.
  sessionId?: SessionId;
  tags?: CaptureTagRequest[];
  // 0.4.0 — top-level mirrors of the same fields on Decision. Live the live
  // agent + the SessionEnd extract subagent set these on the payload; the MCP
  // handler folds them into the persisted Decision so callers don't have to
  // remember to set both.
  source?: DecisionSource;
  confidence?: number;
}

// ===========================================================================
// LEGACY shapes — used by code that hasn't been deleted yet (phase 3+)
// ===========================================================================
// These exist to keep 0.3.0-snapshot.1 compilable. Phase 3 removes the MCP
// tools that produce them; phase 4 removes the templates that emit them.

export interface FeatureReportDraft {            // (was MilestoneReportDraft)
  featureId: FeatureId;
  summary: string;
  resumeEdge?: string;
  suggestedPauseReason?: PauseReason;
  openLoops: { id: DecisionId; title: string; type: DecisionType }[];
  nextStateSuggestion?: FeatureState;
}

export type ResumeMode = "jump" | "rebuild";

export interface ResumeCommandResult {
  mode: ResumeMode;
  command: string;
  // false when the id isn't a real resumable cc session (e.g. a /stele:scan
  // composite "<uuid>#F-01") — the command is shown but not advertised as runnable.
  copyable: boolean;
  lastSession?: {
    id: SessionId;
    endedAt?: string;
    outcome?: SessionOutcome;
    pauseReason?: PauseReason;
  };
}
