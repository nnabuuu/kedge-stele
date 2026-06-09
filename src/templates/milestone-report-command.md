---
name: milestone-report
description: 走之前留话 (write a parting note before you go) — close out the current Claude Code session with a summary, a resume-anchor, and a structured pause reason. Activates when the user is wrapping up a session, signing off, taking a break, parking the milestone, or asks to "close out", "wrap up", "milestone report", "pause reason", "summarize this session", "before I leave", "before I go", "session 收尾", "走之前", "暂停一下", "把这次的进展记一下". Runs `milestone_report` to get a draft, lets the user confirm, then calls `session_end` so the milestone state advances and the next conversation can read the context back via `/resume`.
allowed-tools:
  - Read
---

# /milestone-report — 走之前留话

When the user runs `/milestone-report`, they're closing out this session.
Your job is to **draft a summary while they still remember context**, then
let them confirm before it lands. This is the ADHD-bookend half: the
opposite end is `/resume` (回来时念回来) when they come back.

> **Transport**: this command drives the `stele` MCP server. It uses
> `milestone_report` (read — produces a draft), then `session_end` (write —
> commits the outcome + pause_reason).

## Steps

1. **Identify the milestone.** The active milestone is the one tied to the
   most recent decision in this conversation. If the user didn't say
   explicitly, call:
   ```
   milestone_list state: "going"
   ```
   and use the most recent. If ambiguous, ask the user once.

2. **Pull the draft.** Call:
   ```
   milestone_report milestoneId: <M-NN>
   ```
   This returns a `MilestoneReportDraft`:
   - `milestoneId`
   - `summary` — empty; you fill it
   - `openLoops` — pre-populated by the tool from open + un-resolved deferred
     decisions in this milestone
   - `nextStateSuggestion` — the tool's heuristic guess (e.g. 'winding' if
     no loops left)

3. **Draft the missing fields from conversation context:**
   - `summary`: 1-2 sentences on what this session pushed. Concrete, not
     "made progress". E.g. "Wired the 5-state milestone enum end-to-end;
     the byDecisionType query replaces byStatusKind in projections.ts."
   - `resumeEdge`: one phrase on where to pick up next time. E.g.
     "next: rewrite the broken tests for the new id format". This is the
     single most useful field — it's what `/resume` reads back.
   - `suggestedPauseReason`: a `PauseReason` `{kind, note?}` where `kind` is
     one of `blocked` / `waiting_dep` / `out_of_time` / `lost_thread` /
     `done_enough` / `other`. The `note` is freeform context.
   - `outcome.type`: one of `advanced` / `resolved` / `touched`.
     - `advanced` — pushed the milestone forward (most common)
     - `resolved` — closed an open/deferred loop (also fill `resolves[]` and
       `via`)
     - `touched` — minor cleanup, doesn't move the needle

4. **Show the draft to the user.** Render it in chat with the fields you
   filled, the openLoops the tool gave you, and the nextStateSuggestion.
   Ask: "Does this look right? Want to change anything?"

5. **On confirmation, call session_end:**
   ```
   session_end
     sessionId:   <the current session's id; the hook provided sourceSessionId,
                   but session_end wants the stele session id — find it via the
                   latest decision's sessionId or via projections.continue_last>
     outcome:     { type, summary, resolves?: [...], via?: ... }
     pauseReason: { kind, note? }
   ```
   The tool advances milestone state to 'winding' if outcome.type='resolved',
   otherwise leaves it.

6. **If the user wanted a different state transition** (e.g. mark the milestone
   `done` or `paused`), call:
   ```
   milestones set-state <id> <state>
   ```
   via the CLI (not yet exposed as an MCP tool — coming in 0.1.1).

## Do NOT

- Do not skip the summary draft and just call `session_end` with empty fields.
  The whole value is that the user reads a coherent draft while they still
  remember context — an empty summary defeats the purpose.
- Do not invent a pauseReason kind not in the enum (`blocked` / `waiting_dep`
  / `out_of_time` / `lost_thread` / `done_enough` / `other`).
- Do not call `session_end` without showing the draft for confirmation first.
- Do not interrupt with `/milestone-report` mid-conversation — the user runs
  it explicitly when they're closing.
