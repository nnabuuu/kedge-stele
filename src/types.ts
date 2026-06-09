// ---------------------------------------------------------------------------
// 实录 / Stele · domain model (0.1.0-snapshot schema source of truth)
//
// The store holds a graph. Nodes are `Decision` records; edges (typed by
// `relation`) connect them. Every projection (resume / trace / milestone
// timeline / by-tag) is a LIVE query over this graph — we never cache the
// rendered view. Adding a `resolves` edge today retroactively updates how
// a three-week-old report renders, because the report re-queries the live
// node.
//
// Layering (0.1.0+): Project → Feature → Milestone → Session → Decision,
// with Tag and the Edge graph cutting across.
//
// Breaking changes from 0.0.7 (see CHANGELOG):
//   • Decision.Status discriminated union is GONE.  Replaced by separate
//     `type` + `status` + `resolvedBy` + `supersededBy` columns; rich body
//     moves into `detail`.
//   • Decision id format: `<milestone>/<local>` (e.g. `M-01/D-04`), not
//     `D-NN`/`DEF-NN`/`OQ-NN`.
//   • Edge field rename: `kind` → `relation`.  `depends_on` joins the
//     edge-relation enum.
//   • Milestone status (3 states) → state (5 states); adds `about`,
//     `sequenceAfter`, `featureId`.
//   • Session gains `provenance`, `outcome` (typed), `pauseReason`.
//   • Project becomes a first-class DB row (was registry-only).
//   • Feature is new (between Project and Milestone).
//
// IntentDelta stays deferred-but-on-purpose (no bundle layer yet).
// ---------------------------------------------------------------------------

// ---- Primitive ids --------------------------------------------------------

export type ProjectId = string;       // "P-<short>", e.g. "P-01"
export type FeatureId = string;       // "F-<NN>"
export type MilestoneId = string;     // "M-<NN>"
export type SessionId = string;       // "ses-<short hash>"
export type DecisionId = string;      // "<milestoneId>/<local>" e.g. "M-01/D-04"
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
// Now (0.1.0): a real DB row per cwd with status + display fields.
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
// Feature  (new in 0.1.0 — the structural axis between project and milestone)
// ===========================================================================

export type FeatureLinkRelation = "depends-on" | "depended-on-by";
export interface FeatureLink {
  to: FeatureId;
  relation: FeatureLinkRelation;
}

export interface Feature {
  id: FeatureId;
  projectId: ProjectId;
  name: string;                // "CcaaS", "Live Lesson", "Skill Registry"
  links?: FeatureLink[];       // wiring between features; usually edited later
}

// ===========================================================================
// Milestone  (revised: 5-state, `about`, `sequenceAfter`, mandatory featureId)
// ===========================================================================
//
// • `draft`   — opened, no captured work yet
// • `going`   — active work in progress
// • `winding` — wrapping up, mostly done
// • `done`    — shipped / closed successfully
// • `paused`  — explicitly halted, pickup later
//
// `sequenceAfter` carries milestone ids that came before this one — the
// design's "推进顺序前驱". Used by the Project page to draw arrows.
// ---------------------------------------------------------------------------

export type MilestoneState = "draft" | "going" | "winding" | "done" | "paused";

export interface Milestone {
  id: MilestoneId;
  featureId: FeatureId;        // FK — required (use the auto-created "unscoped" feature when none fits)
  name: string;                // "Binary artifact + SSE auth"
  state: MilestoneState;
  about?: string;              // one-line context / core problem
  sequenceAfter?: MilestoneId[];
  startedAt: string;
  completedAt?: string;        // set when state moves to `done`
}

// ===========================================================================
// Session  (gains provenance + typed outcome + pause_reason)
// ===========================================================================

export type SessionSource =
  | "claude-code"
  | "codex"
  | "opencode"
  | "cursor"
  | "manual"
  | "unknown";

// Provenance — decides whether `resume_command` returns a "jump" (zellij
// layout still alive) or a "rebuild" (use `claude --resume` to reanimate
// the cc_session_id under a fresh shell).
export interface SessionProvenance {
  cwd: string;
  zellijSession?: string;
  zellijTab?: string;
  zellijPane?: string;
  layoutAlive: boolean;
}

// outcome.type:
//   "advanced" — pushed the milestone forward
//   "resolved" — closed an open/deferred loop (write `resolves` + `via`)
//   "touched"  — minor cleanup, doesn't move the needle
export type SessionOutcomeType = "advanced" | "resolved" | "touched";

export interface SessionOutcome {
  type: SessionOutcomeType;
  summary?: string;
  resolves?: DecisionId[];     // ids closed this session
  via?: DecisionId;            // the decision that did the closing
}

// pause_reason — the "走之前留话" half. `kind` is structured so the resume
// flow can render the right re-entry prompt; `note` is the freeform anchor.
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
  milestoneId: MilestoneId;
  source: SessionSource;
  // For source="claude-code" this is the cc_session_id used by `claude --resume`.
  // Persisted so jumpback always has it available.
  sourceSessionId?: string;
  startedAt: string;
  endedAt?: string;
  provenance?: SessionProvenance;
  outcome?: SessionOutcome;
  pauseReason?: PauseReason;
  summary?: string;            // legacy free-text — superseded by outcome.summary
}

// ===========================================================================
// Decision  (the big rewrite — split shape + rich detail)
// ===========================================================================
//
// Old 0.0.7 used a discriminated `Status` union with six kinds. 0.1.0 splits
// the discriminant into separate columns:
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
//   conflicted                                  → "conflicted" (reserved; not produced in 0.1.0)
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

export interface Decision {
  id: DecisionId;              // `<milestoneId>/<local>` (e.g. `M-01/D-04`)
  milestoneId: MilestoneId;    // FK — required; "unscoped/<local>" decisions go under the auto-created unscoped milestone
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
// Tags  (carried over from 0.0.7 unchanged)
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

export type TaggingTargetKind = "milestone" | "decision";

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
// CapturePayload — the on-the-wire shape /decision sends to the MCP server
// ===========================================================================
//
// Grew through 0.0.6 (milestone + sourceSession), 0.0.7 (tags), and now
// 0.1.0 (richer milestone-mode that can also open a feature, optional
// explicit sessionId from a prior session_start, and the new Decision shape).
// ---------------------------------------------------------------------------

// `unscoped` is the back-compat escape hatch — the conversation genuinely
// isn't goal-targeted. Resolves to the auto-created unscoped milestone (which
// itself lives under the auto-created unscoped feature).
export type CaptureMilestoneMode =
  | { mode: "continue"; id: MilestoneId }
  | { mode: "new"; draft: { name: string; about?: string; featureId?: FeatureId; featureDraft?: { name: string } } }
  | { mode: "unscoped" };

export interface CaptureSourceSession {
  source: SessionSource;
  sourceSessionId?: string;
}

export interface CapturePayload {
  decision: Decision;
  edges?: Edge[];
  milestone?: CaptureMilestoneMode;
  sourceSession?: CaptureSourceSession;
  // Skip milestone wiring entirely and bind the decision to an already-open session.
  // Used when `session_start` was called explicitly first.
  sessionId?: SessionId;
  tags?: CaptureTagRequest[];
}

// ===========================================================================
// Milestone report  (走之前留话 — the /milestone-report flow's draft round-trip)
// ===========================================================================

export interface MilestoneReportDraft {
  milestoneId: MilestoneId;
  summary: string;                            // "this session pushed X forward"
  resumeEdge?: string;                        // "next pickup point"
  suggestedPauseReason?: PauseReason;
  openLoops: { id: DecisionId; title: string; type: DecisionType }[];
  // Optional state nudge — "winding" when the agent thinks we're wrapping up.
  // User confirms before session_end applies it.
  nextStateSuggestion?: MilestoneState;
}

// ===========================================================================
// Resume command  (回来时念回来 — the /resume flow's machine-readable result)
// ===========================================================================

export type ResumeMode = "jump" | "rebuild";

export interface ResumeCommandResult {
  mode: ResumeMode;
  command: string;                            // copy-paste ready
  copyable: true;
  // Last-session context so the agent can read it back to the user
  lastSession?: {
    id: SessionId;
    endedAt?: string;
    outcome?: SessionOutcome;
    pauseReason?: PauseReason;
  };
}
