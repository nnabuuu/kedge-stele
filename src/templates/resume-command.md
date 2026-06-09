---
name: resume
description: 回来时念回来 — read back what the user did last time on this project, with the outcome + pause_reason + a copy-paste-ready `claude --resume` command to jump back in.
allowed-tools:
  - Read
---

# /resume — 回来时念回来

When the user runs `/resume`, they're coming back to this project after some
gap. Your job is to **read back the last session's context** so they remember
where they were, and **give them a one-paste command** to jump back into the
prior Claude Code session.

> **Transport**: this command uses the `stele` MCP server. It calls
> `resume_command` to compute the right jumpback shape and reads the most
> recent session's outcome + pause_reason.

## Steps

1. **Find the latest session.** Call:
   ```
   decision_resume
   ```
   to see what's waiting, and look at the latest decision's `sessionId` for
   the most recent session.

   Alternatively (preferred when available), use the CLI projection helper:
   ```
   continueLast(store)
   ```
   via internal call — but from the MCP side, the equivalent is reading
   `latestSession` (not yet exposed as a tool in 0.1.0; for now, derive from
   `decision_resume` then ask the user).

2. **Pull the resume command.** Call:
   ```
   resume_command sessionId: <S-NN>
   ```
   This returns:
   ```jsonc
   {
     "mode": "jump" | "rebuild",
     "command": "cd /path/to/project && claude --resume <cc_session_id>",
     "copyable": true,
     "lastSession": {
       "id": "...",
       "endedAt": "...",
       "outcome":     { "type": "advanced", "summary": "...", ... },
       "pauseReason": { "kind": "out_of_time", "note": "..." }
     }
   }
   ```

3. **Read it back to the user.** Render in chat:

   > Last time on this project (closed `<endedAt>`):
   >
   > — **`<outcome.type>`**: `<outcome.summary>`
   > — **Stopped because**: `<pauseReason.kind>` — `<pauseReason.note>`
   >
   > Resume command (mode `<mode>`):
   >
   > ```bash
   > <command>
   > ```

   If `mode='jump'`, the zellij layout is still alive — they can paste the
   command in the existing pane and they're back where they were. If
   `mode='rebuild'`, the layout is gone but `claude --resume` will reanimate
   the conversation in a fresh shell.

4. **If the user has no prior session in this project**, say so directly:
   "No prior session found. Start with `/decision` once you've made a
   choice, or run `stele sessions start` if you want to open one explicitly."

## Do NOT

- Do not run the resume command for the user — paste it for them to copy.
  Running it from this session would replace this conversation.
- Do not invent a session id if the store has none — say "no prior session".
- Do not skip reading back the outcome + pause_reason. The whole point is to
  re-prime context; if you just print the command, you've failed at the
  bookend job.
