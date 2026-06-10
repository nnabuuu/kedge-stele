// Zod schemas — Strict mirror of src/types.ts (0.1.0). Shared by:
//   • mcp.ts — validates MCP tool inputs
//   • serve.ts — validates HTTP POST bodies
//
// Keep these in lockstep with types.ts. If the enum lists drift, the two
// adapters will accept payloads that the other rejects.
//
// Strictness note: leaf objects use Zod's default (extra keys dropped). The
// runtime `Store` enforces the strict TS types as a second pass on write.
import { z } from "zod";

// ===========================================================================
// Primitives
// ===========================================================================

export const EntityRefSchema = z.object({ kind: z.string(), id: z.string() });

export const GovLayerSchema = z.enum(["district", "school", "personal"]);

// ===========================================================================
// Project / Feature
// ===========================================================================

export const ProjectStatusSchema = z.enum(["active", "winding", "dormant", "archived"]);

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string().optional(),
  path: z.string(),
  status: ProjectStatusSchema,
  createdAt: z.string(),
});

export const FeatureStateSchema = z.enum(["draft", "going", "winding", "done", "paused"]);

export const FeatureSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  state: FeatureStateSchema,
  about: z.string().optional(),
  summary: z.string().optional(),
  sequenceAfter: z.array(z.string()).optional(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
});

// ===========================================================================
// Session
// ===========================================================================

export const SessionSourceSchema = z.enum([
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "manual",
  "unknown",
]);

export const SessionProvenanceSchema = z.object({
  cwd: z.string(),
  zellijSession: z.string().optional(),
  zellijTab: z.string().optional(),
  zellijPane: z.string().optional(),
  layoutAlive: z.boolean(),
});

export const SessionOutcomeTypeSchema = z.enum(["advanced", "resolved", "touched"]);

export const SessionOutcomeSchema = z.object({
  type: SessionOutcomeTypeSchema,
  summary: z.string().optional(),
  resolves: z.array(z.string()).optional(),
  via: z.string().optional(),
});

export const PauseReasonKindSchema = z.enum([
  "blocked",
  "waiting_dep",
  "out_of_time",
  "lost_thread",
  "done_enough",
  "other",
]);

export const PauseReasonSchema = z.object({
  kind: PauseReasonKindSchema,
  note: z.string().optional(),
});

export const SessionSchema = z.object({
  id: z.string(),
  featureId: z.string(),
  source: SessionSourceSchema,
  sourceSessionId: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  provenance: SessionProvenanceSchema.optional(),
  outcome: SessionOutcomeSchema.optional(),
  pauseReason: PauseReasonSchema.optional(),
  summary: z.string().optional(),
});

// ===========================================================================
// Decision  (new split shape)
// ===========================================================================

export const DecisionTypeSchema = z.enum(["decision", "deferred", "open"]);
export const DecisionResolutionStatusSchema = z.enum(["open", "resolved"]);
export const VerdictSchema = z.enum(["chosen", "rejected"]);

export const TriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }),
  z.object({ kind: z.literal("metric"), expr: z.string() }),
  z.object({ kind: z.literal("event"), name: z.string() }),
  z.object({ kind: z.literal("dependency"), on: z.string() }),
]);

export const RevisitSchema = z.object({
  trigger: TriggerSchema,
  cond: z.string().optional(),
});

export const DecisionOptionSchema = z.object({
  name: z.string(),
  desc: z.string().optional(),
  verdict: VerdictSchema,
  why: z.string().optional(),
  chosen: z.boolean().optional(),
});

export const DecisionLocksSchema = z.object({
  in: z.string().optional(),
  out: z.string().optional(),
});

export const DecisionArtifactSchema = z.object({
  file: z.string().optional(),
  commit: z.string().optional(),
});

export const DecisionDetailSchema = z.object({
  optionAxis: z.string().optional(),
  trigger: z.string().optional(),
  constraint: z.string().optional(),
  options: z.array(DecisionOptionSchema).optional(),
  why: z.array(z.string()).optional(),
  locks: DecisionLocksSchema.optional(),
  artifact: DecisionArtifactSchema.optional(),
});

export const IntentDeltaSchema = z
  .object({
    baseVersion: z.string(),
    patches: z.array(
      z.object({
        path: z.string(),
        op: z.enum(["set", "add", "remove"]),
        value: z.unknown().optional(),
      }),
    ),
  })
  .optional();

export const DecisionSchema = z
  .object({
    id: z.string(),
    featureId: z.string(),
    sessionId: z.string().optional(),
    type: DecisionTypeSchema,
    status: DecisionResolutionStatusSchema.optional(),
    resolvedBy: z.string().optional(),
    supersededBy: z.string().optional(),
    title: z.string(),
    scope: z.string().optional(),
    raisedBy: z.object({
      trigger: z.string(),
      actor: z.string(),
      layer: GovLayerSchema,
      at: z.string(),
    }),
    revisit: RevisitSchema.optional(),
    detail: DecisionDetailSchema.optional(),
    affects: z.array(EntityRefSchema),
    artifacts: z
      .array(z.object({ file: z.string(), commit: z.string().optional() }))
      .optional(),
    sourceReport: z.string().optional(),
    // 0.4.0 — capture provenance + dedup
    source: z.enum(["manual", "agent-live", "session-extract"]).optional(),
    confidence: z.number().min(0).max(1).optional(),
    dedupKey: z.string().optional(),
    createdAt: z.string(),
  })
  // Cross-field rule: type='decision' demands a detail body with options
  // OR an explicit empty options array (a no-fork decision is allowed,
  // but the agent has to assert it by passing []).
  .superRefine((d, ctx) => {
    if (d.type === "decision") {
      if (!d.detail) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "type='decision' requires `detail` (at minimum detail.options, even if empty)",
          path: ["detail"],
        });
      } else if (d.detail.options === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "type='decision' requires detail.options (pass [] to assert no real fork)",
          path: ["detail", "options"],
        });
      }
    }
    if ((d.type === "deferred" || d.type === "open") && d.status === undefined) {
      // Default reading: when omitted treat as 'open'. We don't reject, just
      // hint via store layer; the schema accepts.
    }
  });

// ===========================================================================
// Edge
// ===========================================================================

export const EdgeRelationSchema = z.enum([
  "resolves",
  "supersedes",
  "reconciles",
  "relates",
  "depends_on",
]);

export const EdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  relation: EdgeRelationSchema,
  note: z.string().optional(),
});

// ===========================================================================
// Tags  (carried over from 0.0.7 unchanged)
// ===========================================================================

export const TagOriginSchema = z.enum(["you", "agent"]);
export const TagStatusSchema = z.enum(["active", "archived"]);
export const TagPolicySchema = z.enum(["auto", "propose", "locked"]);
export const TaggingTargetKindSchema = z.enum(["feature", "decision"]);
export const ProposalOutcomeSchema = z.enum(["pending", "blocked", "auto_adopted"]);

export const TagSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "color must be #RRGGBB"),
  kind: z.string().optional(),
  origin: TagOriginSchema,
  status: TagStatusSchema,
  createdAt: z.string(),
});

export const TaggingTargetSchema = z.object({
  kind: TaggingTargetKindSchema,
  id: z.string(),
});

export const TagProposalSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  suggestedColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  reason: z.string().optional(),
  targets: z.array(TaggingTargetSchema),
  outcome: ProposalOutcomeSchema,
  createdAt: z.string(),
});

export const CaptureTagRequestSchema = z.object({
  name: z.string().min(1),
  reason: z.string().optional(),
  suggestedColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

// ===========================================================================
// CapturePayload  (extended for 0.1.0)
// ===========================================================================

export const CaptureFeatureModeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("continue"), id: z.string() }),
  z.object({
    mode: z.literal("new"),
    draft: z.object({
      name: z.string(),
      about: z.string().optional(),
    }),
  }),
  z.object({ mode: z.literal("unscoped") }),
]);

export const CaptureSourceSessionSchema = z.object({
  source: SessionSourceSchema,
  sourceSessionId: z.string().optional(),
});

export const CapturePayloadSchema = z.object({
  decision: DecisionSchema,
  edges: z.array(EdgeSchema).optional(),
  feature: CaptureFeatureModeSchema.optional(),
  sourceSession: CaptureSourceSessionSchema.optional(),
  sessionId: z.string().optional(),
  tags: z.array(CaptureTagRequestSchema).optional(),
  // 0.4.0 — top-level mirrors of the same fields on Decision (the MCP handler
  // folds them onto the persisted Decision)
  source: z.enum(["manual", "agent-live", "session-extract"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

// ===========================================================================
// Feature report draft (/feature-report)
// ===========================================================================

export const FeatureReportDraftSchema = z.object({
  featureId: z.string(),
  summary: z.string(),
  resumeEdge: z.string().optional(),
  suggestedPauseReason: PauseReasonSchema.optional(),
  openLoops: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      type: DecisionTypeSchema,
    }),
  ),
  nextStateSuggestion: FeatureStateSchema.optional(),
});

// ===========================================================================
// Resume command (/resume)
// ===========================================================================

export const ResumeModeSchema = z.enum(["jump", "rebuild"]);

export const ResumeCommandResultSchema = z.object({
  mode: ResumeModeSchema,
  command: z.string(),
  copyable: z.literal(true),
  lastSession: z
    .object({
      id: z.string(),
      endedAt: z.string().optional(),
      outcome: SessionOutcomeSchema.optional(),
      pauseReason: PauseReasonSchema.optional(),
    })
    .optional(),
});
