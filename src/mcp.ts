#!/usr/bin/env -S node --no-warnings
// stdio MCP server. Primary interface for Claude Code per ProductDesign.md §86.
//
// Wire-shape discipline: stdout is RESERVED for the MCP protocol. Any
// informational output goes to stderr via console.error / process.stderr.write.
// A stray console.log here corrupts the JSON-RPC framing and the client hangs.
//
// Four tools, matching design §98-103:
//   decision_capture / decision_resume / decision_trace / decision_resolve
//
// The store/projections/consolidate modules are headless — we feed their
// return values into MCP tool responses. No business logic added here.
import { writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Store } from "./store.ts";
import { resolveMilestoneAndSession } from "./capture.ts";
import { proposeEdges } from "./consolidate.ts";
import { milestoneDetail, milestoneSummary, resumeDigest, trace, traceEntity } from "./projections.ts";
import { renderResume } from "./render.ts";
import { stubResolver } from "./resolver.ts";
import { resolveDbPath, SteleNotInitializedError } from "./paths.ts";
import {
  CaptureMilestoneModeSchema,
  CaptureSourceSessionSchema,
  CaptureTagRequestSchema,
  DecisionSchema,
  EdgeSchema,
  TaggingTargetSchema,
} from "./schemas.ts";
import {
  applyCaptureTags,
  confirmProposal,
  ensureTag,
  getTagPolicy,
  rejectProposal,
} from "./tags.ts";
import type {
  CaptureMilestoneMode,
  CaptureSourceSession,
  CaptureTagRequest,
  Decision,
  Edge,
  EntityRef,
  Milestone,
  TaggingTargetKind,
} from "./types.ts";

// -----------------------------------------------------------------------------
// Formatters — return plain-text bodies suitable for MCP tool content[0].text.
// The JSON shape behind each is also worth exposing via structuredContent on
// SDK ≥1.x, but text is the universal fallback and easier to eyeball.
// -----------------------------------------------------------------------------

function fmtCaptureResult(
  id: string,
  appliedEdges: number,
  proposed: { edge: Edge; confidence: number; reason: string }[],
): string {
  const lines = [`captured ${id} (applied ${appliedEdges} authored edge(s))`];
  if (proposed.length === 0) {
    lines.push("consolidate: no additional edges proposed.");
  } else {
    lines.push(`consolidate proposes ${proposed.length} edge(s) — confirm via decision_resolve:`);
    for (const c of proposed) {
      lines.push(
        `  · [${(c.confidence * 100) | 0}%] ${c.edge.from} —${c.edge.kind}→ ${c.edge.to}  ${c.reason}`,
      );
    }
  }
  return lines.join("\n");
}

function fmtResume(
  items: ReturnType<typeof resumeDigest>,
): string {
  if (items.length === 0) return "什么在等我 — 0 个未闭合回路";
  const lines = [`什么在等我 — ${items.length} 个未闭合回路`];
  for (const i of items) {
    const tag = i.needsCheck ? " ⚠ 复审" : "";
    lines.push(`  ${i.id}  [${i.bucket}] ${i.ageDays}d${tag}  ${i.title}`);
    if (i.trigger) lines.push(`        复审: ${i.trigger}`);
  }
  return lines.join("\n");
}

function fmtTrace(t: Awaited<ReturnType<typeof trace>>): string {
  if (!t) return "no such decision";
  const lines: string[] = [];
  lines.push(`${t.decision.id} — ${t.decision.title}`);
  lines.push(`  status:  ${t.statusLine}`);
  if (t.decision.constraint) lines.push(`  约束:    ${t.decision.constraint}`);
  lines.push(`  affects: ${t.affects.map((a) => a.label).join(", ") || "(none)"}`);
  if (t.edges.length > 0) {
    lines.push(`  graph:`);
    for (const e of t.edges) {
      const arrow = e.direction === "out" ? `—${e.kind}→` : `←${e.kind}—`;
      lines.push(`    ${arrow} ${e.otherId} (${e.otherTitle})`);
    }
  }
  return lines.join("\n");
}

function fmtEntityTraces(ref: EntityRef, traces: Awaited<ReturnType<typeof traceEntity>>): string {
  if (traces.length === 0) return `${ref.kind}:${ref.id} — 0 个相关决策`;
  const lines = [`${ref.kind}:${ref.id} — ${traces.length} 个相关决策`];
  for (const t of traces) {
    lines.push(`  ${t.decision.id}  ${t.statusLine}`);
    lines.push(`        ${t.decision.title}`);
  }
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Server setup
// -----------------------------------------------------------------------------

let db: string;
try {
  db = resolveDbPath();
} catch (e) {
  if (e instanceof SteleNotInitializedError) {
    console.error(`[stele] ${e.message}`);
    process.exit(1);
  }
  throw e;
}
const store = new Store(db);
const server = new McpServer({ name: "stele", version: "0.0.7-snapshot" });

server.registerTool(
  "decision_capture",
  {
    description:
      "Carve a decision drafted from conversation context as a node in the stele graph. " +
      "Pass `decision` (full Decision shape per src/types.ts) and optional `edges` you authored. " +
      "0.0.6+: also pass `milestone` (your judgment: continue an existing milestone, open a new one, or leave unscoped) " +
      "and `sourceSession` (the tool's native session id so we dedup across captures in the same conversation). " +
      "0.0.7+: pass `tags` — each `{name, reason?, suggestedColor?}` runs through the local tag policy " +
      "(auto / propose / locked). Existing active tags apply immediately; new names follow the policy. " +
      "The consolidate layer will propose additional edges; review them and confirm via decision_resolve.",
    inputSchema: {
      decision: DecisionSchema,
      edges: z.array(EdgeSchema).optional(),
      milestone: CaptureMilestoneModeSchema.optional(),
      sourceSession: CaptureSourceSessionSchema.optional(),
      tags: z.array(CaptureTagRequestSchema).optional(),
    },
  },
  async ({ decision, edges, milestone, sourceSession, tags }) => {
    // Wire milestone + session first; stamp the resulting session_id onto
    // the decision before persisting.
    const resolved = resolveMilestoneAndSession(
      store,
      milestone as CaptureMilestoneMode | undefined,
      sourceSession as CaptureSourceSession | undefined,
      decision.raisedBy.at,
    );

    const decisionWithSession: Decision = {
      ...(decision as Decision),
      ...(resolved.sessionId ? { sessionId: resolved.sessionId } : {}),
    };

    const candidates = proposeEdges(store, decisionWithSession);
    store.putDecision(decisionWithSession);
    for (const e of edges ?? []) store.addEdge(e as Edge);

    const lines = [fmtCaptureResult(decision.id, edges?.length ?? 0, candidates)];
    for (const n of resolved.notes) lines.push(`  · ${n}`);

    if (tags && tags.length > 0) {
      const tr = applyCaptureTags(store, tags as CaptureTagRequest[], decision.id);
      if (tr.applied.length)
        lines.push(`  · tags applied: ${tr.applied.map((a) => `${a.name}(${a.tagId})`).join(", ")}`);
      if (tr.pending.length)
        lines.push(
          `  · tags pending (need your confirm): ${tr.pending.map((p) => `${p.name}(${p.proposalId})`).join(", ")}`,
        );
      if (tr.blocked.length)
        lines.push(
          `  · tags blocked by policy=locked: ${tr.blocked.map((b) => `${b.name}(${b.proposalId})`).join(", ")}`,
        );
      for (const e of tr.errors) lines.push(`  · tag error "${e.name}": ${e.message}`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.registerTool(
  "decision_resume",
  {
    description:
      "What's waiting on me — every open + un-resolved deferred node, needs-check first. " +
      "Optionally write an HTML digest by passing `htmlPath` (absolute path).",
    inputSchema: { htmlPath: z.string().optional() },
  },
  async ({ htmlPath }) => {
    const items = resumeDigest(store);
    if (htmlPath) writeFileSync(htmlPath, renderResume(items));
    return { content: [{ type: "text", text: fmtResume(items) }] };
  },
);

server.registerTool(
  "decision_trace",
  {
    description:
      "How did this come to be — anchor on a decision id (by:'id') for its graph neighbourhood, " +
      "or on an entity (by:'entity' + kind + entityId) for all decisions touching that thing, " +
      "across sessions. Associative, not chronological.",
    inputSchema: {
      by: z.enum(["id", "entity"]),
      id: z.string().optional(),
      kind: z.string().optional(),
      entityId: z.string().optional(),
    },
  },
  async ({ by, id, kind, entityId }) => {
    if (by === "id") {
      if (!id) throw new Error("decision_trace by:'id' requires `id`");
      const t = await trace(store, id, stubResolver);
      return { content: [{ type: "text", text: fmtTrace(t) }] };
    }
    if (!kind || !entityId) {
      throw new Error("decision_trace by:'entity' requires `kind` and `entityId`");
    }
    const ref = { kind, id: entityId };
    const traces = await traceEntity(store, ref, stubResolver);
    return { content: [{ type: "text", text: fmtEntityTraces(ref, traces) }] };
  },
);

server.registerTool(
  "decision_resolve",
  {
    description:
      "Connect an edge between two decisions. `resolves` flips the target to RESOLVED " +
      "(this is the cross-session stitch — a later decision answering an old deferred). " +
      "`supersedes` flips the target to SUPERSEDED. `relates` / `reconciles` are non-destructive links.",
    inputSchema: {
      kind: z.enum(["resolves", "supersedes", "relates", "reconciles"]),
      from: z.string(),
      to: z.string(),
      note: z.string().optional(),
    },
  },
  async ({ kind, from, to, note }) => {
    store.addEdge({ kind, from, to, note });
    return { content: [{ type: "text", text: `${from} —${kind}→ ${to}${note ? "  (" + note + ")" : ""}` }] };
  },
);

// -----------------------------------------------------------------------------
// 0.0.6 — milestone_list / milestone_open / milestone_close
// -----------------------------------------------------------------------------

server.registerTool(
  "milestone_list",
  {
    description:
      "List all milestones. Returns active-first by default. Pass `status` to filter. " +
      "Each entry includes session count + decision count + open-loop count so the calling agent " +
      "can pick which to 'continue' on capture.",
    inputSchema: {
      status: z.enum(["active", "shipped", "abandoned"]).optional(),
    },
  },
  async ({ status }) => {
    const all = milestoneSummary(store);
    const filtered = status ? all.filter((m) => m.milestone.status === status) : all;
    if (filtered.length === 0) {
      return { content: [{ type: "text", text: "no milestones" }] };
    }
    const lines = [`${filtered.length} milestone(s):`];
    for (const m of filtered) {
      lines.push(
        `  ${m.milestone.id}  [${m.milestone.status}]  "${m.milestone.title}"  ${m.sessionCount} session(s), ${m.openLoops} open loop(s), last activity ${m.lastActivity.slice(0, 10)}`,
      );
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.registerTool(
  "milestone_open",
  {
    description:
      "Explicitly open a new milestone. Returns the assigned id. Usually the agent passes " +
      "milestone:{mode:'new', draft:{...}} on decision_capture instead — this tool is for the " +
      "rare case where you want to declare the milestone before any decision crystallises.",
    inputSchema: {
      title: z.string(),
      intent: z.string().optional(),
    },
  },
  async ({ title, intent }) => {
    const id = store.nextMilestoneId();
    const m: Milestone = {
      id,
      title,
      intent,
      status: "active",
      startedAt: new Date().toISOString(),
    };
    store.putMilestone(m);
    return { content: [{ type: "text", text: `opened ${id} "${title}"` }] };
  },
);

server.registerTool(
  "milestone_close",
  {
    description:
      "Close a milestone — mark it shipped (success) or abandoned (gave up). " +
      "Open decisions inside it stay visible; they don't get cascade-closed.",
    inputSchema: {
      id: z.string(),
      verdict: z.enum(["shipped", "abandoned"]),
      summary: z.string().optional(),
    },
  },
  async ({ id, verdict, summary }) => {
    const existing = store.getMilestone(id);
    if (!existing) {
      return { content: [{ type: "text", text: `no such milestone: ${id}` }] };
    }
    const updated: Milestone = {
      ...existing,
      status: verdict,
      completedAt: new Date().toISOString(),
    };
    store.putMilestone(updated);
    return {
      content: [{ type: "text", text: `${id} → ${verdict}${summary ? `  (${summary})` : ""}` }],
    };
  },
);

// -----------------------------------------------------------------------------
// 0.0.7 — tag tools + config tools
//
// The agent has eight tag tools split into two layers:
//   • write path:  tag_propose, tag_apply (the agent reaches for these mid-capture)
//   • admin path:  tag_confirm, tag_reject, tag_recolor, tag_rename, tag_archive,
//                  tag_restore (the human reaches for these from CLI / web)
// Whether `tag_propose` directly creates a tag depends on `tag_policy` in
// config — see src/tags.ts for the engine.
// -----------------------------------------------------------------------------

server.registerTool(
  "tag_propose",
  {
    description:
      "Propose a tag for one or more targets (milestones / decisions). Behaviour depends on the " +
      "local `tag_policy` config: 'auto' creates the tag immediately, 'propose' (default) queues " +
      "into the tag_proposals table for human confirmation, 'locked' refuses. " +
      "If `tag_require_reason` is true (default) and policy is 'propose', `reason` is required.",
    inputSchema: {
      name: z.string().min(1),
      reason: z.string().optional(),
      suggestedColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      targets: z.array(TaggingTargetSchema).min(1),
    },
  },
  async ({ name, reason, suggestedColor, targets }) => {
    try {
      const r = ensureTag(store, name, {
        reason,
        suggestedColor,
        targets: targets as { kind: TaggingTargetKind; id: string }[],
      });
      if (r.kind === "active") {
        return { content: [{ type: "text", text: `applied existing tag ${r.tag.id} (${r.tag.name})` }] };
      }
      if (r.kind === "pending") {
        return {
          content: [
            { type: "text", text: `proposed ${r.proposal.id} (${r.proposal.name}) — awaiting confirm` },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `blocked: tag_policy=locked — logged proposal ${r.proposal.id} (${r.proposal.name})`,
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `error: ${(e as Error).message}` }] };
    }
  },
);

server.registerTool(
  "tag_apply",
  {
    description:
      "Bind an existing active tag to a target (milestone or decision). Idempotent. " +
      "Refuses if the tag does not exist or is archived — use tag_propose for new tags.",
    inputSchema: {
      tagId: z.string(),
      target: TaggingTargetSchema,
    },
  },
  async ({ tagId, target }) => {
    const tag = store.getTag(tagId);
    if (!tag) return { content: [{ type: "text", text: `no such tag: ${tagId}` }] };
    if (tag.status !== "active") {
      return { content: [{ type: "text", text: `tag ${tagId} is archived; restore it first` }] };
    }
    store.upsertTagging({ tagId, targetKind: target.kind, targetId: target.id });
    return {
      content: [{ type: "text", text: `${tag.name} → ${target.kind}:${target.id}` }],
    };
  },
);

server.registerTool(
  "tag_confirm",
  {
    description:
      "Confirm a pending tag proposal: creates the tag (origin='you'), applies its target taggings, " +
      "and removes the proposal. Optional `rename` / `color` override the agent's suggestion at " +
      "confirmation time. Use this when the agent's proposed tag is good.",
    inputSchema: {
      proposalId: z.string(),
      rename: z.string().optional(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    },
  },
  async ({ proposalId, rename, color }) => {
    try {
      const r = confirmProposal(store, proposalId, { rename, color });
      return {
        content: [
          {
            type: "text",
            text: `confirmed ${r.tag.id} (${r.tag.name}); ${r.taggingsAdded} new tagging(s) applied`,
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `error: ${(e as Error).message}` }] };
    }
  },
);

server.registerTool(
  "tag_reject",
  {
    description: "Reject a tag proposal — removes the row, doesn't create a tag.",
    inputSchema: { proposalId: z.string() },
  },
  async ({ proposalId }) => {
    const ok = rejectProposal(store, proposalId);
    return { content: [{ type: "text", text: ok ? `rejected ${proposalId}` : `no such proposal: ${proposalId}` }] };
  },
);

server.registerTool(
  "tag_recolor",
  {
    description: "Change a tag's display color. Hex #RRGGBB.",
    inputSchema: {
      tagId: z.string(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    },
  },
  async ({ tagId, color }) => {
    if (!store.getTag(tagId)) return { content: [{ type: "text", text: `no such tag: ${tagId}` }] };
    store.recolorTag(tagId, color);
    return { content: [{ type: "text", text: `${tagId} → ${color}` }] };
  },
);

server.registerTool(
  "tag_rename",
  {
    description: "Rename a tag. Fails if the new name collides with another existing tag.",
    inputSchema: {
      tagId: z.string(),
      name: z.string().min(1),
    },
  },
  async ({ tagId, name }) => {
    const existing = store.getTag(tagId);
    if (!existing) return { content: [{ type: "text", text: `no such tag: ${tagId}` }] };
    const collision = store.findTagByName(name);
    if (collision && collision.id !== tagId) {
      return { content: [{ type: "text", text: `name "${name}" already taken by ${collision.id}` }] };
    }
    store.renameTag(tagId, name);
    return { content: [{ type: "text", text: `${tagId} renamed → ${name}` }] };
  },
);

server.registerTool(
  "tag_archive",
  {
    description:
      "Archive a tag — hides it from active list, keeps existing taggings intact, " +
      "but new proposals using the same name go through policy as if the tag didn't exist.",
    inputSchema: { tagId: z.string() },
  },
  async ({ tagId }) => {
    if (!store.getTag(tagId)) return { content: [{ type: "text", text: `no such tag: ${tagId}` }] };
    store.archiveTag(tagId);
    return { content: [{ type: "text", text: `${tagId} archived` }] };
  },
);

server.registerTool(
  "tag_restore",
  {
    description: "Restore an archived tag back to active.",
    inputSchema: { tagId: z.string() },
  },
  async ({ tagId }) => {
    if (!store.getTag(tagId)) return { content: [{ type: "text", text: `no such tag: ${tagId}` }] };
    store.restoreTag(tagId);
    return { content: [{ type: "text", text: `${tagId} restored` }] };
  },
);

server.registerTool(
  "config_get",
  {
    description:
      "Read a single config key, or omit `key` to dump everything. Notable keys: " +
      "`tag_policy` (auto|propose|locked, default propose), " +
      "`tag_require_reason` (true|false, default true).",
    inputSchema: { key: z.string().optional() },
  },
  async ({ key }) => {
    if (key) {
      const v = store.getConfig(key);
      // Surface the effective policy even when the key is unset, so the agent
      // can see what's actually in force without a second lookup.
      if (key === "tag_policy" && v === null) {
        return {
          content: [{ type: "text", text: `tag_policy = ${getTagPolicy(store)} (default)` }],
        };
      }
      return { content: [{ type: "text", text: v === null ? `${key} = (unset)` : `${key} = ${v}` }] };
    }
    const all = store.allConfig();
    const keys = Object.keys(all).sort();
    if (keys.length === 0) return { content: [{ type: "text", text: "config is empty (using defaults)" }] };
    return {
      content: [
        { type: "text", text: keys.map((k) => `${k} = ${all[k]}`).join("\n") },
      ],
    };
  },
);

server.registerTool(
  "config_set",
  {
    description:
      "Set a config key. Validated keys: " +
      "`tag_policy` (auto|propose|locked), `tag_require_reason` (true|false).",
    inputSchema: {
      key: z.string().min(1),
      value: z.string(),
    },
  },
  async ({ key, value }) => {
    if (key === "tag_policy" && !["auto", "propose", "locked"].includes(value)) {
      return { content: [{ type: "text", text: `tag_policy must be one of: auto, propose, locked` }] };
    }
    if (key === "tag_require_reason" && !["true", "false"].includes(value)) {
      return { content: [{ type: "text", text: `tag_require_reason must be 'true' or 'false'` }] };
    }
    store.setConfig(key, value);
    return { content: [{ type: "text", text: `${key} = ${value}` }] };
  },
);

// -----------------------------------------------------------------------------
// Connect transport. stderr-only logging from this point on.
// -----------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[stele] mcp server ready  db=${db}`);
