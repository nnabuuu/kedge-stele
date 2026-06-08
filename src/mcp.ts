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
import { proposeEdges } from "./consolidate.ts";
import { resumeDigest, trace, traceEntity } from "./projections.ts";
import { renderResume } from "./render.ts";
import { stubResolver } from "./resolver.ts";
import { resolveDbPath, SteleNotInitializedError } from "./paths.ts";
import { DecisionSchema, EdgeSchema } from "./schemas.ts";
import type { Decision, Edge, EntityRef } from "./types.ts";

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
const server = new McpServer({ name: "stele", version: "0.0.4-snapshot" });

server.registerTool(
  "decision_capture",
  {
    description:
      "Carve a decision drafted from conversation context as a node in the stele graph. " +
      "Pass `decision` (full Decision shape per src/types.ts) and optional `edges` you authored. " +
      "The consolidate layer will propose additional edges; review them and confirm via decision_resolve.",
    inputSchema: { decision: DecisionSchema, edges: z.array(EdgeSchema).optional() },
  },
  async ({ decision, edges }) => {
    const candidates = proposeEdges(store, decision as Decision);
    store.putDecision(decision as Decision);
    for (const e of edges ?? []) store.addEdge(e as Edge);
    return {
      content: [{ type: "text", text: fmtCaptureResult(decision.id, edges?.length ?? 0, candidates) }],
    };
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
// Connect transport. stderr-only logging from this point on.
// -----------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[stele] mcp server ready  db=${db}`);
