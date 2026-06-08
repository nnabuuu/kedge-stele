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
});

export const EdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(["resolves", "supersedes", "reconciles", "relates"]),
  note: z.string().optional(),
});

export const CapturePayloadSchema = z.object({
  decision: DecisionSchema,
  edges: z.array(EdgeSchema).optional(),
});
