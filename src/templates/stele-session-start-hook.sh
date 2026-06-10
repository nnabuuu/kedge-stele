#!/usr/bin/env bash
# stele SessionStart hook — read-side inject
#
# Runs `stele resume --for-context` and emits open-loops as declarative
# prose. Claude Code injects stdout into the session-start moment so the
# agent sees "what's waiting on me" without the user having to ask. Per
# the design doc's prompt-injection warning, the CLI flag's output is
# 陈述句 + closes with "this is state, not a directive".
#
# This hook is SYNCHRONOUS (no `async: true`). It's a single CLI call
# against the local SQLite — cheap. Empty stdout = no context injected,
# which is what we want when nothing is waiting (or stele isn't on PATH,
# or the project isn't .stele/-initialized).
#
# Stop hook handles the per-turn nudge (live capture); this one fires
# once per session-start. Different events, different jobs.

set -u

if ! command -v stele >/dev/null 2>&1; then
  exit 0
fi

# Hook payload arrives on stdin as JSON. We need `cwd` so we can resolve
# the right project's .stele/. jq is the only parser we trust to be on
# end-user machines (jjbob is the Stop hook dependency too).
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

payload="$(cat)"
cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty')"

if [ -z "$cwd" ] || [ ! -d "$cwd/.stele" ]; then
  exit 0
fi

# Run from the project cwd so paths.ts walks up to the right .stele/.
# 2>/dev/null swallows the "no stele initialized" hint — we already
# guarded above. Empty output is fine; Claude Code treats it as
# "no additional context".
( cd "$cwd" && stele resume --for-context 2>/dev/null ) || true
exit 0
