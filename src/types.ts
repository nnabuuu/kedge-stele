// ---------------------------------------------------------------------------
// The decision model. This is the store's source of truth.
//
// A `feature report` is NOT stored. It is one *projection* of this graph.
// The atom is the decision node; features/reports are queries over nodes+edges.
// ---------------------------------------------------------------------------

export type DecisionId = string;
export type BundleVersion = string;
export type BundlePath = string; // addressable path inside an intent bundle

// The ONLY coupling point to kedge-ontology. In the POC it stays opaque:
// affects edges carry an EntityRef, and a (stub) EntityResolver hydrates it.
// Swap the resolver for KedgeOntologyResolver later and nothing upstream moves.
export type EntityRef = { kind: string; id: string };

// A decision binds a *delta* to a bundle version, not a snapshot.
// In the POC this is captured-but-inert: stored, never folded, never conflict-checked.
export type IntentDelta = {
  baseVersion: BundleVersion;
  patches: { path: BundlePath; op: "set" | "add" | "remove"; value?: unknown }[];
};

// revisitWhen must be structured, not free text — otherwise the consolidate
// layer can never know a deferred decision's trigger has fired.
export type Trigger =
  | { kind: "manual" }
  | { kind: "metric"; expr: string }        // e.g. "schools > 50"
  | { kind: "event"; name: string }         // e.g. "first solution delete flow ships"
  | { kind: "dependency"; on: DecisionId };

export type Verdict = "chosen" | "rejected";
export type Option = { label: string; summary: string; verdict: Verdict; why?: string };

export type GovLayer = "district" | "school" | "personal"; // 区级 / 学校级 / 个人级

export type Status =
  | { kind: "open"; question: string }
  | { kind: "decided"; options: Option[]; rationale: string; delta?: IntentDelta }
  | { kind: "deferred"; current: string; reason: string; revisitWhen: Trigger; draftDelta?: IntentDelta }
  | { kind: "superseded"; by: DecisionId }
  | { kind: "resolved"; by: DecisionId }                              // a deferred/open node a later decision answered
  | { kind: "conflicted"; between: DecisionId[]; path: BundlePath };  // typed state; lands in the backlog automatically

export type StatusKind = Status["kind"];

export interface Decision {
  id: DecisionId;
  title: string;                 // phrased as a question
  scope?: string;                // Runtime / Backend / Design / Security ...
  raisedBy: {
    trigger: string;             // what surfaced this, in prose
    actor: string;               // ambient identity, not a parameter
    layer: GovLayer;
    session?: string;            // legacy free-text — kept for seeded/pre-0.0.6 data
    at: string;                  // ISO timestamp
  };
  constraint?: string;           // the hard thing that made the choice non-obvious
  status: Status;
  consequences?: { lockedIn?: string; lockedOut?: string };
  affects: EntityRef[];
  artifacts?: { file: string; commit?: string }[];
  sourceReport?: string;         // provenance of the provenance: which report/session it came from
  sessionId?: SessionId;         // 0.0.6+: ties to a Session, which ties to a Milestone
}

export type EdgeKind = "resolves" | "supersedes" | "reconciles" | "relates";
export interface Edge {
  from: DecisionId;
  to: DecisionId;
  kind: EdgeKind;
  note?: string;
}

// ---------------------------------------------------------------------------
// Milestone + Session — added 0.0.6.
//
// A Milestone is an aspirational unit ("ship the multi-tenant daemon"). It
// groups one or more Sessions. A Session is a single tool-conversation
// (one Claude Code session, one Codex run, etc.) that produced one or more
// Decisions. The skill decides at capture time whether a new decision lives
// in an existing Milestone or starts a new one.
// ---------------------------------------------------------------------------

export type MilestoneId = string;  // "M-01", "M-02", ...
export type SessionId = string;    // "ses-<short hash>"

export type MilestoneStatus = "active" | "shipped" | "abandoned";

export interface Milestone {
  id: MilestoneId;
  title: string;
  intent?: string;               // longer "we want X because Y"
  status: MilestoneStatus;
  startedAt: string;             // ISO
  completedAt?: string;
}

export type SessionSource =
  | "claude-code"
  | "codex"
  | "opencode"
  | "cursor"
  | "manual"
  | "unknown";

export interface Session {
  id: SessionId;
  milestoneId: MilestoneId;
  source: SessionSource;
  sourceSessionId?: string;      // the tool's native session id; lets us dedupe
  startedAt: string;
  endedAt?: string;
  summary?: string;              // one-liner the agent writes when wrapping
}

// ---------------------------------------------------------------------------
// CapturePayload — what the agent sends on /decision or the skill-triggered
// capture path. Grew the milestone + sourceSession fields in 0.0.6 so the
// skill can express its new-vs-continue judgment in one round-trip.
// ---------------------------------------------------------------------------

// The skill's milestone judgment. `unscoped` is the back-compat / exploration
// escape hatch — when the conversation genuinely isn't targeted at a goal.
export type CaptureMilestoneMode =
  | { mode: "continue"; id: MilestoneId }
  | { mode: "new"; draft: { title: string; intent?: string } }
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
  // 0.0.7+: tag the new decision. Each runs through ensureTag (auto/propose/
  // locked) per the local tag_policy config. Existing active tags get
  // applied immediately; new names go through proposal queue or are rejected.
  tags?: CaptureTagRequest[];
}

// ---------------------------------------------------------------------------
// Tag system — added 0.0.7.
//
// Tag is a cross-cutting classification, attachable to milestones AND
// decisions (many-to-many via Tagging). Whether the agent can create new
// tags freely is controlled by the per-store tag_policy config:
//   - auto:    agent can create directly (origin: "agent", status: "active")
//   - propose: agent's new-tag attempts queue into TagProposal (default)
//   - locked:  agent can't create at all; attempts logged as outcome:"blocked"
// ---------------------------------------------------------------------------

export type TagId = string;            // "tag-<short hash>"
export type TagOrigin = "you" | "agent";
export type TagStatus = "active" | "archived";

export interface Tag {
  id: TagId;
  name: string;                        // unique COLLATE NOCASE in the store
  color: string;                       // hex, e.g. "#942929"
  kind?: string;                       // default "scope"
  origin: TagOrigin;
  status: TagStatus;
  createdAt: string;
}

export type TaggingTargetKind = "milestone" | "decision";

export interface Tagging {
  tagId: TagId;
  targetKind: TaggingTargetKind;
  targetId: string;                    // milestone id or decision id
}

export type ProposalOutcome = "pending" | "blocked" | "auto_adopted";

export interface TagProposal {
  id: string;                          // "tp-<short hash>"
  name: string;
  suggestedColor?: string;
  reason?: string;
  targets: { kind: TaggingTargetKind; id: string }[];
  outcome: ProposalOutcome;
  createdAt: string;
}

export type TagPolicy = "auto" | "propose" | "locked";

// The shape the agent sends per tag inside CapturePayload.tags[].
export interface CaptureTagRequest {
  name: string;
  reason?: string;
  suggestedColor?: string;
}
