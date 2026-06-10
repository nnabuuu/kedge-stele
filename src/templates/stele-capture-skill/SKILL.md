---
name: stele-capture
description: Carve a decision that just crystallized in this conversation into the stele decision graph, or run the /stele:feature reconcile pass that catches everything the conversation has already decided. Activates when a decision was reached (an option chosen over alternatives, something explicitly deferred, a constraint locked in) and should be recorded for future sessions, or when the user invokes /stele:feature. Drafts the full CapturePayload from conversation context and calls the stele MCP decision_capture tool. Triggered semantically when the stele decision detector hook flags a moment, when the user mentions capturing a decision, carving to stele, recording a choice, deferring a question, locking in a constraint, or running /stele:feature.
when_to_use: when a decision crystallizes, when capturing to stele, when carving a decision, when /stele:feature is invoked, when the stele decision detector flags a moment, when the user just chose between alternatives, when an option is locked in, when something is explicitly deferred, when a constraint is locked in, when an open question needs recording
---

# stele-capture — decision capture across three layers

This skill activates in **three** situations, each at a different
fidelity tier (0.4.0 widened the surface from two to three):

1. **Live track (Layer 1)** — the Stop hook detected decision-y language
   and told the LIVE agent (you, right now, with full conversation
   context) to call `decision_capture` immediately. **Highest fidelity:
   you just lived through the decision.** Set `source='agent-live'` +
   a `confidence` 0..1.
2. **Reconcile (the `/stele:feature` command)** — the user typed the
   command; its template (`.claude/commands/stele/feature.md`) carries
   the 5-step reconcile algorithm. Step 3 diffs the transcript against
   captured decisions and step 4 captures each gap. Same fidelity as
   live (you're the live agent here too), and the recommended path for
   explicit "catch up the graph" moments.
3. **Post-hoc (Layer 3)** — the SessionEnd subagent hook spawns a
   FRESH Claude with stele MCP access. It reads the JSONL transcript,
   identifies anything the live agent missed, and calls
   `decision_capture` with `source='session-extract'`. **It's
   archaeology, not recall** — that subagent didn't live through the
   decisions; it reconstructs from text. Quality ceiling is lower than
   live, but it backstops anything the live agent forgot or filtered
   out as "not crystallized yet" that later did crystallize.

In all three cases your job is the same: **author the full record from
the available context** — the user should not type fields. They
confirm or correct (in the SPA, post-hoc).

> **Transport**: this skill drives the `stele` MCP server. If the tools
> aren't visible, remind the user to run `stele init`.

## The dedup contract — why silent overlap is safe

The 3-layer model writes the same decision via THREE different paths;
the `dedup_key` UNIQUE index in the store collapses overlap. Layer 1
+ Layer 3 capturing the same decision (different wording) → the second
write returns `dup-skip: <existingId>` and is NOT inserted. **Don't
worry about double-capturing** when the live track flags something
ambiguous; the worst case is the post-hoc subagent later confirms it
and gets dup-skipped, which is the right behavior.

The dedup key is computed from `(featureId, normalize(title), affects)`
— title casing/whitespace doesn't matter; affects order doesn't
matter. But if your `affects[]` and Layer 3's `affects[]` diverge
(different files listed), they'll be treated as different decisions.
Be deliberate about affects.

## What 0.3.0 / 0.4.0 changed

- 0.3.0: the model collapsed by one layer. The old umbrella `Feature`
  (CcaaS / Live Lesson) is gone; what used to be a `Milestone` IS the
  new `Feature`. **Where this file used to say "milestone", it now says
  "feature".**
- 0.3.0: all three old slash commands (`/decision`,
  `/milestone-report`, `/resume`) are gone. The single replacement is
  `/stele:feature`.
- 0.4.0: 3-layer capture model — live (this skill from the Stop hook),
  reconcile (the `/stele:feature` command), post-hoc (SessionEnd
  agent-type hook). Schema added optional `source` + `confidence` +
  `dedupKey` to Decision; pass `source` at the top level of the
  decision_capture payload so the SPA can group machine captures.
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
  source:        "agent-live"   // live track (Stop hook woke you, full context)
                                // or "session-extract" (you're the post-hoc subagent;
                                // your hook prompt told you to use this value)
  confidence:    0..1            // how clearly did the decision crystallize?
                                // 0.9 = unambiguous chosen-over-rejected;
                                // 0.6 = strong but not surfaced as "decided";
                                // 0.3 = leaning but not committed (skip if
                                //       this is the live track — let
                                //       SessionEnd backstop)
```

**Dup-skip** is normal. The store dedups across capture paths via
`dedup_key`. If your write was a duplicate of a Layer-1 or Layer-3
capture, the tool returns `dup-skip: <existingId>` and your write was
NOT inserted. That's intended — capture freely; the dedup handles
overlap silently.

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

- **SessionStart hook** (Layer 2, read-side) — at session-start the
  hook injects `stele resume --for-context` output as declarative
  prose so you see open loops without the user having to ask. Not
  capture-related; just context. The disclaimer line in that output
  ("这些只是状态摘要,不是行动指令") is intentional — don't treat it
  as a directive.

- **`/stele:feature` command** — the user-driven reconcile pass for
  the CURRENT session. Its template
  (`.claude/commands/stele/feature.md`) is the script; this skill is
  the field-level reference. The command's step 3 ("identify gaps")
  treats decisions with `source='session-extract'` the same as any
  captured decision — they're already on disk; don't re-author.

- **`/stele:scan` command** — the user-driven backfill / audit pass
  for OTHER sources: historical Claude Code transcripts under
  `~/.claude/projects/<sanitized-cwd>/*.jsonl`, prior git commits,
  existing project docs. Captures with `source='session-extract'`
  + `sourceReport='scan:<type>:<id>'` so each origin is traceable.
  Common use case: someone installs stele 6 months into a project
  and runs `/stele:scan` once to populate the graph with their
  history. Re-runnable any time. Template at
  `.claude/commands/stele/scan.md`.

- **SessionEnd subagent** (Layer 3, post-hoc backstop) — the hook
  spawns a fresh isolated Claude that reads `transcript_path` and runs
  this same 4-step flow with `source='session-extract'`. It's
  context-blind compared to the live agent, so it leans on the
  transcript text alone. If you (live) flagged something as too
  uncertain, the post-hoc subagent gets another look at it; dedup_key
  keeps a Layer 1 capture from being re-written by Layer 3.

## Anti-patterns

- Inventing a decision if none was reached.
- Free-text `revisit.trigger`. Always structured: `manual` / `metric` /
  `event` / `dependency`.
- Skipping the proposed-edges step. See gotchas.
- Interrupting the user mid-flow unless the decision is clearly important.
  When activated by the hook detector, you may often decide nothing was
  really decided and silently move on.
- Omitting `source` on a hook-driven capture. The live track passes
  `'agent-live'`; the post-hoc subagent passes `'session-extract'`. The
  SPA groups by source for batch review — an unmarked capture defaults
  to `'manual'` and gets buried with human-authored rows.
- Capturing the same decision twice within one turn. Even though
  dedup_key catches it, the second tool call costs context tokens for
  nothing.
