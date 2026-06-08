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
    session?: string;
    at: string;                  // ISO timestamp
  };
  constraint?: string;           // the hard thing that made the choice non-obvious
  status: Status;
  consequences?: { lockedIn?: string; lockedOut?: string };
  affects: EntityRef[];
  artifacts?: { file: string; commit?: string }[];
  sourceReport?: string;         // provenance of the provenance: which report/session it came from
}

export type EdgeKind = "resolves" | "supersedes" | "reconciles" | "relates";
export interface Edge {
  from: DecisionId;
  to: DecisionId;
  kind: EdgeKind;
  note?: string;
}

// A capture payload: the agent drafts a decision AND proposes edges in one shot.
export interface CapturePayload {
  decision: Decision;
  edges?: Edge[];
}
