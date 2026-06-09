#!/usr/bin/env -S node --no-warnings
// stdio MCP server. Primary interface for Claude Code.
//
// Wire-shape discipline: stdout is RESERVED for the MCP protocol. Any
// informational output goes to stderr via console.error / process.stderr.write.
// A stray console.log here corrupts the JSON-RPC framing and the client hangs.
//
// 0.1.0 tool roster (24 tools):
//   capture path:   decision_capture, decision_resume, decision_trace, decision_resolve
//   features:       feature_open, feature_list
//   milestones:     milestone_list, milestone_open, milestone_report
//   sessions:       session_start, session_end, resume_command
//   tags:           tag_propose, tag_apply, tag_confirm, tag_reject,
//                   tag_recolor, tag_rename, tag_archive, tag_restore
//   config:         config_get, config_set
//   (retired):      milestone_close (state advances via milestone_report flow)
//
// All shapes are mirrors of src/types.ts via src/schemas.ts.
import { writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Store } from "./store.ts";
import {
  recordSessionEnd,
  recordSessionStart,
  resolveMilestoneAndSession,
} from "./capture.ts";
import { proposeEdges } from "./consolidate.ts";
import {
  continueLast,
  milestoneSummary,
  nodeState,
  projectRollup,
  resumeDigest,
  trace,
  traceEntity,
} from "./projections.ts";
import { renderResume } from "./render.ts";
import { stubResolver } from "./resolver.ts";
import { resolveDbPath, SteleNotInitializedError } from "./paths.ts";
import {
  CaptureMilestoneModeSchema,
  CaptureSourceSessionSchema,
  CaptureTagRequestSchema,
  DecisionSchema,
  EdgeSchema,
  MilestoneStateSchema,
  PauseReasonSchema,
  SessionOutcomeSchema,
  SessionProvenanceSchema,
  SessionSourceSchema,
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
  DecisionType,
  Edge,
  EntityRef,
  Feature,
  Milestone,
  MilestoneId,
  MilestoneReportDraft,
  PauseReason,
  ResumeCommandResult,
  Session,
  SessionOutcome,
  SessionProvenance,
  TaggingTargetKind,
} from "./types.ts";

// =============================================================================
// Formatters — return plain-text bodies suitable for MCP tool content[0].text.
// =============================================================================

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
        `  · [${(c.confidence * 100) | 0}%] ${c.edge.from} —${c.edge.relation}→ ${c.edge.to}  ${c.reason}`,
      );
    }
  }
  return lines.join("\n");
}

function fmtResume(items: ReturnType<typeof resumeDigest>): string {
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
  if (t.decision.detail?.constraint) lines.push(`  约束:    ${t.decision.detail.constraint}`);
  lines.push(`  affects: ${t.affects.map((a) => a.label).join(", ") || "(none)"}`);
  if (t.edges.length > 0) {
    lines.push(`  graph:`);
    for (const e of t.edges) {
      const arrow = e.direction === "out" ? `—${e.relation}→` : `←${e.relation}—`;
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

// Shell-quote for cwd interpolation in resume_command.
function shQuote(s: string): string {
  return /^[A-Za-z0-9_\-./]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

function buildResumeCommand(session: Session): ResumeCommandResult {
  const layoutAlive = session.provenance?.layoutAlive ?? false;
  const cwd = session.provenance?.cwd ?? process.cwd();
  const ccSid = session.sourceSessionId ?? "<no-session-id>";
  return {
    mode: layoutAlive ? "jump" : "rebuild",
    command: `cd ${shQuote(cwd)} && claude --resume ${ccSid}`,
    copyable: true,
    lastSession: {
      id: session.id,
      endedAt: session.endedAt,
      outcome: session.outcome,
      pauseReason: session.pauseReason,
    },
  };
}

function buildMilestoneReportDraft(store: Store, milestoneId: MilestoneId): MilestoneReportDraft {
  const m = store.getMilestone(milestoneId);
  if (!m) throw new Error(`no such milestone: ${milestoneId}`);
  const openLoops = store
    .decisionsInMilestone(milestoneId)
    .filter((d) => {
      const ns = nodeState(d);
      return ns === "open" || ns === "deferred";
    })
    .map((d) => ({ id: d.id, title: d.title, type: d.type as DecisionType }));

  // Heuristic next-state nudge:
  //   - if there are NO open loops left, suggest 'winding' so the user can
  //     close it next session.
  //   - if state is 'draft' and there's already activity, suggest 'going'.
  let nextStateSuggestion: MilestoneReportDraft["nextStateSuggestion"];
  if (m.state === "draft" && store.sessionsInMilestone(m.id).length > 0) {
    nextStateSuggestion = "going";
  } else if (m.state === "going" && openLoops.length === 0) {
    nextStateSuggestion = "winding";
  }

  return {
    milestoneId,
    summary: "", // agent fills from conversation context
    openLoops,
    nextStateSuggestion,
  };
}

// =============================================================================
// Server setup
// =============================================================================

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
if (store.migratedFromLegacy) {
  console.error(`[stele] ${store.migratedFromLegacy.oldPath}`);
  console.error(`[stele] Pre-0.1.0 schema detected. Old DB preserved at:`);
  console.error(`[stele]   ${store.migratedFromLegacy.backupPath}`);
  console.error(`[stele] Fresh 0.1.0 schema in place. Use sqlite3 to export from backup.`);
}

const server = new McpServer({ name: "stele", version: "0.1.0-snapshot" });

// =============================================================================
// decision_capture
// =============================================================================

server.registerTool(
  "decision_capture",
  {
    description:
      "Carve a decision drafted from conversation context as a node in the stele graph. " +
      "Pass `decision` (full Decision shape per src/types.ts — the new split form with " +
      "`type` + optional `status` + rich `detail` body) and optional `edges` you authored. " +
      "Decision.id will be REASSIGNED to `<milestoneId>/<local>` after milestone resolution; " +
      "the field is required by the schema but its value is ignored (set it to '?'). " +
      "Pass `milestone` (continue an existing milestone, open a new one, or unscoped) and " +
      "`sourceSession` (the tool's native session id so we dedup), or pass `sessionId` directly " +
      "if you called `session_start` earlier. Pass `tags` for each tag request — each runs " +
      "through the local policy (auto/propose/locked).",
    inputSchema: {
      decision: DecisionSchema,
      edges: z.array(EdgeSchema).optional(),
      milestone: CaptureMilestoneModeSchema.optional(),
      sourceSession: CaptureSourceSessionSchema.optional(),
      sessionId: z.string().optional(),
      tags: z.array(CaptureTagRequestSchema).optional(),
    },
  },
  async ({ decision, edges, milestone, sourceSession, sessionId, tags }) => {
    let milestoneId: MilestoneId;
    let resolvedSessionId: string;
    const notes: string[] = [];

    if (sessionId) {
      const s = store.getSession(sessionId);
      if (!s) throw new Error(`session "${sessionId}" does not exist`);
      milestoneId = s.milestoneId;
      resolvedSessionId = s.id;
      notes.push(`bound to existing session ${s.id} on milestone ${s.milestoneId}`);
    } else {
      const r = resolveMilestoneAndSession(
        store,
        milestone as CaptureMilestoneMode | undefined,
        sourceSession as CaptureSourceSession | undefined,
        decision.raisedBy.at,
      );
      milestoneId = r.milestoneId;
      resolvedSessionId = r.sessionId;
      notes.push(...r.notes);
    }

    // Honor a slash-format id the agent passed if it matches the resolved
    // milestone and is collision-free; otherwise regenerate. This lets
    // scripts pin a specific id while still letting agents pass "?" and get
    // a sane default.
    const slashFormat = /^[^/]+\/(D|DEF|OQ)-\d+$/;
    let finalId: string;
    if (slashFormat.test(decision.id) && decision.id.startsWith(`${milestoneId}/`)) {
      if (store.getDecision(decision.id)) {
        throw new Error(
          `decision id "${decision.id}" already exists; pass "?" to let the tool pick the next slot`,
        );
      }
      finalId = decision.id;
    } else {
      finalId = store.nextLocalDecisionId(milestoneId, decision.type as DecisionType);
    }
    const decisionFinal: Decision = {
      ...(decision as Decision),
      id: finalId,
      milestoneId,
      sessionId: resolvedSessionId,
    };

    const candidates = proposeEdges(store, decisionFinal);
    store.putDecision(decisionFinal);
    // Authored edges: endpoint-existence check matches serve.ts's POST /api/edges.
    for (const e of edges ?? []) {
      const edge = e as Edge;
      const fromOk = edge.from === finalId || !!store.getDecision(edge.from);
      const toOk = edge.to === finalId || !!store.getDecision(edge.to);
      if (!fromOk || !toOk) {
        throw new Error(`authored edge endpoints must both exist: ${edge.from} → ${edge.to}`);
      }
      store.addEdge(edge);
    }

    const lines = [fmtCaptureResult(decisionFinal.id, edges?.length ?? 0, candidates)];
    for (const n of notes) lines.push(`  · ${n}`);

    if (tags && tags.length > 0) {
      const tr = applyCaptureTags(store, tags as CaptureTagRequest[], decisionFinal.id);
      if (tr.applied.length) lines.push(`  · tags applied: ${tr.applied.map((a) => `${a.name}(${a.tagId})`).join(", ")}`);
      if (tr.pending.length) lines.push(`  · tags pending: ${tr.pending.map((p) => `${p.name}(${p.proposalId})`).join(", ")}`);
      if (tr.blocked.length) lines.push(`  · tags blocked: ${tr.blocked.map((b) => `${b.name}(${b.proposalId})`).join(", ")}`);
      for (const e of tr.errors) lines.push(`  · tag error "${e.name}": ${e.message}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// =============================================================================
// decision_resume / decision_trace / decision_resolve
// =============================================================================

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
      "(this is the cross-session stitch). `supersedes` flips the target to SUPERSEDED. " +
      "`depends_on` / `relates` / `reconciles` are non-destructive links. " +
      "0.1.0: arg renamed from `kind` to `relation`; `depends_on` added.",
    inputSchema: {
      relation: z.enum(["resolves", "supersedes", "relates", "reconciles", "depends_on"]),
      from: z.string(),
      to: z.string(),
      note: z.string().optional(),
    },
  },
  async ({ relation, from, to, note }) => {
    store.addEdge({ relation, from, to, note });
    return { content: [{ type: "text", text: `${from} —${relation}→ ${to}${note ? "  (" + note + ")" : ""}` }] };
  },
);

// =============================================================================
// feature_open / feature_list
// =============================================================================

server.registerTool(
  "feature_open",
  {
    description:
      "Open a new Feature under the current project. Features are the structural axis between " +
      "Project and Milestone (e.g. 'CcaaS Backend', 'Live Lesson'). Returns the assigned id.",
    inputSchema: {
      name: z.string().min(1),
      links: z
        .array(z.object({
          to: z.string(),
          relation: z.enum(["depends-on", "depended-on-by"]),
        }))
        .optional(),
    },
  },
  async ({ name, links }) => {
    const project = store.theProject();
    if (!project) {
      return { content: [{ type: "text", text: "no Project — run `stele init` first" }] };
    }
    const id = store.nextFeatureId();
    const f: Feature = { id, projectId: project.id, name, links };
    store.putFeature(f);
    return { content: [{ type: "text", text: `opened ${id} "${name}"` }] };
  },
);

server.registerTool(
  "feature_list",
  {
    description: "List Features in the current project, with milestone counts.",
    inputSchema: {},
  },
  async () => {
    const project = store.theProject();
    if (!project) {
      return { content: [{ type: "text", text: "no Project — run `stele init` first" }] };
    }
    const features = store.featuresIn(project.id);
    if (features.length === 0) return { content: [{ type: "text", text: "no features yet" }] };
    const lines = [`${features.length} feature(s):`];
    for (const f of features) {
      const milestones = store.milestonesInFeature(f.id);
      lines.push(`  ${f.id}  "${f.name}"  (${milestones.length} milestone${milestones.length === 1 ? "" : "s"})`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// =============================================================================
// milestone_list / milestone_open / milestone_report
// =============================================================================

server.registerTool(
  "milestone_list",
  {
    description:
      "List milestones with session count + decision count + open-loop count. Pass `state` to " +
      "filter by one of draft/going/winding/done/paused. Order: going first, then winding, " +
      "paused, draft, done.",
    inputSchema: {
      state: MilestoneStateSchema.optional(),
      featureId: z.string().optional(),
    },
  },
  async ({ state, featureId }) => {
    const all = milestoneSummary(store);
    let filtered = all;
    if (state) filtered = filtered.filter((m) => m.milestone.state === state);
    if (featureId) filtered = filtered.filter((m) => m.milestone.featureId === featureId);
    if (filtered.length === 0) return { content: [{ type: "text", text: "no milestones" }] };
    const lines = [`${filtered.length} milestone(s):`];
    for (const m of filtered) {
      lines.push(
        `  ${m.milestone.id}  [${m.milestone.state}]  "${m.milestone.name}"  ${m.sessionCount} session(s), ${m.openLoops} open loop(s), last activity ${m.lastActivity.slice(0, 10)}`,
      );
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.registerTool(
  "milestone_open",
  {
    description:
      "Explicitly open a new milestone under a Feature. `featureId` is required (use " +
      "feature_open or feature_list first). State starts at 'draft' until a session opens.",
    inputSchema: {
      featureId: z.string(),
      name: z.string().min(1),
      about: z.string().optional(),
      sequenceAfter: z.array(z.string()).optional(),
    },
  },
  async ({ featureId, name, about, sequenceAfter }) => {
    if (!store.getFeature(featureId)) {
      return { content: [{ type: "text", text: `no such feature: ${featureId}` }] };
    }
    const id = store.nextMilestoneId();
    const m: Milestone = {
      id,
      featureId,
      name,
      state: "draft",
      about,
      sequenceAfter,
      startedAt: new Date().toISOString(),
    };
    store.putMilestone(m);
    return { content: [{ type: "text", text: `opened ${id} "${name}" (state=draft)` }] };
  },
);

server.registerTool(
  "milestone_report",
  {
    description:
      "Generate a MilestoneReportDraft for the /milestone-report flow (走之前留话). " +
      "Returns the milestone's openLoops + a state-transition suggestion. The agent fills " +
      "`summary` / `resumeEdge` / `suggestedPauseReason` from conversation context, shows the " +
      "draft to the user, then calls `session_end` to commit.",
    inputSchema: { milestoneId: z.string() },
  },
  async ({ milestoneId }) => {
    try {
      const draft = buildMilestoneReportDraft(store, milestoneId);
      const text = JSON.stringify(draft, null, 2);
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `error: ${(e as Error).message}` }] };
    }
  },
);

// =============================================================================
// session_start / session_end / resume_command
// =============================================================================

server.registerTool(
  "session_start",
  {
    description:
      "Explicitly open a Session under a milestone. Idempotent on (source, sourceSessionId): " +
      "calling twice for the same Claude Code session returns the same Session row. The " +
      "`provenance` carries cwd + zellij info so resume_command can later return a 'jump' or " +
      "'rebuild' mode command.",
    inputSchema: {
      milestoneId: z.string(),
      sourceSession: CaptureSourceSessionSchema,
      provenance: SessionProvenanceSchema.optional(),
    },
  },
  async ({ milestoneId, sourceSession, provenance }) => {
    try {
      const s = recordSessionStart(
        store,
        milestoneId,
        sourceSession as CaptureSourceSession,
        provenance as SessionProvenance | undefined,
      );
      return { content: [{ type: "text", text: `opened session ${s.id} on milestone ${milestoneId}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `error: ${(e as Error).message}` }] };
    }
  },
);

server.registerTool(
  "session_end",
  {
    description:
      "Close a Session with an outcome and an optional pause_reason. When outcome.type='resolved' " +
      "the milestone advances from 'going' → 'winding'. Other state transitions stay explicit.",
    inputSchema: {
      sessionId: z.string(),
      outcome: SessionOutcomeSchema,
      pauseReason: PauseReasonSchema.optional(),
    },
  },
  async ({ sessionId, outcome, pauseReason }) => {
    try {
      const s = recordSessionEnd(
        store,
        sessionId,
        outcome as SessionOutcome,
        pauseReason as PauseReason | undefined,
      );
      return {
        content: [
          {
            type: "text",
            text: `closed session ${s.id} (outcome=${s.outcome?.type}${pauseReason ? `, pause=${pauseReason.kind}` : ""})`,
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `error: ${(e as Error).message}` }] };
    }
  },
);

server.registerTool(
  "resume_command",
  {
    description:
      "Build the copy-paste-ready resume command for a given session. Returns mode='jump' if " +
      "the session's provenance.layoutAlive=true (preserves the layout) or mode='rebuild' " +
      "(uses `claude --resume`). The agent shows this to the user with the session's last " +
      "outcome + pause_reason so they recall context before jumping in.",
    inputSchema: { sessionId: z.string() },
  },
  async ({ sessionId }) => {
    const s = store.getSession(sessionId);
    if (!s) return { content: [{ type: "text", text: `no such session: ${sessionId}` }] };
    const result = buildResumeCommand(s);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// =============================================================================
// 0.0.7 — tag tools + config tools  (unchanged)
// =============================================================================

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
        return { content: [{ type: "text", text: `proposed ${r.proposal.id} (${r.proposal.name}) — awaiting confirm` }] };
      }
      return {
        content: [{ type: "text", text: `blocked: tag_policy=locked — logged proposal ${r.proposal.id} (${r.proposal.name})` }],
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
    inputSchema: { tagId: z.string(), target: TaggingTargetSchema },
  },
  async ({ tagId, target }) => {
    const tag = store.getTag(tagId);
    if (!tag) return { content: [{ type: "text", text: `no such tag: ${tagId}` }] };
    if (tag.status !== "active") {
      return { content: [{ type: "text", text: `tag ${tagId} is archived; restore it first` }] };
    }
    store.upsertTagging({ tagId, targetKind: target.kind, targetId: target.id });
    return { content: [{ type: "text", text: `${tag.name} → ${target.kind}:${target.id}` }] };
  },
);

server.registerTool(
  "tag_confirm",
  {
    description:
      "Confirm a pending tag proposal: creates the tag (origin='you'), applies its target taggings, " +
      "and removes the proposal. Optional `rename` / `color` override the agent's suggestion.",
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
        content: [{ type: "text", text: `confirmed ${r.tag.id} (${r.tag.name}); ${r.taggingsAdded} new tagging(s) applied` }],
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
    inputSchema: { tagId: z.string(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) },
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
    inputSchema: { tagId: z.string(), name: z.string().min(1) },
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
    description: "Archive a tag — hides it from active list; keeps existing taggings intact.",
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
      if (key === "tag_policy" && v === null) {
        return { content: [{ type: "text", text: `tag_policy = ${getTagPolicy(store)} (default)` }] };
      }
      return { content: [{ type: "text", text: v === null ? `${key} = (unset)` : `${key} = ${v}` }] };
    }
    const all = store.allConfig();
    const keys = Object.keys(all).sort();
    if (keys.length === 0) return { content: [{ type: "text", text: "config is empty (using defaults)" }] };
    return { content: [{ type: "text", text: keys.map((k) => `${k} = ${all[k]}`).join("\n") }] };
  },
);

server.registerTool(
  "config_set",
  {
    description:
      "Set a config key. Validated keys: " +
      "`tag_policy` (auto|propose|locked), `tag_require_reason` (true|false).",
    inputSchema: { key: z.string().min(1), value: z.string() },
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

// =============================================================================
// Connect transport. stderr-only logging from this point on.
// =============================================================================

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[stele] mcp server ready  db=${db}`);
