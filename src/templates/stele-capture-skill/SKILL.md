---
name: stele-capture
description: Carve a decision that just crystallized in this conversation into the stele decision graph, or run the /stele:feature reconcile pass that catches everything the conversation has already decided. Activates when a decision was reached (an option chosen over alternatives, something explicitly deferred, a constraint locked in) and should be recorded for future sessions, or when the user invokes /stele:feature. Drafts the full CapturePayload from conversation context and calls the stele MCP decision_capture tool. Triggered semantically when the stele decision detector hook flags a moment, when the user mentions capturing a decision, carving to stele, recording a choice, deferring a question, locking in a constraint, or running /stele:feature.
when_to_use: when a decision crystallizes, when capturing to stele, when carving a decision, when /stele:feature is invoked, when the stele decision detector flags a moment, when the user just chose between alternatives, when an option is locked in, when something is explicitly deferred, when a constraint is locked in, when an open question needs recording
---

# stele-capture — live decision capture for 0.3.0

This skill activates in two situations:

1. The Stop hook detected decision-y language and injected a reminder.
2. The user typed `/stele:feature`, which is the single agent-facing
   stele command in 0.3.0. The command's own template
   (`.claude/commands/stele/feature.md`) carries the 5-step reconcile
   algorithm; *this* skill carries the per-decision field-level detail
   the command needs in steps 3 and 4.

In both cases your job is the same: **author the full record from the
live context** — the user should not type fields. They confirm or correct.

> **Transport**: this skill drives the `stele` MCP server. If the tools
> aren't visible, remind the user to run `stele init`.

## What 0.3.0 changed

- The model collapsed by one layer. The old umbrella `Feature` (CcaaS /
  Live Lesson) is gone; what used to be a `Milestone` IS the new
  `Feature`. **Where this file used to say "milestone", it now says
  "feature".**
- All three old slash commands (`/decision`, `/milestone-report`,
  `/resume`) are gone. The single replacement is `/stele:feature` — its
  reconcile pass already does per-decision capture as a side effect of
  step 4.
- The Decision shape itself did NOT change. Field-by-field still in
  `references/decision-schema.md`.

## Read this BEFORE you draft

- **`gotchas.md`** — the traps that bite fresh-context agents.
- **`references/decision-schema.md`** — field-by-field for the Decision
  shape (Decision body, detail body, revisit, edges). Don't try to
  reconstruct from memory; the schema is strict.
- **`references/feature-judgment.md`** — Step 0: continue an existing
  Feature vs open a new one vs unscoped.
- **`references/tag-judgment.md`** — Step 0.5: how the local `tag_policy`
  decides whether your tags land or queue.

## The 4-step checklist (per-decision)

This is the per-capture flow. When the user typed `/stele:feature`, the
*command* tells you which decisions need capturing (step 3 of the
command); for each one, walk through this 4-step checklist.

### Step 0 — Feature + Tag judgment

The Stop hook injects the current `state='going'` features, your Claude
Code session_id, the active tags, and the current `tag_policy` into your
context. The `/stele:feature` command resolves the Feature for you in its
step 1; that resolved id is what you use here (with `mode: "continue"`).

For freelance captures outside the command:
- `feature` — see `references/feature-judgment.md`
- `tags` — see `references/tag-judgment.md`
- `sourceSession` — always `{source: "claude-code", sourceSessionId: <the
  session_id the hook gave you>}`. NOT the stele Session.id (different
  thing — see gotchas).

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
- `featureId` — pass `"?"` (the tool reassigns based on the `feature` field)
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
  feature:       <Step 0 judgment, or { mode:"continue", id:<from /stele:feature> }>
  sourceSession: { source: "claude-code", sourceSessionId: <hook-provided id> }
  tags:          <Step 0 tag requests (optional)>
```

### Step 4 — Accept proposed edges

The tool returns:
- The id assigned (always `<featureId>/<local>`)
- Your authored edges
- *Proposed* edges from the consolidate layer — these are NOT applied yet

For each proposed edge the user wants to accept:

```
decision_resolve  relation: "resolves" | "relates" | "depends_on" | ...
                  from: <by>
                  to:   <target>
                  note: <optional one-liner>
```

## Composes with

- **`/stele:feature`** — the only stele slash command in 0.3.0. Its
  reconcile pass calls this 4-step flow once per uncaptured decision
  (its step 4), then writes a rolling summary via `feature_set_summary`
  (its step 5). When the user types `/stele:feature`, the command's
  template (`.claude/commands/stele/feature.md`) is your script; this
  skill is your reference.

## Anti-patterns

- Inventing a decision if none was reached.
- Free-text `revisit.trigger`. Always structured: `manual` / `metric` /
  `event` / `dependency`.
- Skipping the proposed-edges step. See gotchas.
- Interrupting the user mid-flow unless the decision is clearly important.
  When activated by the hook detector, you may often decide nothing was
  really decided and silently move on.
