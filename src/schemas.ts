// Zod schemas — moderately strict mirror of src/types.ts. Shared between
// adapters (mcp.ts validates tool-call inputs; serve.ts validates HTTP POST
// bodies). Keep these in lockstep with types.ts — if you change Status or
// EdgeKind there, change them here too, otherwise one adapter will accept
// payloads the other rejects.
//
// Strictness note: the leaf objects use the default Zod behaviour (extra keys
// dropped). The runtime store enforces the strict TS types as a second pass.
import { z } from "zod";

export const TriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }),
  z.object({ kind: z.literal("metric"), expr: z.string() }),
  z.object({ kind: z.literal("event"), name: z.string() }),
  z.object({ kind: z.literal("dependency"), on: z.string() }),
]);

export const OptionSchema = z.object({
  label: z.string(),
  summary: z.string(),
  verdict: z.enum(["chosen", "rejected"]),
  why: z.string().optional(),
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

export const StatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open"), question: z.string() }),
  z.object({
    kind: z.literal("decided"),
    options: z.array(OptionSchema),
    rationale: z.string(),
    delta: IntentDeltaSchema,
  }),
  z.object({
    kind: z.literal("deferred"),
    current: z.string(),
    reason: z.string(),
    revisitWhen: TriggerSchema,
    draftDelta: IntentDeltaSchema,
  }),
  z.object({ kind: z.literal("superseded"), by: z.string() }),
  z.object({ kind: z.literal("resolved"), by: z.string() }),
  z.object({
    kind: z.literal("conflicted"),
    between: z.array(z.string()),
    path: z.string(),
  }),
]);

export const EntityRefSchema = z.object({ kind: z.string(), id: z.string() });

export const DecisionSchema = z.object({
  id: z.string(),
  title: z.string(),
  scope: z.string().optional(),
  raisedBy: z.object({
    trigger: z.string(),
    actor: z.string(),
    layer: z.enum(["district", "school", "personal"]),
    session: z.string().optional(),
    at: z.string(),
  }),
  constraint: z.string().optional(),
  status: StatusSchema,
  consequences: z
    .object({ lockedIn: z.string().optional(), lockedOut: z.string().optional() })
    .optional(),
  affects: z.array(EntityRefSchema),
  artifacts: z
    .array(z.object({ file: z.string(), commit: z.string().optional() }))
    .optional(),
  sourceReport: z.string().optional(),
  sessionId: z.string().optional(),    // 0.0.6+: ties to a Session
});

// -----------------------------------------------------------------------------
// Milestone + Session (added 0.0.6) — mirror src/types.ts
// -----------------------------------------------------------------------------

export const MilestoneSchema = z.object({
  id: z.string(),
  title: z.string(),
  intent: z.string().optional(),
  status: z.enum(["active", "shipped", "abandoned"]),
  startedAt: z.string(),
  completedAt: z.string().optional(),
});

export const SessionSourceSchema = z.enum([
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "manual",
  "unknown",
]);

export const SessionSchema = z.object({
  id: z.string(),
  milestoneId: z.string(),
  source: SessionSourceSchema,
  sourceSessionId: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  summary: z.string().optional(),
});

// The skill's milestone judgment — discriminated on `mode`.
export const CaptureMilestoneModeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("continue"), id: z.string() }),
  z.object({
    mode: z.literal("new"),
    draft: z.object({
      title: z.string(),
      intent: z.string().optional(),
    }),
  }),
  z.object({ mode: z.literal("unscoped") }),
]);

export const CaptureSourceSessionSchema = z.object({
  source: SessionSourceSchema,
  sourceSessionId: z.string().optional(),
});

export const EdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(["resolves", "supersedes", "reconciles", "relates"]),
  note: z.string().optional(),
});

// -----------------------------------------------------------------------------
// Tag system (added 0.0.7) — mirror src/types.ts
// -----------------------------------------------------------------------------

export const TagOriginSchema = z.enum(["you", "agent"]);
export const TagStatusSchema = z.enum(["active", "archived"]);
export const TagPolicySchema = z.enum(["auto", "propose", "locked"]);
export const TaggingTargetKindSchema = z.enum(["milestone", "decision"]);
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

export const CapturePayloadSchema = z.object({
  decision: DecisionSchema,
  edges: z.array(EdgeSchema).optional(),
  // 0.0.6+: skill expresses its milestone judgment and per-tool session
  // identity in one round-trip so the MCP server can wire up the
  // Milestone + Session + Decision relationship in a single putDecision.
  milestone: CaptureMilestoneModeSchema.optional(),
  sourceSession: CaptureSourceSessionSchema.optional(),
  // 0.0.7+: tag the new decision; each request is routed through the
  // ensureTag policy engine before the response comes back.
  tags: z.array(CaptureTagRequestSchema).optional(),
});
