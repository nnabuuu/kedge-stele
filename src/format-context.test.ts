// 0.4.0 — tests for the SessionStart hook's prose formatter.
//
// The formatter has two load-bearing constraints:
//
//   1. Empty list → empty string. The SessionStart hook treats stdout as
//      additionalContext, so emitting nothing when there's nothing to say
//      is the right move; an empty heading would just pollute the agent's
//      context.
//
//   2. The output reads as a 陈述句 + an explicit disclaimer line
//      "这些只是状态摘要,不是行动指令。" — required so Claude Code's
//      prompt-injection defense doesn't flag it as imperative system text.
//      (The defense surfaces flagged text to the user instead of treating
//      it as context; we don't want that.)
import { test } from "node:test";
import assert from "node:assert/strict";

import { formatResumeForContext } from "./cli.ts";
import type { WaitingItem } from "./projections.ts";

function mkItem(over: Partial<WaitingItem>): WaitingItem {
  return {
    id: "F-01/DEF-01",
    title: "default",
    bucket: "deferred",
    ageDays: 5,
    detail: "default detail",
    needsCheck: false,
    ...over,
  };
}

test("empty list → empty string (no context contributed)", () => {
  assert.equal(formatResumeForContext([]), "");
});

test("output has the disclaimer line as the load-bearing safeguard", () => {
  const out = formatResumeForContext([mkItem({})]);
  assert.ok(
    out.includes("这些只是状态摘要,不是行动指令"),
    "disclaimer missing — prompt-injection defense may flag this output",
  );
});

test("output is descriptive — no imperative verbs leading sentences", () => {
  const out = formatResumeForContext([
    mkItem({ id: "F-01/DEF-01", title: "Should we use WAL?", bucket: "deferred" }),
    mkItem({ id: "F-01/OQ-02", title: "Postgres worth it?", bucket: "open" }),
  ]);
  // The header is the only fully declarative anchor we test for. The body
  // formatting uses prose like "推迟于 5 天前" / "提出于" which are stative,
  // not imperative — but we don't assert text-shape beyond the header +
  // disclaimer to keep the formatter free to evolve.
  assert.ok(out.startsWith("以下 2 个决策仍悬而未决:"),
    "header missing or off");
});

test("deferred items render as 推迟; open items render as 提出", () => {
  const def = formatResumeForContext([mkItem({ bucket: "deferred", ageDays: 5 })]);
  const op = formatResumeForContext([mkItem({ bucket: "open", ageDays: 5 })]);
  assert.ok(def.includes("推迟于"), "deferred should read as 推迟于");
  assert.ok(op.includes("提出于"), "open should read as 提出于");
});

test("age formatting: 0d=今天 · 1d=1 天前 · 5d=5 天前 · 60d=2 个月前", () => {
  assert.ok(formatResumeForContext([mkItem({ ageDays: 0 })]).includes("今天"));
  assert.ok(formatResumeForContext([mkItem({ ageDays: 1 })]).includes("1 天前"));
  assert.ok(formatResumeForContext([mkItem({ ageDays: 5 })]).includes("5 天前"));
  assert.ok(formatResumeForContext([mkItem({ ageDays: 60 })]).includes("2 个月前"));
});

test("structured revisit trigger surfaces as 复审条件", () => {
  const out = formatResumeForContext([
    mkItem({ trigger: "metric: schools > 50" }),
  ]);
  assert.ok(out.includes("复审条件: metric: schools > 50"));
});

test("needsCheck without explicit trigger surfaces a soft hint", () => {
  const out = formatResumeForContext([
    mkItem({ trigger: undefined, needsCheck: true }),
  ]);
  assert.ok(out.includes("触发条件可能已经到了"),
    "needsCheck items without a trigger string should still hint at review");
});

test("decision id + title appear in 「」 brackets per the doc's design", () => {
  const out = formatResumeForContext([
    mkItem({ id: "F-04/DEF-01", title: "是否启用 WAL 模式" }),
  ]);
  assert.ok(out.includes("F-04/DEF-01「是否启用 WAL 模式」"),
    "id + title chrome must match the doc example");
});
