---
name: stele-capture
description: Carve a decision that just crystallized in this conversation into the stele decision graph. Activates when a decision was reached (an option chosen over alternatives, something explicitly deferred, a constraint locked in) and should be recorded for future sessions. Drafts the full CapturePayload from conversation context and calls the stele MCP decision_capture tool. Triggered semantically when the stele decision detector hook flags a moment, when the user mentions capturing a decision, carving to stele, recording a choice, or running /decision.
when_to_use: when a decision crystallizes, when capturing to stele, when carving a decision, when /decision is invoked, when the stele decision detector flags a moment, when the user just chose between alternatives, when an option is locked in, when something is explicitly deferred
---

# stele-capture — live decision capture

This skill activates when a decision has just crystallized in the conversation
— either because a Stop hook detected decision-y language and injected a
reminder, or because the user asks to capture / carve something. Your job is
to **author the full record from the live context** — the user should not
type fields. They confirm or correct.

> **Transport**: this skill drives the `stele` MCP server. As of 0.1.0 the
> server registers 24 tools (capture / features / milestones / sessions /
> tags / config). If they're not visible, remind the user to run `stele init`.

## Step 0 — Milestone judgment

The Stop hook injects the current **Active milestones** list and your Claude
Code **session_id** into your context before this skill activates. You'll be
populating these fields on the `decision_capture` call:

- `milestone`: one of three modes
  - `{ mode: "continue", id: "M-04" }` — the conversation has been working
    toward an existing active milestone. Pick its id.
  - `{ mode: "new", draft: { name, about?, featureId?, featureDraft?:{name} } }`
    — the user just planned a new direction. Provide either an existing
    `featureId` or a `featureDraft` to open a new Feature alongside.
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
- Picking the wrong mode is recoverable; the user can re-assign later.
  Default toward continuing — proliferation is the larger risk.

### Milestone state (0.1.0+)

Milestones now use a 5-state enum: `draft` → `going` → `winding` → `done`,
with `paused` as a sideways state. Newly opened milestones land in `draft`
and auto-advance to `going` when the first session opens. The agent doesn't
normally set state directly — `/milestone-report` is where state changes
happen (with user confirmation).

## Step 0.5 — Tag judgment

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
defeats the point.

## Step 0.7 — Feature judgment (NEW in 0.1.0)

Features are the structural axis between Project and Milestone (`CcaaS`,
`Live Lesson`, `Skill Registry`). When the milestone judgment is `mode='new'`,
you also have to decide which Feature owns the new milestone:

- If an existing Feature fits, pass `featureId` in the milestone draft.
  Call `feature_list` first to see options.
- If the user is genuinely starting a new structural area, pass
  `featureDraft: { name: "..." }` to open a Feature alongside.
- For `mode='unscoped'`, the per-project unscoped Feature is used
  automatically (no field needed).

Feature-axis judgment is usually more stable than milestone-axis. Avoid
proliferating features — a project rarely needs more than 5-10 in its
lifetime.

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

Fill *every* field you can infer — do NOT reduce it to a title + rationale.

The 0.1.0 Decision shape splits the old discriminated `Status` union into
separate fields:

- `type`: `"decision"` | `"deferred"` | `"open"`
- `status`: omit for `type='decision'`; `"open"` for `deferred`/`open`
- `resolvedBy` / `supersededBy`: tool sets these via edges; you don't fill
- `detail`: the rich body (see below) — REQUIRED for `type='decision'`

Other fields:
- `id`: pass `"?"` — the tool reassigns to `<milestoneId>/<local>`.
- `milestoneId`: pass `"?"` — the tool reassigns based on `milestone` field.
- `title`: a question for `deferred`/`open` ("X 还是 Y?"). Statement OK for `decision`.
- `raisedBy.trigger`: prose surface of what surfaced this.
- `raisedBy.actor` / `layer`: ambient identity + governance layer.
- `raisedBy.at`: ISO timestamp.
- `revisit`: for `deferred`/`open` — `{trigger: {kind, ...}, cond?}`.
  Use a STRUCTURED trigger (`manual`/`metric`/`event`/`dependency`),
  never free text — the resume layer can't tell a free-text trigger is due.
- `detail`:
  - `optionAxis`: "Approach", "Storage backend", etc.
  - `trigger`: prose surface
  - `constraint`: hard limit that made the choice non-obvious
  - `options[]`: every alternative weighed, `{name, desc?, verdict, why?, chosen?}`.
    REQUIRED for `type='decision'`. Pass `[]` to assert "no real fork".
    Exactly one `verdict='chosen'`.
  - `why[]`: free-text rationale paragraphs
  - `locks`: `{in?, out?}` — what gets cheap / expensive downstream
  - `artifact`: `{file?, commit?}` — the primary artifact
- `affects`: `EntityRef[]` — `{kind:"file"|"feature"|"skill"|"lesson", id}`.

## Propose edges and call the tool

Look at the resume output. If this decision answers a pending one, draft a
`resolves` edge; if related, `relates`; if it builds on another, `depends_on`.
Put authored edges in `payload.edges`.

```
decision_capture
  decision:      <the Decision object you drafted>
  edges:         <your authored Edge[] (optional)>
  milestone:     <Step 0 judgment>
  sourceSession: { source: "claude-code", sourceSessionId: <hook-provided id> }
  tags:          <Step 0.5 tag requests (optional)>
```

The MCP tool will ALSO run the consolidate layer and propose more edges for
the user to confirm.

## Confirm with the user

Show:
- The id assigned (the tool prints it; it's `<milestoneId>/<local>`)
- Your authored edges
- Any *additional* edges the consolidate layer proposed

For each proposed edge the user wants to accept, call:

```
decision_resolve  relation: "resolves" | "relates" | "depends_on" | ...
                  from: <by>
                  to:   <target>
                  note: <optional one-liner>
```

## Do NOT

- Do not invent a decision if none was reached.
- Do not put a free-text `revisit.trigger` on a deferral.
- Do not omit `detail.options` on a `type='decision'` — pass `[]` if no fork.
- Do not interrupt the user mid-flow unless the decision is clearly important
  enough to pause for. When activated by the hook detector, you may often
  decide nothing was really decided and silently move on.
