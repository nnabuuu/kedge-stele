#!/usr/bin/env bash
# stele decision detector — Stop hook
#
# Stop hook payload arrives on stdin as JSON:
#   { session_id, transcript_path, cwd, permission_mode, hook_event_name, response_text }
#
# We scan `response_text` (Claude's reply that's about to end the turn) for
# decision-y language. On a hit, we emit `hookSpecificOutput.additionalContext`
# nudging Claude to load the stele-capture skill on the next turn.
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

  jq -n '{
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext: "stele decision detector: 上一轮检测到决策迹象。如果对话中刚刚有一个决策 crystallize (an option chosen over alternatives, something explicitly deferred, a constraint locked in), 请加载 stele-capture skill 并按它的剧本起草 CapturePayload, 然后调用 decision_capture MCP 工具记录到 stele decision store。如果没真正定下来 (只是讨论选项), 忽略本提醒, 不要打扰用户。"
    }
  }'
  exit 0
fi

# No hit — emit empty object so Claude Code sees a clean response.
echo '{}'
exit 0
