---
name: stele-capture
description: Carve a decision that just crystallized in this conversation into the stele decision graph. Activates when a decision was reached (an option chosen over alternatives, something explicitly deferred, a constraint locked in) and should be recorded for future sessions. Drafts the full CapturePayload from conversation context and calls the stele MCP decision_capture tool. Triggered semantically when the stele decision detector hook flags a moment, when the user mentions capturing a decision, carving to stele, recording a choice, deferring a question, locking in a constraint, or running /decision.
when_to_use: when a decision crystallizes, when capturing to stele, when carving a decision, when /decision is invoked, when the stele decision detector flags a moment, when the user just chose between alternatives, when an option is locked in, when something is explicitly deferred, when a constraint is locked in, when an open question needs recording
---

# stele-capture — live decision capture

This skill activates when a decision has just crystallized in the conversation
— either because a Stop hook detected decision-y language and injected a
reminder, or because the user asks to capture / carve something. Your job is
to **author the full record from the live context** — the user should not
type fields. They confirm or correct.

> **Transport**: this skill drives the `stele` MCP server (22 tools as of
> 0.1.0). If the tools aren't visible, remind the user to run `stele init`.

## Read this BEFORE you draft

- **`gotchas.md`** — the 10 traps that bite fresh-context agents. Read it
  first; you will hit at least one of these on your first try.
- **`references/decision-schema.md`** — field-by-field for the Decision shape
  (Decision body, detail body, revisit, edges). Don't try to reconstruct
  from memory; the schema is strict.
- **`references/milestone-judgment.md`** — Step 0: continue an existing
  milestone vs open a new one vs unscoped.
- **`references/feature-judgment.md`** — Step 0.7: which Feature owns a
  newly-opened milestone.
- **`references/tag-judgment.md`** — Step 0.5: how the local `tag_policy`
  decides whether your tags land or queue.

## The 4-step checklist

### Step 0 — Milestone + Feature + Tag judgment

The Stop hook injects the current `state='going'` milestones, your Claude
Code session_id, the active tags, and the current `tag_policy` into your
context. Use these to populate three fields on the `decision_capture` call:

- `milestone` — see `references/milestone-judgment.md`
- `tags` — see `references/tag-judgment.md`
- `sourceSession` — always `{source: "claude-code", sourceSessionId: <the
  session_id the hook gave you>}`. NOT the stele Session.id (that's a
  different thing — see gotchas).

When `milestone.mode === "new"`, also pick the Feature: see
`references/feature-judgment.md`.

### Step 1 — Decide whether a real decision was made

Before drafting anything: **did a decision actually crystallize?**

A decision is:
- An option chosen over alternatives ("we'll go with per-session isolation")
- Something explicitly deferred ("let's punt cascade DELETE for now")
- A constraint locked in ("we're staying on SQLite, not Postgres")

A decision is NOT:
- Generic problem-solving ("here's how to fix the bug")
- A tactical edit ("renamed foo to bar")
- Discussion of options without commitment

If no real decision was made, **say so and stop**. Carving a non-decision
pollutes the store and erodes trust in resume digests.

### Step 2 — Draft the CapturePayload

Field-by-field is in `references/decision-schema.md`. The minimum the
schema enforces:

- `id` — pass `"?"` (the tool reassigns; see gotchas for the only exception)
- `milestoneId` — pass `"?"` (the tool reassigns based on the `milestone` field)
- `type` — `"decision"` / `"deferred"` / `"open"`
- `status` — omit for `type='decision'`; `"open"` for the others
- `title` — phrase as a question for `deferred`/`open`
- `raisedBy` — `{trigger, actor, layer, at}`
- `affects` — `EntityRef[]`
- `detail.options[]` — REQUIRED for `type='decision'`, even if empty
- `revisit.trigger` — REQUIRED for `deferred`/`open`, STRUCTURED (not free text)

### Step 3 — Propose edges and call the tool

Look at `decision_resume` output. If this decision answers a pending one,
draft a `resolves` edge; if related, `relates`; if it builds on another,
`depends_on`. Put authored edges in `payload.edges`.

```
decision_capture
  decision:      <the Decision object you drafted>
  edges:         <your authored Edge[] (optional)>
  milestone:     <Step 0 judgment>
  sourceSession: { source: "claude-code", sourceSessionId: <hook-provided id> }
  tags:          <Step 0 tag requests (optional)>
```

### Step 4 — Confirm and accept proposed edges

The tool prints:
- The id assigned (always `<milestoneId>/<local>`)
- Your authored edges
- *Proposed* edges from the consolidate layer — these are NOT applied yet

For each proposed edge the user wants to accept (see gotchas — this is
easy to skip):

```
decision_resolve  relation: "resolves" | "relates" | "depends_on" | ...
                  from: <by>
                  to:   <target>
                  note: <optional one-liner>
```

## Composes with

- `/milestone-report` — at the END of the session, NOT per-decision. Drafts
  a `MilestoneReportDraft` + structured `pause_reason` and writes
  `session_end`. Don't fold this into `/decision`.
- `/resume` — at the START of the next session. Reads back the last
  session's outcome + pause_reason and prints a copy-paste
  `claude --resume` command.

## Anti-patterns

- Inventing a decision if none was reached.
- Free-text `revisit.trigger`. Always structured: `manual` / `metric` /
  `event` / `dependency`.
- Skipping the proposed-edges step. See gotchas.
- Interrupting the user mid-flow unless the decision is clearly important.
  When activated by the hook detector, you may often decide nothing was
  really decided and silently move on.
