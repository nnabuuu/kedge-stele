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
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Store } from "./store.ts";
import { proposeEdges } from "./consolidate.ts";
import { milestoneDetail, milestoneSummary, resumeDigest, trace, traceEntity } from "./projections.ts";
import { renderResume } from "./render.ts";
import { stubResolver } from "./resolver.ts";
import { resolveDbPath, SteleNotInitializedError } from "./paths.ts";
import {
  CaptureMilestoneModeSchema,
  CaptureSourceSessionSchema,
  DecisionSchema,
  EdgeSchema,
} from "./schemas.ts";
import type {
  CaptureMilestoneMode,
  CaptureSourceSession,
  Decision,
  Edge,
  EntityRef,
  Milestone,
  Session,
  SessionId,
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
const server = new McpServer({ name: "stele", version: "0.0.6-snapshot" });

// -----------------------------------------------------------------------------
// 0.0.6 — Milestone + Session helpers shared by decision_capture and milestone_open
// -----------------------------------------------------------------------------

function nextMilestoneId(): string {
  const pattern = /^M-(\d+)$/;
  let max = 0;
  for (const m of store.allMilestones()) {
    const r = m.id.match(pattern);
    if (r) {
      const n = Number(r[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `M-${String(max + 1).padStart(2, "0")}`;
}

function newSessionId(source: string, sourceSessionId: string | undefined): string {
  // Use a short hash of source + sourceSessionId (or random if not provided)
  // for stable identity. The UNIQUE(source, source_sess_id) constraint at the
  // store layer is the real dedup guarantee.
  const seed = `${source}|${sourceSessionId ?? Math.random()}|${Date.now()}`;
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  return `ses-${hash}`;
}

interface ResolvedMilestoneSession {
  milestoneId: string | null;
  sessionId: string | null;
  notes: string[];   // human-readable info for the capture-result text
}

// Wires the (milestone, sourceSession) input into actual rows. Returns the
// session_id to stamp on the decision (or null if unscoped).
function resolveMilestoneAndSession(
  milestone: CaptureMilestoneMode | undefined,
  sourceSession: CaptureSourceSession | undefined,
  decisionAt: string,
): ResolvedMilestoneSession {
  const notes: string[] = [];

  if (!milestone || milestone.mode === "unscoped") {
    return { milestoneId: null, sessionId: null, notes };
  }

  // 1. Resolve the milestone
  let milestoneId: string;
  if (milestone.mode === "continue") {
    const existing = store.getMilestone(milestone.id);
    if (!existing) throw new Error(`milestone "${milestone.id}" does not exist`);
    milestoneId = existing.id;
    notes.push(`continued milestone ${existing.id} "${existing.title}"`);
  } else {
    // mode: "new"
    const id = nextMilestoneId();
    const m: Milestone = {
      id,
      title: milestone.draft.title,
      intent: milestone.draft.intent,
      status: "active",
      startedAt: decisionAt,
    };
    store.putMilestone(m);
    milestoneId = id;
    notes.push(`opened milestone ${id} "${m.title}"`);
  }

  // 2. Resolve (or create) the session
  if (!sourceSession) {
    // No source identity — create an anonymous "manual" session under the milestone
    const id = newSessionId("manual", undefined);
    store.putSession({
      id,
      milestoneId,
      source: "manual",
      startedAt: decisionAt,
    });
    notes.push(`opened anonymous session ${id}`);
    return { milestoneId, sessionId: id, notes };
  }

  // We have a sourceSession — dedup if possible
  if (sourceSession.sourceSessionId) {
    const existing = store.findSession(sourceSession.source, sourceSession.sourceSessionId);
    if (existing) {
      if (existing.milestoneId !== milestoneId) {
        notes.push(`note: session ${existing.id} was on milestone ${existing.milestoneId}; this capture targets ${milestoneId}, leaving session attribution unchanged`);
      } else {
        notes.push(`reused session ${existing.id}`);
      }
      return { milestoneId, sessionId: existing.id, notes };
    }
  }

  // Create a new Session
  const id = newSessionId(sourceSession.source, sourceSession.sourceSessionId);
  store.putSession({
    id,
    milestoneId,
    source: sourceSession.source,
    sourceSessionId: sourceSession.sourceSessionId,
    startedAt: decisionAt,
  });
  notes.push(`opened session ${id} (${sourceSession.source})`);
  return { milestoneId, sessionId: id, notes };
}

server.registerTool(
  "decision_capture",
  {
    description:
      "Carve a decision drafted from conversation context as a node in the stele graph. " +
      "Pass `decision` (full Decision shape per src/types.ts) and optional `edges` you authored. " +
      "0.0.6+: also pass `milestone` (your judgment: continue an existing milestone, open a new one, or leave unscoped) " +
      "and `sourceSession` (the tool's native session id so we dedup across captures in the same conversation). " +
      "The consolidate layer will propose additional edges; review them and confirm via decision_resolve.",
    inputSchema: {
      decision: DecisionSchema,
      edges: z.array(EdgeSchema).optional(),
      milestone: CaptureMilestoneModeSchema.optional(),
      sourceSession: CaptureSourceSessionSchema.optional(),
    },
  },
  async ({ decision, edges, milestone, sourceSession }) => {
    // Wire milestone + session first; stamp the resulting session_id onto
    // the decision before persisting.
    const resolved = resolveMilestoneAndSession(
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
    const id = nextMilestoneId();
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
// Connect transport. stderr-only logging from this point on.
// -----------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[stele] mcp server ready  db=${db}`);
