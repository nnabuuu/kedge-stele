#!/usr/bin/env bash
# stele decision detector — Stop hook (Layer 1, live-track capture)
#
# Stop hook payload arrives on stdin as JSON:
#   { session_id, transcript_path, cwd, permission_mode, hook_event_name, response_text }
#
# We scan `response_text` (Claude's reply that's about to end the turn) for
# decision-y language. On a hit, we emit `hookSpecificOutput.additionalContext`
# telling the LIVE agent to call decision_capture RIGHT NOW with
# source='agent-live' — not "load a skill and consider drafting", which the
# 0.3.0 phrasing did. Live capture has the full conversation context, so
# this is the highest-fidelity layer of the three-layer model.
#
# The post-hoc SessionEnd subagent (Layer 3, phase 4) backstops anything
# the live agent misses. Both write via decision_capture; dedup_key
# collapses any overlap.
#
# Set STELE_HOOK_DEBUG=1 to log matched signals to stderr.
#
# Dependencies: jq. Bail out silently if jq is missing — better to be invisible
# than to break Claude's flow.
set -u

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

# Read stdin JSON
payload="$(cat)"

response_text="$(printf '%s' "$payload" | jq -r '.response_text // ""')"
cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty')"

# Regex signals — keep conservative (false positives nag the user).
# We OR them into a single grep -E pattern.
patterns=(
  # Chinese — "we decided / chose X over Y / defer this / lock in"
  '(我们|咱们)?决定[了]?'
  '选(择|了|定)[ 	]*[^ 	。,、]+[ 	]*(而不是|不选|不用|不要)'
  '(先|暂时)[ 	]*(defer|推迟|不做|搁置|放一放)'
  '锁定[ 	]*[了在]'
  '排除[ 	]*[了]?[ 	]*这[个种]?方案'
  # English
  "we'll go with"
  "we will go with"
  "decided to "
  "chose .* over "
  "going to defer"
  "deferred (this|that|for now)"
  "locking (in|out)"
)

# Build a single alternation.
joined="$(IFS='|'; echo "${patterns[*]}")"

if printf '%s' "$response_text" | grep -qE "$joined"; then
  # Hit. Log if debug.
  if [ "${STELE_HOOK_DEBUG:-0}" = "1" ]; then
    matched="$(printf '%s' "$response_text" | grep -oE "$joined" | head -1)"
    echo "[stele hook] matched: $matched" >&2
  fi

  # Also log to .stele/hooks.log inside the project, best-effort.
  if [ -n "$cwd" ] && [ -d "$cwd/.stele" ]; then
    matched="$(printf '%s' "$response_text" | grep -oE "$joined" | head -1)"
    printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$matched" \
      >> "$cwd/.stele/hooks.log" 2>/dev/null || true
  fi

  # 0.3.0 — fetch active features (state=going) so the skill can make a
  # continue-vs-new judgment without a separate MCP roundtrip. Best-effort:
  # if stele isn't on PATH or the project isn't initialized, skip.
  features_block=""
  if command -v stele >/dev/null 2>&1 && [ -n "$cwd" ] && [ -d "$cwd/.stele" ]; then
    features_json="$(cd "$cwd" && stele features list --state going --json 2>/dev/null)"
    if [ -n "$features_json" ] && [ "$features_json" != "[]" ]; then
      features_block="$(printf '%s' "$features_json" | jq -r '.[] | "  - \(.feature.id) \"\(.feature.name)\" (started \(.feature.startedAt[:10]), \(.openLoops) open loops)"' 2>/dev/null)"
    fi
  fi

  # 0.0.7 — fetch active tags + current tag_policy so the skill knows what's
  # available (apply existing) vs what needs proposing (new), and whether the
  # propose flow even works (locked → don't bother). Best-effort.
  tags_block=""
  tag_policy_block=""
  if command -v stele >/dev/null 2>&1 && [ -n "$cwd" ] && [ -d "$cwd/.stele" ]; then
    tag_policy_block="$(cd "$cwd" && stele config get tag_policy 2>/dev/null | sed -n 's/^tag_policy = //p' | awk '{print $1}')"
    tags_json="$(cd "$cwd" && stele tags list --json 2>/dev/null)"
    if [ -n "$tags_json" ] && [ "$tags_json" != "[]" ]; then
      tags_block="$(printf '%s' "$tags_json" | jq -r '.[] | "  - \(.name)  (\(.id), \(.targetCount) target\(if .targetCount == 1 then "" else "s" end))"' 2>/dev/null)"
    fi
  fi

  # Pull Claude Code's native session_id from the payload so the skill can
  # pass it through as sourceSessionId — keeps multiple captures in one
  # conversation glued to one Session.
  claude_sid="$(printf '%s' "$payload" | jq -r '.session_id // empty')"

  context="stele decision detector: 上一轮检测到决策迹象。

LIVE-TRACK CAPTURE (Layer 1) — 你刚活过这个决策，上下文最全。如果对话中刚刚有一个决策 crystallize (an option chosen over alternatives, something explicitly deferred, a constraint locked in), 立刻调用 decision_capture MCP 工具记录, 并在调用时传入 source='agent-live' + 一个 confidence 数字 (0..1, 表示决策落地的清晰度)。这是 0.4.0 三层捕获模型的第一层 — 现场保真度最高的那一层。

需要 Decision 字段细节, 查 stele-capture skill: SKILL.md (4 步流程) + references/decision-schema.md (字段逐项) + references/feature-judgment.md (feature.mode 怎么选) + references/tag-judgment.md (tags 怎么传) + gotchas.md (10 个常见坑)。但跑这套不要预先全部加载 — 按需 Read。

如果觉得没真正定下来 (只是讨论选项 / 还在权衡), 忽略本提醒不要打扰用户。SessionEnd 的 post-hoc subagent (Layer 3) 会兜底, 它读 transcript 后还会再过一遍 — dedup_key 保证同一个决策不会被重复落库, 所以你这次过滤掉的也不会真丢。"

  if [ -n "$features_block" ]; then
    context="$context

Active features (consult before deciding feature.mode):
$features_block"
  fi

  if [ -n "$tag_policy_block" ]; then
    context="$context

Tag policy: $tag_policy_block — under 'auto' agent-created tags land immediately;
under 'propose' (default) new tags queue for the human; under 'locked' new tag
attempts are refused (don't bother proposing)."
  fi

  if [ -n "$tags_block" ]; then
    context="$context

Active tags (reuse these first; only propose a new name if none fit):
$tags_block"
  fi

  if [ -n "$claude_sid" ]; then
    context="$context

When you call decision_capture, also pass sourceSession: { source: \"claude-code\", sourceSessionId: \"$claude_sid\" } — multiple captures in this same conversation should land on one Session. (This is separate from the top-level source='agent-live' field above; sourceSession identifies the cc_session_id, source classifies the capture path.)"
  fi

  jq -n --arg ctx "$context" '{
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext: $ctx
    }
  }'
  exit 0
fi

# No hit — emit empty object so Claude Code sees a clean response.
echo '{}'
exit 0
