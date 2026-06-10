#!/usr/bin/env bash
# stele SessionEnd hook — post-hoc capture (Layer 3)
#
# Async-detached. Spawns `claude -p` in the background with the
# stele-extract agent prompt, pointed at the just-ended session's
# transcript. The agent identifies decisions the live track missed and
# captures them via mcp__stele__decision_capture with
# source='session-extract'.
#
# Why command-type + claude -p (vs. type:"agent" inline)?
#   Claude Code's `type:"agent"` hook schema (as of 2.1.x) takes only a
#   `prompt` STRING — no allowed_tools field, no documented `async`
#   field, no path-to-agent-file pointer. To run async-detached + pass
#   the rich agent definition with allowed_tools, we use command-type +
#   `claude -p` so the wrapper has full control. `claude -p` IS billed
#   (per the design doc's warning) — but bounded to once per session.
#
# setsid+nohup fully detach so the extract subprocess survives Claude
# Code exiting. The user's session close stays snappy; extraction runs
# in the background for 60-120s.

set -u

# Cheap bail-outs: if claude or jq aren't on PATH, just exit clean.
# Nobody's reading stderr (async-detached) so silence is golden.
if ! command -v claude >/dev/null 2>&1; then
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

payload="$(cat)"
cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty')"
transcript_path="$(printf '%s' "$payload" | jq -r '.transcript_path // empty')"
session_id="$(printf '%s' "$payload" | jq -r '.session_id // empty')"

# No project, no work.
if [ -z "$cwd" ] || [ ! -d "$cwd/.stele" ]; then
  exit 0
fi

# The agent definition file carries the 5-step extraction algorithm +
# the inlined decision-schema reference. We don't read it into a
# variable here — we just point claude -p at it. Keeps argv small.
agent_file="$cwd/.claude/agents/stele-extract.md"
if [ ! -f "$agent_file" ]; then
  exit 0
fi

# Log file the subprocess will write to. Best-effort; if the dir is
# unwritable, claude -p's output goes to /dev/null below.
log_dir="$cwd/.stele"
log_file="$log_dir/extract.log"
{
  printf '\n=== %s · SessionEnd extract started ===\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'transcript_path=%s\n' "$transcript_path"
  printf 'session_id=%s\n' "$session_id"
} >> "$log_file" 2>/dev/null || true

# The composite prompt. claude -p receives:
#   1. The agent definition file's content (algorithm + schema reference)
#   2. The transcript path + session id from the hook payload
#   3. cwd context so the subprocess can resolve MCP / file paths
#
# We embed the agent file's content directly so the spawned Claude has
# the full instructions even if it can't Read the file later (defensive
# — should be redundant since claude -p inherits filesystem access).
agent_body="$(cat "$agent_file")"
prompt="$agent_body

---

Runtime context:
- transcript_path = $transcript_path
- cc_session_id = $session_id
- cwd = $cwd

Follow the algorithm. Capture decisions with source='session-extract'.
Errors to $log_file. No interactive output."

# setsid+nohup → fully detached from this shell + Claude Code's process
# tree. The subprocess inherits no stdin (we redirect from /dev/null);
# stdout+stderr go to the log file.
setsid nohup claude -p \
  --add-dir "$cwd" \
  "$prompt" \
  < /dev/null >> "$log_file" 2>&1 &

# We don't wait. async=true on the hook entry means Claude Code doesn't
# wait either; user's session close proceeds immediately.
exit 0
