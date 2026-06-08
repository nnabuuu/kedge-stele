// Tests for src/tags.ts — the tag policy engine.
//
// Pins the three policy branches (auto/propose/locked), proposal dedup,
// confirm/reject flow, and the require_reason gate.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Store } from "./store.ts";
import {
  CONFIG_TAG_POLICY,
  CONFIG_TAG_REQUIRE_REASON,
  applyCaptureTags,
  confirmProposal,
  defaultColorForName,
  ensureTag,
  getTagPolicy,
  getTagRequireReason,
  rejectProposal,
} from "./tags.ts";

function freshStore(): Store {
  return new Store(":memory:");
}

// ---- Defaults ------------------------------------------------------------

test("default tag_policy is 'propose'", () => {
  const s = freshStore();
  assert.equal(getTagPolicy(s), "propose");
});

test("default tag_require_reason is true", () => {
  const s = freshStore();
  assert.equal(getTagRequireReason(s), true);
});

test("config explicit 'false' / '0' disables require_reason", () => {
  const s = freshStore();
  s.setConfig(CONFIG_TAG_REQUIRE_REASON, "false");
  assert.equal(getTagRequireReason(s), false);
  s.setConfig(CONFIG_TAG_REQUIRE_REASON, "0");
  assert.equal(getTagRequireReason(s), false);
});

test("config invalid policy value falls back to default", () => {
  const s = freshStore();
  s.setConfig(CONFIG_TAG_POLICY, "yolo");
  assert.equal(getTagPolicy(s), "propose");
});

// ---- defaultColorForName -------------------------------------------------

test("defaultColorForName returns a valid hex", () => {
  const c = defaultColorForName("security");
  assert.match(c, /^#[0-9a-f]{6}$/i);
});

test("defaultColorForName is deterministic per name", () => {
  assert.equal(defaultColorForName("X"), defaultColorForName("X"));
});

// ---- policy: existing active tag is always reused -----------------------

test("existing active tag is applied to targets regardless of policy", () => {
  const s = freshStore();
  // Even under locked, an existing tag should re-apply.
  s.setConfig(CONFIG_TAG_POLICY, "locked");
  s.putTag({
    id: "tag-pre", name: "security", color: "#942929",
    kind: "scope", origin: "you", status: "active",
    createdAt: "2026-06-01T00:00:00Z",
  });

  const r = ensureTag(s, "security", {
    targets: [{ kind: "decision", id: "D-1" }],
  });
  assert.equal(r.kind, "active");
  assert.equal(s.taggingsForTarget("decision", "D-1").length, 1);
});

test("ensureTag name lookup is case-insensitive", () => {
  const s = freshStore();
  s.setConfig(CONFIG_TAG_POLICY, "auto");
  ensureTag(s, "Security", { targets: [{ kind: "decision", id: "D-1" }] });
  // Second call with different case should resolve to the same tag
  const second = ensureTag(s, "SECURITY", { targets: [{ kind: "decision", id: "D-2" }] });
  assert.equal(second.kind, "active");
  assert.equal(s.allTags("active").length, 1, "should not create a second tag for case difference");
});

test("archived tag is treated as 'doesn't exist' for the agent", () => {
  const s = freshStore();
  s.setConfig(CONFIG_TAG_POLICY, "propose");
  s.putTag({
    id: "tag-arch", name: "old", color: "#000000",
    kind: "scope", origin: "you", status: "archived",
    createdAt: "2026-06-01T00:00:00Z",
  });
  // Agent asks for "old" → archived tag is skipped; policy applies.
  const r = ensureTag(s, "old", {
    reason: "fresh request",
    targets: [{ kind: "decision", id: "D-1" }],
  });
  assert.equal(r.kind, "pending");
});

// ---- policy: auto --------------------------------------------------------

test("policy=auto creates the tag immediately, origin=agent", () => {
  const s = freshStore();
  s.setConfig(CONFIG_TAG_POLICY, "auto");
  const r = ensureTag(s, "security", {
    targets: [{ kind: "decision", id: "D-1" }],
  });
  assert.equal(r.kind, "active");
  if (r.kind !== "active") return;
  assert.equal(r.tag.origin, "agent");
  assert.equal(r.tag.status, "active");
  assert.equal(s.taggingsForTarget("decision", "D-1")[0].id, r.tag.id);
});

test("policy=auto also records an audit proposal with outcome=auto_adopted", () => {
  const s = freshStore();
  s.setConfig(CONFIG_TAG_POLICY, "auto");
  ensureTag(s, "security", {
    reason: "audit trail",
    targets: [{ kind: "decision", id: "D-1" }],
  });
  const adopted = s.allTagProposals("auto_adopted");
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].name, "security");
});

// ---- policy: propose -----------------------------------------------------

test("policy=propose queues a pending proposal", () => {
  const s = freshStore();
  // default policy is propose; default require_reason is true
  const r = ensureTag(s, "security", {
    reason: "we need a way to surface OWASP-related decisions",
    targets: [{ kind: "decision", id: "D-1" }],
  });
  assert.equal(r.kind, "pending");
  // No live tag yet
  assert.equal(s.findTagByName("security"), null);
  // No tagging applied either (the human will do that on confirm)
  assert.equal(s.taggingsForTarget("decision", "D-1").length, 0);
});

test("policy=propose without reason throws when require_reason=true", () => {
  const s = freshStore();
  assert.throws(
    () =>
      ensureTag(s, "security", {
        targets: [{ kind: "decision", id: "D-1" }],
      }),
    /tag_require_reason/,
  );
});

test("policy=propose allows missing reason when require_reason=false", () => {
  const s = freshStore();
  s.setConfig(CONFIG_TAG_REQUIRE_REASON, "false");
  const r = ensureTag(s, "security", {
    targets: [{ kind: "decision", id: "D-1" }],
  });
  assert.equal(r.kind, "pending");
});

test("policy=propose dedupes same-name pending proposals — merges targets", () => {
  const s = freshStore();
  s.setConfig(CONFIG_TAG_REQUIRE_REASON, "false");
  ensureTag(s, "security", { targets: [{ kind: "decision", id: "D-1" }] });
  ensureTag(s, "security", { targets: [{ kind: "decision", id: "D-2" }] });
  const pending = s.allTagProposals("pending");
  assert.equal(pending.length, 1, "should be one proposal, not two");
  assert.equal(pending[0].targets.length, 2);
});

// ---- policy: locked ------------------------------------------------------

test("policy=locked refuses; records the attempt as blocked", () => {
  const s = freshStore();
  s.setConfig(CONFIG_TAG_POLICY, "locked");
  const r = ensureTag(s, "security", {
    reason: "still trying",
    targets: [{ kind: "decision", id: "D-1" }],
  });
  assert.equal(r.kind, "blocked");
  assert.equal(s.findTagByName("security"), null);
  const blocked = s.allTagProposals("blocked");
  assert.equal(blocked.length, 1);
});

// ---- confirm / reject ---------------------------------------------------

test("confirmProposal creates the tag, applies taggings, deletes proposal", () => {
  const s = freshStore();
  const r = ensureTag(s, "security", {
    reason: "x",
    targets: [{ kind: "decision", id: "D-1" }],
  });
  assert.equal(r.kind, "pending");
  if (r.kind !== "pending") return;
  const confirmed = confirmProposal(s, r.proposal.id);
  assert.equal(confirmed.tag.name, "security");
  assert.equal(confirmed.tag.origin, "you", "human-confirmed tag should have origin=you");
  assert.equal(confirmed.taggingsAdded, 1);
  assert.equal(s.allTagProposals().length, 0, "proposal should be removed");
  assert.equal(s.taggingsForTarget("decision", "D-1")[0].id, confirmed.tag.id);
});

test("confirmProposal can rename the tag at confirmation time", () => {
  const s = freshStore();
  const r = ensureTag(s, "sec", {
    reason: "x",
    targets: [{ kind: "decision", id: "D-1" }],
  });
  if (r.kind !== "pending") throw new Error("expected pending");
  const confirmed = confirmProposal(s, r.proposal.id, { rename: "security" });
  assert.equal(confirmed.tag.name, "security");
});

test("rejectProposal removes the proposal without creating a tag", () => {
  const s = freshStore();
  const r = ensureTag(s, "security", {
    reason: "x",
    targets: [{ kind: "decision", id: "D-1" }],
  });
  if (r.kind !== "pending") throw new Error("expected pending");
  assert.equal(rejectProposal(s, r.proposal.id), true);
  assert.equal(s.findTagByName("security"), null);
  assert.equal(s.allTagProposals().length, 0);
});

// ---- applyCaptureTags batch path ----------------------------------------

test("applyCaptureTags collates outcomes across many requests", () => {
  const s = freshStore();
  // Pre-existing active tag
  s.putTag({
    id: "tag-existing", name: "backend", color: "#0d5245",
    kind: "scope", origin: "you", status: "active",
    createdAt: "2026-06-01T00:00:00Z",
  });
  // Policy: propose, require_reason: false (simpler test)
  s.setConfig(CONFIG_TAG_REQUIRE_REASON, "false");

  const result = applyCaptureTags(
    s,
    [
      { name: "backend" },                  // existing → applied
      { name: "security" },                 // new → pending
      { name: "perf", reason: "speed up" }, // new with reason → pending
    ],
    "D-NEW",
  );

  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].name, "backend");
  assert.equal(result.pending.length, 2);
  assert.equal(result.blocked.length, 0);
  assert.equal(result.errors.length, 0);
});

test("applyCaptureTags reports errors per-tag without aborting the batch", () => {
  const s = freshStore();
  // require_reason on, propose policy by default → empty reason throws
  const result = applyCaptureTags(
    s,
    [
      { name: "with-reason", reason: "ok" },
      { name: "without-reason" },         // should error
      { name: "" },                        // empty name → error
    ],
    "D-NEW",
  );
  // The two error names didn't propose anything
  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0].name, "with-reason");
  assert.ok(result.errors.length >= 2);
});
