// Tag policy engine — added 0.0.7.
//
// The agent doesn't get free reign over the project's tag namespace. The
// local `tag_policy` config (`auto` | `propose` | `locked`, stored in the
// per-project config table) decides what happens when the agent asks for
// a tag that doesn't exist yet:
//
//   - auto:    create immediately, status='active', origin='agent'
//   - propose: queue into tag_proposals (default), require a reason if
//              `tag_require_reason` is true (also the default)
//   - locked:  log to tag_proposals with outcome='blocked'; nothing else
//
// Existing active tags are always applied directly — policy gates only new
// tag CREATION, not RE-USE.
import { createHash, randomBytes } from "node:crypto";

import type { Store } from "./store.ts";
import type {
  CaptureTagRequest,
  Tag,
  TagPolicy,
  TagProposal,
  TaggingTargetKind,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TagContext {
  reason?: string;
  suggestedColor?: string;
  targets: { kind: TaggingTargetKind; id: string }[];
}

export type EnsureTagResult =
  | { kind: "active"; tag: Tag }
  | { kind: "pending"; proposal: TagProposal }
  | { kind: "blocked"; proposal: TagProposal };

// ---------------------------------------------------------------------------
// Config keys + defaults
// ---------------------------------------------------------------------------

export const CONFIG_TAG_POLICY = "tag_policy";
export const CONFIG_TAG_REQUIRE_REASON = "tag_require_reason";

export const DEFAULT_TAG_POLICY: TagPolicy = "propose";
export const DEFAULT_TAG_REQUIRE_REASON = true;

export function getTagPolicy(store: Store): TagPolicy {
  const v = store.getConfig(CONFIG_TAG_POLICY);
  if (v === "auto" || v === "propose" || v === "locked") return v;
  return DEFAULT_TAG_POLICY;
}

export function getTagRequireReason(store: Store): boolean {
  const v = store.getConfig(CONFIG_TAG_REQUIRE_REASON);
  if (v === null) return DEFAULT_TAG_REQUIRE_REASON;
  // any explicit string except "false" / "0" reads as true
  return !(v === "false" || v === "0");
}

// ---------------------------------------------------------------------------
// ID + color generation
// ---------------------------------------------------------------------------

export function genTagId(): string {
  return `tag-${randomBytes(4).toString("hex")}`;
}

export function genProposalId(): string {
  return `tp-${randomBytes(4).toString("hex")}`;
}

// Deterministic-looking colour from the name so an agent-created tag has a
// stable default visual until a human re-colours it. Picks from a small
// palette of pre-set hex values that look OK on the in-house design tokens.
const TAG_PALETTE = [
  "#0d5245", "#3a3185", "#7a4d0e", "#942929",
  "#2d6612", "#1c1c1a", "#5c5b56", "#6a1b6a",
  "#1f4f7c", "#7c4810",
];

export function defaultColorForName(name: string): string {
  const h = createHash("sha256").update(name.toLowerCase()).digest();
  return TAG_PALETTE[h[0] % TAG_PALETTE.length];
}

// ---------------------------------------------------------------------------
// The main entry point — called by decision_capture and tag_propose
// ---------------------------------------------------------------------------

export function ensureTag(store: Store, name: string, ctx: TagContext): EnsureTagResult {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("tag name must not be empty");

  // 1. Existing active tag → use it, apply to targets, done.
  const existing = store.findTagByName(trimmedName);
  if (existing && existing.status === "active") {
    for (const t of ctx.targets) {
      store.upsertTagging({ tagId: existing.id, targetKind: t.kind, targetId: t.id });
    }
    return { kind: "active", tag: existing };
  }
  // 2. Existing archived tag — treated as "doesn't exist" for the agent's
  //    purposes (forcing it to either restore manually or pick a new name).

  // 3. Brand-new tag → consult policy.
  const policy = getTagPolicy(store);
  const now = new Date().toISOString();

  if (policy === "auto") {
    const tag: Tag = {
      id: genTagId(),
      name: trimmedName,
      color: ctx.suggestedColor ?? defaultColorForName(trimmedName),
      kind: "scope",
      origin: "agent",
      status: "active",
      createdAt: now,
    };
    store.putTag(tag);
    for (const t of ctx.targets) {
      store.upsertTagging({ tagId: tag.id, targetKind: t.kind, targetId: t.id });
    }
    // Record in proposals as auto_adopted so the UI can audit agent activity.
    store.upsertProposalByName({
      id: genProposalId(),
      name: trimmedName,
      suggestedColor: ctx.suggestedColor,
      reason: ctx.reason,
      targets: ctx.targets,
      outcome: "auto_adopted",
      createdAt: now,
    });
    return { kind: "active", tag };
  }

  if (policy === "propose") {
    if (getTagRequireReason(store) && !ctx.reason) {
      throw new Error(
        `tag policy is 'propose' and tag_require_reason=true — agent must supply a reason for new tag "${trimmedName}"`,
      );
    }
    const proposal = store.upsertProposalByName({
      id: genProposalId(),
      name: trimmedName,
      suggestedColor: ctx.suggestedColor,
      reason: ctx.reason,
      targets: ctx.targets,
      outcome: "pending",
      createdAt: now,
    });
    return { kind: "pending", proposal };
  }

  // policy === "locked"
  const proposal = store.upsertProposalByName({
    id: genProposalId(),
    name: trimmedName,
    suggestedColor: ctx.suggestedColor,
    reason: ctx.reason,
    targets: ctx.targets,
    outcome: "blocked",
    createdAt: now,
  });
  return { kind: "blocked", proposal };
}

// ---------------------------------------------------------------------------
// User-side: confirm / reject a proposal
// ---------------------------------------------------------------------------

export interface ConfirmProposalResult {
  tag: Tag;
  taggingsAdded: number;
}

export function confirmProposal(
  store: Store,
  proposalId: string,
  opts?: { rename?: string; color?: string },
): ConfirmProposalResult {
  const proposal = store.getTagProposal(proposalId);
  if (!proposal) throw new Error(`no such proposal: ${proposalId}`);

  const finalName = opts?.rename?.trim() || proposal.name;
  const finalColor = opts?.color ?? proposal.suggestedColor ?? defaultColorForName(finalName);

  // Was the same name already created in the meantime?
  let tag = store.findTagByName(finalName);
  if (tag && tag.status === "active") {
    // Just use it
  } else {
    tag = {
      id: genTagId(),
      name: finalName,
      color: finalColor,
      kind: "scope",
      origin: "you",
      status: "active",
      createdAt: new Date().toISOString(),
    };
    store.putTag(tag);
  }

  let added = 0;
  for (const t of proposal.targets) {
    // upsertTagging is idempotent; we count by checking if the row was new.
    // (SQLite's INSERT OR IGNORE returns changes=0 for ignore.)
    const existing = store.taggingsForTarget(t.kind, t.id).some((existingTag) => existingTag.id === tag!.id);
    if (!existing) {
      store.upsertTagging({ tagId: tag.id, targetKind: t.kind, targetId: t.id });
      added++;
    }
  }
  store.deleteTagProposal(proposalId);
  return { tag, taggingsAdded: added };
}

export function rejectProposal(store: Store, proposalId: string): boolean {
  return store.deleteTagProposal(proposalId);
}

// ---------------------------------------------------------------------------
// Batched: apply many CaptureTagRequest at once and collate outcomes
// ---------------------------------------------------------------------------

export interface TagCaptureResult {
  applied: { name: string; tagId: string }[];
  pending: { name: string; proposalId: string }[];
  blocked: { name: string; proposalId: string }[];
  errors: { name: string; message: string }[];
}

export function applyCaptureTags(
  store: Store,
  requests: CaptureTagRequest[],
  decisionId: string,
): TagCaptureResult {
  const out: TagCaptureResult = { applied: [], pending: [], blocked: [], errors: [] };
  for (const req of requests) {
    try {
      const r = ensureTag(store, req.name, {
        reason: req.reason,
        suggestedColor: req.suggestedColor,
        targets: [{ kind: "decision", id: decisionId }],
      });
      if (r.kind === "active") out.applied.push({ name: req.name, tagId: r.tag.id });
      else if (r.kind === "pending") out.pending.push({ name: req.name, proposalId: r.proposal.id });
      else out.blocked.push({ name: req.name, proposalId: r.proposal.id });
    } catch (e) {
      out.errors.push({ name: req.name, message: (e as Error).message });
    }
  }
  return out;
}
