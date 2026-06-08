import type { Store } from "./store.ts";
import type { Decision, DecisionId, EntityRef, Trigger } from "./types.ts";
import type { EntityResolver } from "./resolver.ts";

const DAY = 86_400_000;

function ageDays(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / DAY));
}

function triggerText(t: Trigger): string {
  switch (t.kind) {
    case "manual": return "手动复审";
    case "metric": return `指标: ${t.expr}`;
    case "event": return `事件: ${t.name}`;
    case "dependency": return `依赖: ${t.on}`;
  }
}

// A deferred node's trigger may have fired. The POC can't evaluate metric/event
// triggers (no live metrics), so it flags them as "needs check" rather than
// silently leaving them buried — which is exactly the ADHD failure mode to avoid.
function triggerNeedsCheck(store: Store, t: Trigger): boolean {
  if (t.kind === "metric" || t.kind === "event") return true;
  if (t.kind === "dependency") {
    const dep = store.getDecision(t.on);
    return !!dep && (dep.status.kind === "decided" || dep.status.kind === "resolved");
  }
  return false;
}

export interface WaitingItem {
  id: DecisionId;
  title: string;
  bucket: "open" | "deferred";
  ageDays: number;
  detail: string;       // the question (open) or the reason (deferred)
  trigger?: string;     // deferred only
  needsCheck: boolean;  // trigger may have fired
}

// "什么在等我" — every genuine open loop, externalised so it doesn't live in your head.
export function resumeDigest(store: Store): WaitingItem[] {
  const items: WaitingItem[] = [];

  for (const d of store.byStatusKind("open")) {
    const q = d.status.kind === "open" ? d.status.question : d.title;
    items.push({
      id: d.id, title: d.title, bucket: "open",
      ageDays: ageDays(d.raisedBy.at), detail: q, needsCheck: false,
    });
  }

  for (const d of store.byStatusKind("deferred")) {
    if (store.isResolved(d.id)) continue; // already stitched closed by a later decision
    if (d.status.kind !== "deferred") continue;
    items.push({
      id: d.id, title: d.title, bucket: "deferred",
      ageDays: ageDays(d.raisedBy.at), detail: d.status.reason,
      trigger: triggerText(d.status.revisitWhen),
      needsCheck: triggerNeedsCheck(store, d.status.revisitWhen),
    });
  }

  // needs-check first, then oldest first — surface the things most likely to be due.
  return items.sort((a, b) => Number(b.needsCheck) - Number(a.needsCheck) || b.ageDays - a.ageDays);
}

export interface TraceEdge {
  kind: string;
  otherId: DecisionId;
  otherTitle: string;
  direction: "out" | "in";
  note?: string;
}

export interface Trace {
  decision: Decision;
  statusLine: string;
  affects: { ref: EntityRef; label: string; href?: string }[];
  edges: TraceEdge[];
}

function statusLine(store: Store, d: Decision): string {
  const s = d.status;
  switch (s.kind) {
    case "open": return `OPEN — ${s.question}`;
    case "decided": {
      const chosen = s.options.find((o) => o.verdict === "chosen");
      return `DECIDED — 选了 ${chosen ? chosen.label + ": " + chosen.summary : "?"}`;
    }
    case "deferred": return `DEFERRED — ${s.reason} (复审: ${triggerText(s.revisitWhen)})`;
    case "resolved": {
      const by = store.getDecision(s.by);
      return `RESOLVED — 由 ${s.by}${by ? " (" + by.title + ")" : ""} 解决`;
    }
    case "superseded": return `SUPERSEDED — 被 ${s.by} 取代`;
    case "conflicted": return `CONFLICTED — ${s.between.join(" × ")} @ ${s.path}`;
  }
}

// "这件事是怎么发生的" — associative, anchored on a node or an entity, not a timeline.
export async function trace(store: Store, id: DecisionId, resolver: EntityResolver): Promise<Trace | null> {
  const d = store.getDecision(id);
  if (!d) return null;

  const edges: TraceEdge[] = [];
  for (const e of store.edgesFrom(id)) {
    const o = store.getDecision(e.to);
    edges.push({ kind: e.kind, otherId: e.to, otherTitle: o?.title ?? "?", direction: "out", note: e.note });
  }
  for (const e of store.edgesTo(id)) {
    const o = store.getDecision(e.from);
    edges.push({ kind: e.kind, otherId: e.from, otherTitle: o?.title ?? "?", direction: "in", note: e.note });
  }

  const affects: Trace["affects"] = [];
  for (const ref of d.affects) {
    const r = await resolver.resolve(ref);
    affects.push({ ref, label: r?.label ?? `${ref.kind}:${ref.id}`, href: r?.href });
  }

  return { decision: d, statusLine: statusLine(store, d), affects, edges };
}

// Trace anchored on an entity: "everything related to this file / feature / skill".
export async function traceEntity(store: Store, ref: EntityRef, resolver: EntityResolver): Promise<Trace[]> {
  const ds = store.decisionsAffecting(ref);
  const out: Trace[] = [];
  for (const d of ds) {
    const t = await trace(store, d.id, resolver);
    if (t) out.push(t);
  }
  return out;
}
