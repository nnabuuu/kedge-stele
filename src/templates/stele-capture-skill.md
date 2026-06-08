---
name: stele-capture
description: Carve a decision that just crystallized in this conversation into the stele decision graph. Activates when a decision was reached (an option chosen over alternatives, something explicitly deferred, a constraint locked in) and should be recorded for future sessions. Drafts the full CapturePayload from conversation context and calls the stele MCP decision_capture tool. Triggered semantically when the stele decision detector hook flags a moment, or when the user mentions capturing a decision, carving to stele, recording a choice.
when_to_use: when a decision crystallizes, when capturing to stele, when carving a decision, when /decision is invoked, when the stele decision detector flags a moment, when the user just chose between alternatives, when an option is locked in, when something is explicitly deferred
---

# stele-capture — live decision capture

This skill activates when a decision has just crystallized in the conversation
— either because a Stop hook detected decision-y language and injected a
reminder, or because the user asks to capture / carve something. Your job is
to **author the full record from the live context** — the user should not
type fields. They confirm or correct.

> **Transport**: this skill drives the `stele` MCP server. The 4 tools
> (`decision_capture` / `decision_resume` / `decision_trace` / `decision_resolve`)
> are registered in the project's `.mcp.json`. If they're not visible,
> remind the user to run `stele init` in the project root.

## Step 0 — Milestone judgment (NEW in 0.0.6)

The Stop hook injects the current **Active milestones** list and your Claude
Code **session_id** into your context before this skill activates. You'll be
populating these fields on the `decision_capture` call:

- `milestone`: one of three modes
  - `{ mode: "continue", id: "M-04" }` — the conversation has been working
    toward an existing active milestone. Pick its id.
  - `{ mode: "new", draft: { title: "...", intent?: "..." } }` — the user
    just started a new direction (planned a new feature, kicked off a new
    refactor). Draft a short title (≤6 words) and an optional intent line.
  - `{ mode: "unscoped" }` — genuinely no targeted goal (debugging,
    exploration). Use sparingly; most captures should belong somewhere.
- `sourceSession`: `{ source: "claude-code", sourceSessionId: "<the id the
  hook gave you>" }`. Always pass this so multiple captures in the same
  conversation share one Session entity.

Heuristics:
- **Continue** is the safer default if any active milestone topically matches
  the conversation. Don't open new milestones for incremental progress.
- **New** is right when the user explicitly planned something fresh:
  "let me plan X", "I want to build Y", "we're going to refactor Z" — and
  none of the active milestones match.
- Picking the wrong mode is recoverable; the user can `stele milestones close`
  or reassign later. But default toward continuing — proliferation is the
  larger risk.

## Step 0.5 — Tag judgment (NEW in 0.0.7)

The Stop hook also injects the project's **active tags** and current
**tag_policy**. Tags are a cross-cutting classification — `security`,
`backend`, `perf`, `compliance`, etc. — that lives alongside (not instead of)
milestones. A decision can carry several tags; same tag spans many decisions.

Populate `tags` on the `decision_capture` call:

- `tags: [{ name, reason?, suggestedColor? }, ...]`
  - `name`: short, lowercase-kebab if multi-word (`browser-ui`, not `Browser UI`).
  - `reason`: REQUIRED when policy is `propose` and `tag_require_reason=true`
    (the default). One line on *why this decision needs a new tag*.
  - `suggestedColor`: optional `#RRGGBB` hex; otherwise the server picks one.

**Reuse before propose**: if any active tag fits, pass its `name` exactly — the
server will reuse the existing tag rather than create a new one. Only propose
a *new* name when nothing existing fits.

**Read the policy first**:
- `auto` → new names land as active immediately, origin=agent.
- `propose` (default) → new names queue for the user; existing names apply
  directly. `reason` is required.
- `locked` → don't bother proposing new names; only reuse existing tags.

**Restraint**: at most 2-3 tags per decision. Tagging everything `backend`
defeats the point. A tag is for cross-cutting concerns the *human* will want
to filter by later.

## Step 1 — Decide whether a real decision was made

Before drafting anything, ask yourself: **did a decision actually crystallize?**

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

## If a decision was made, draft a `CapturePayload`

Fill *every* field you can infer — do NOT reduce it to a title + rationale:

- `id`: pick the next free `D-NN` (decided), `DEF-NN` (deferred), or `OQ-NN` (open).
  Call `decision_resume` first to see what IDs are already taken.
- `title`: phrase it as a **question** ("X 还是 Y?", not "我们选了 X").
- `raisedBy.trigger`: what in the conversation surfaced this (1 line).
- `raisedBy.actor` / `layer`: ambient identity + governance layer
  (district / school / personal — personal is the default for solo use).
- `raisedBy.at`: ISO timestamp (use the conversation's clock).
- `constraint`: the hard thing that made the choice non-obvious.
- `status.options`: every alternative weighed, with `verdict` + `why`. Mark
  exactly one `chosen` for `status.kind === "decided"`.
- `status.rationale`: *why this option* — the reasoning, not the choice.
- `status.delta` (optional, often absent): ONLY when the decision modifies an
  intent bundle; pure code / tooling decisions don't carry delta — leave it off.
- `consequences.lockedIn` / `lockedOut`: what gets cheap / expensive downstream.
- `affects`: `EntityRef[]` — `{kind:"file"|"feature"|"skill"|"lesson", id}`.

For a **deferral** (`status.kind === "deferred"`), use a STRUCTURED
`revisitWhen` (`{kind:"metric"|"event"|"dependency"|"manual",...}`),
**NEVER free text** — the resume layer can't tell a free-text trigger is due,
so a free-text deferral is invisible forever.

For a genuine unknown, use `status.kind === "open"` with `question`.

## Propose edges and call the tool

Look at the resume output. If this decision answers a pending one, draft a
`resolves` edge; if related, `relates`. Put authored edges in `payload.edges`.

```
decision_capture
  decision:      <the Decision object you drafted>
  edges:         <your authored Edge[] (optional)>
  milestone:     <Step 0 judgment>
  sourceSession: { source: "claude-code", sourceSessionId: <hook-provided> }
  tags:          <Step 0.5 tag requests (optional)>
```

The MCP tool will ALSO run the consolidate layer and propose more edges for
the user to confirm.

## Confirm with the user

Show:
- The id captured
- Your authored edges
- Any *additional* edges the consolidate layer proposed

For each proposed edge the user wants to accept, call:

```
decision_resolve  kind: "resolves" | "relates" | ...
                  from: <by>
                  to:   <target>
                  note: <optional one-liner>
```

## Do NOT

- Do not invent a decision if none was reached.
- Do not put a free-text `revisitWhen` on a deferral.
- Do not include `status.delta` on pure code / tooling decisions.
- Do not interrupt the user mid-flow unless the decision is clearly important
  enough to pause for. When activated by the hook detector, you may often
  decide nothing was really decided and silently move on.
