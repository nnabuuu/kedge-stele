// Consolidate layer — when a Decision is captured, look at every still-
// pending node (open, or deferred without a resolving edge) and propose how
// the new one might relate. The Evaluator agent's seat: heuristic match,
// human confirms via `decision_resolve`.
//
// 0.1.0 changes:
//   • Walk the pending set via `byDecisionType` (Status union is gone).
//   • Read the prose trigger from `detail.trigger` instead of `status.reason`.
//   • Edges now use `relation` (was `kind`); we propose `resolves` and
//     `relates`. We never auto-propose `depends_on` — that's authored.
import type { Store } from "./store.ts";
import type { Decision, Edge, EntityRef } from "./types.ts";

export interface EdgeCandidate {
  edge: Edge;
  confidence: number; // 0..1
  reason: string;
}

const STOP = new Set([
  "the", "a", "an", "to", "of", "and", "or", "is", "in", "on", "for", "with",
  "怎么", "如何", "还是", "什么", "用", "做", "给", "的", "了", "吗", "放", "哪个",
]);

function tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9_一-鿿]+/)) {
    const t = raw.trim();
    if (t.length >= 2 && !STOP.has(t)) out.add(t);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function refKey(r: EntityRef): string {
  return `${r.kind}:${r.id}`;
}

function sharesEntity(a: Decision, b: Decision): boolean {
  const set = new Set(a.affects.map(refKey));
  return b.affects.some((r) => set.has(refKey(r)));
}

function pendingText(d: Decision): string {
  // Combine fields most likely to carry the gist of the pending question:
  // title + the prose trigger that lives in detail.
  return d.title + " " + (d.detail?.trigger ?? "") + " " + (d.detail?.constraint ?? "");
}

function incomingText(d: Decision): string {
  return (
    d.title + " " +
    (d.detail?.trigger ?? "") + " " +
    (d.detail?.constraint ?? "") + " " +
    d.raisedBy.trigger
  );
}

// "Pending" = open, OR deferred-and-not-yet-resolved.
function pendingNodes(store: Store, incomingId: string): Decision[] {
  return [
    ...store.byDecisionType("open"),
    ...store.byDecisionType("deferred"),
  ].filter((d) => d.id !== incomingId && d.status !== "resolved" && !store.isResolved(d.id));
}

export function proposeEdges(store: Store, incoming: Decision): EdgeCandidate[] {
  const pending = pendingNodes(store, incoming.id);
  const inTok = tokens(incomingText(incoming));

  const out: EdgeCandidate[] = [];
  for (const p of pending) {
    const pTok = tokens(pendingText(p));
    const sim = jaccard(inTok, pTok);
    const ent = sharesEntity(incoming, p);

    if (!ent && sim < 0.12) continue;

    // High overlap on a pending node → likely the new decision answers it.
    const looksLikeResolution = sim >= 0.18 || (ent && sim >= 0.1);
    const relation = looksLikeResolution ? "resolves" : "relates";
    const confidence = Math.min(1, sim + (ent ? 0.25 : 0));
    const reasonBits: string[] = [];
    if (ent) reasonBits.push("touches the same entity");
    if (sim > 0) reasonBits.push(`title/reason overlap ${(sim * 100) | 0}%`);

    out.push({
      edge: { from: incoming.id, to: p.id, relation, note: `auto: ${reasonBits.join(", ")}` },
      confidence,
      reason: `${incoming.id} may ${relation === "resolves" ? "resolve" : "relate to"} ${p.id} (${p.title}) — ${reasonBits.join(", ")}`,
    });
  }

  return out.sort((a, b) => b.confidence - a.confidence);
}
