#!/usr/bin/env bash
# stele SessionStart hook — read-side inject + capture context
#
# Fires once when a Claude Code session starts (or resumes) in a stele-
# initialized project. Emits a declarative-prose context block to stdout;
# Claude Code injects it as additionalContext, so the agent sees:
#
#   • cc_session_id (so it can pass sourceSession.sourceSessionId
#     through decision_capture and keep multi-capture sessions glued)
#   • active features in state='going' (so feature.mode='continue' is a
#     no-roundtrip choice when a decision crystallizes)
#   • the project's tag policy + active tags (so tag judgment is a no-
#     roundtrip choice too)
#   • open loops via `stele resume --for-context` (the resume digest)
#
# 0.4.0-snapshot.10: this hook is now THE injection point. The Stop
# hook (with its 12 bilingual regex patterns) is gone — the agent
# self-governs when to capture. SessionStart loads the context once;
# the agent reads it through the rest of the session.
#
# Long sessions may compact this context out of the agent's window.
# Acceptable: cc_session_id falls back to anonymous on subsequent
# captures; agent re-queries feature_list / tag list via MCP when
# stale. Trade for cleanliness — no per-turn nag, no regex maintenance.
#
# Per the doc's prompt-injection warning, every section is declarative
# (陈述句) and the block closes with the "this is state, not a
# directive" disclaimer so Claude Code's prompt-injection defense
# doesn't surface it raw to the user.
#
# Synchronous (no `async`) — it's a few cheap SQLite reads.

set -u

if ! command -v stele >/dev/null 2>&1; then
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

payload="$(cat)"
cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty')"
session_id="$(printf '%s' "$payload" | jq -r '.session_id // empty')"

if [ -z "$cwd" ] || [ ! -d "$cwd/.stele" ]; then
  exit 0
fi

# Build each section into a temp variable so we can collapse empties.

# 1. cc_session_id — comes straight from the hook payload, no SQLite read.
sid_section=""
if [ -n "$session_id" ]; then
  sid_section="cc_session_id=$session_id"
fi

# 2. Active features (state=going). Empty when no features exist.
features_section=""
features_json="$(cd "$cwd" && stele features list --state going --json 2>/dev/null)"
if [ -n "$features_json" ] && [ "$features_json" != "[]" ]; then
  features_lines="$(printf '%s' "$features_json" | jq -r '.[] | "  - \(.feature.id) \"\(.feature.name)\" (\(.openLoops) open loops, started \(.feature.startedAt[:10]))"' 2>/dev/null)"
  if [ -n "$features_lines" ]; then
    features_section="活动 feature (state=going):
$features_lines"
  fi
fi

# 3. Tag policy + active tags. Both best-effort.
tags_section=""
tag_policy="$(cd "$cwd" && stele config get tag_policy 2>/dev/null | sed -n 's/^tag_policy = //p' | awk '{print $1}')"
tags_json="$(cd "$cwd" && stele tags list --json 2>/dev/null)"
tags_lines=""
if [ -n "$tags_json" ] && [ "$tags_json" != "[]" ]; then
  tags_lines="$(printf '%s' "$tags_json" | jq -r '.[] | "  - \(.name) (\(.targetCount) target\(if .targetCount == 1 then "" else "s" end))"' 2>/dev/null | head -10)"
fi
if [ -n "$tag_policy" ] || [ -n "$tags_lines" ]; then
  tags_section="tag policy: ${tag_policy:-propose}"
  if [ -n "$tags_lines" ]; then
    tags_section="$tags_section
活动 tags:
$tags_lines"
  fi
fi

# 4. Main language preference. Free-text — the user sets whatever
#    string they want (e.g. "中文", "English", "日本語",
#    "中文，专有名词保留英文"). Default: unset (agent uses whatever
#    language the current conversation is in). Affects free-text
#    fields on captured decisions; technical terms / IDs / file paths
#    / proper nouns stay verbatim regardless.
lang_section=""
lang_raw="$(cd "$cwd" && stele config get main_language 2>/dev/null | sed -n 's/^main_language = //p')"
if [ -n "$lang_raw" ] && [ "$lang_raw" != "(unset)" ]; then
  lang_section="主语言 / main language: $lang_raw
自由文本字段 (title / context / detail.* / summary / rationale) 一律用此语言;
technical terms, IDs, file paths, code identifiers, proper nouns — preserve as-is."
fi

# 5. Open loops via the existing CLI flag. Already comes with its own
#    declarative prose + closing disclaimer. We append it AFTER our
#    sections (so the agent reads "what's around" first, then "what's
#    waiting").
resume_block="$( ( cd "$cwd" && stele resume --for-context 2>/dev/null ) || true )"

# Assemble. If nothing landed in any section, exit silently — the
# hook contributes no context, which is the right move on an empty
# project.
if [ -z "$sid_section" ] && [ -z "$features_section" ] && [ -z "$tags_section" ] && [ -z "$lang_section" ] && [ -z "$resume_block" ]; then
  exit 0
fi

# Compose with newlines between non-empty sections.
{
  printf '[stele context for %s]\n' "$(basename "$cwd")"
  if [ -n "$sid_section" ]; then printf '\n%s\n' "$sid_section"; fi
  if [ -n "$features_section" ]; then printf '\n%s\n' "$features_section"; fi
  if [ -n "$tags_section" ]; then printf '\n%s\n' "$tags_section"; fi
  if [ -n "$lang_section" ]; then printf '\n%s\n' "$lang_section"; fi
  # 6. Standing capture criteria — short prose, no imperatives. The
  #    skill's SKILL.md carries the longer reference; this is the in-
  #    line nudge so the agent doesn't have to load the skill before
  #    noticing a capture-worthy moment.
  printf '\n%s\n' "如果在这次对话里出现一个真正的决策 —— 在选项间做了选择、显式 defer 了某个问题、锁定了某个约束 —— 用 mcp__stele__decision_capture 记一下,传 source='agent-live' + 一个 confidence。判断"是不是决策"是你的事。 stele-capture skill 有字段细节,需要时按需 Read。"
  if [ -n "$resume_block" ]; then printf '\n%s\n' "$resume_block"; fi
} | cat

exit 0
