---
description: Reconcile this Feature with the conversation — capture any uncaptured decisions, then rewrite the rolling summary.
---

# `/stele:feature` — the one stele command

Idempotent reconcile pass. Call any time. Compares what's already on this
project's currently-`going` Feature against what's actually been discussed
in the live transcript, captures the gap, then rewrites the Feature's
rolling summary.

You replace this slash command's expansion verbatim with the run below.
Show the user the summary you'll write **before** you call
`feature_set_summary` so they can correct anything mis-summarized.

## The 5-step algorithm

### Step 1 — Find the active Feature

Call `feature_list state:"going"`.

- **One result** → that's the Feature for this call. Note its `id`,
  `name`, `state`.
- **Multiple** → pick the one with the most recent `lastActivity`.
- **None** → ask the user one sentence: "No active Feature. What are we
  working on? (I'll open one.)" Then call `feature_open name:<their answer>`
  and use the returned `id`. The fresh Feature opens in `state='draft'`;
  the first `decision_capture` call advances it to `going`.

> **Multiple-projects gotcha:** `feature_list` is scoped to the project
> the daemon resolved for this cwd. You don't pick a project; the store
> does.

### Step 2 — Pull what's already captured

Call `feature_decisions featureId:<the id from step 1>`.

Returns every Decision on this Feature across every Session, ordered
newest-first. Note their `id` + `title` + `type` — you'll diff against
the transcript next.

### Step 3 — Identify the gaps

Re-read the conversation transcript from the top. For each decision-y
moment, ask: **was this captured?**

A captured decision will match one of the titles you noted in step 2 (or
will be substantively the same point under a different phrasing). Be
liberal in matching — capturing the same decision twice under different
words is a bigger problem than missing one near-duplicate.

A "decision-y moment" is the same set as `/decision` was looking at:

- An option chosen over alternatives ("we'll go with per-session DBs")
- Something explicitly deferred ("punt cascade DELETE for now")
- A constraint locked in ("staying on SQLite, not Postgres")

NOT decision-y:
- Generic problem-solving / tactical edits.
- Discussion of options without commitment.
- A decision *about how to do step 4* of this very command — your own
  meta-moves don't get captured.

If everything is already captured, **say "0 captured" and skip to step 5**
— writing the summary is still useful (the transcript may have new context
even without new decisions).

### Step 4 — Capture each gap

For each gap, call `decision_capture` exactly as the `stele-capture`
skill describes. Key fields for the 0.3.0 surface:

- `feature: { mode: "continue", id: "<the Feature id from step 1>" }` —
  always `continue`; you already resolved the Feature in step 1.
- `sourceSession: { source: "claude-code", sourceSessionId: <cc_session_id> }`
  if the Stop hook injected one; otherwise omit.
- Everything else: see `stele-capture/SKILL.md` and
  `stele-capture/references/decision-schema.md`. The Decision shape did
  NOT change in 0.3.0.

Track the count of successful captures. Reject the no-real-decision
captures the same way the skill teaches — empty is fine.

### Step 5 — Rewrite the rolling summary

Draft a 2-4 sentence summary of where this Feature stands, based on the
conversation + the (now-complete) decision list. Phrase it as **plain
prose**, written for the version of you that will read this 3 weeks from
now with no other context:

- What's the Feature's current shape? (1 sentence)
- What's decided / what's still open? (1-2 sentences)
- What's the immediate next move? (1 sentence)

The summary REPLACES whatever was there before — it is not an append.
**Show the user the draft before writing.** If they correct, use their
phrasing.

Then call `feature_set_summary featureId:<the id> summary:<your text>`.

### Done

Print a one-line confirmation to the user:

```
/stele:feature → <feature-id> "<feature-name>" [state=<state>]
  • captured: <N> new decision(s) (total now <T>)
  • summary: <first 80 chars of the summary>…
```

No session end, no pause reason, no state transition. The command is
**reconcile-only**. State transitions (`going → winding → done`) happen
manually via the dashboard.

## When the user types `/stele:feature` mid-conversation

You may be partway through a decision the user hasn't committed to yet.
In step 3, that pending discussion is NOT a gap — it hasn't been decided.
Skip it; the next call will catch it once it crystallizes.
