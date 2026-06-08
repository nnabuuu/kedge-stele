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
  for (const raw of s.toLowerCase().split(/[^a-z0-9_\u4e00-\u9fff]+/)) {
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

// Given a freshly captured decision, look at every still-pending node (open, or
// deferred without a resolving edge) and propose how the new one might relate.
// In the real system the Evaluator agent reviews these; here they're printed for
// the human to confirm in the same `/decision` turn that captured the node.
export function proposeEdges(store: Store, incoming: Decision): EdgeCandidate[] {
  const pending = [...store.byStatusKind("open"), ...store.byStatusKind("deferred")].filter(
    (d) => d.id !== incoming.id && !store.isResolved(d.id)
  );

  const inTok = tokens(
    incoming.title + " " + (incoming.constraint ?? "") + " " + incoming.raisedBy.trigger
  );

  const out: EdgeCandidate[] = [];
  for (const p of pending) {
    const pTok = tokens(p.title + " " + (p.status.kind === "deferred" ? p.status.reason : ""));
    const sim = jaccard(inTok, pTok);
    const ent = sharesEntity(incoming, p);

    if (!ent && sim < 0.12) continue;

    // High overlap on a pending node → likely the new decision answers it.
    const looksLikeResolution = sim >= 0.18 || (ent && sim >= 0.1);
    const kind = looksLikeResolution ? "resolves" : "relates";
    const confidence = Math.min(1, sim + (ent ? 0.25 : 0));
    const reasonBits: string[] = [];
    if (ent) reasonBits.push("touches the same entity");
    if (sim > 0) reasonBits.push(`title/reason overlap ${(sim * 100) | 0}%`);

    out.push({
      edge: { from: incoming.id, to: p.id, kind, note: `auto: ${reasonBits.join(", ")}` },
      confidence,
      reason: `${incoming.id} may ${kind === "resolves" ? "resolve" : "relate to"} ${p.id} (${p.title}) — ${reasonBits.join(", ")}`,
    });
  }

  return out.sort((a, b) => b.confidence - a.confidence);
}
