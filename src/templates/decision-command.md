---
name: decision
description: Carve the decision just reached in this conversation as a structured node in the stele (实录) provenance store. Drafts the full record from context so the human only confirms.
allowed-tools:
  - Read
---

# /decision — live decision capture

When the user runs `/decision`, a real decision has just crystallized in the
conversation. Your job is to **author the full record from the live context** —
the user should not type fields. They confirm or correct.

> **Transport**: this command drives the `stele` MCP server. The full tool
> roster (24 tools as of 0.1.0) lives in the project's `.mcp.json`. If
> they're not visible, remind the user to run `stele init`.
>
> If the user wants the milestone-level "wrap up before I leave" ritual,
> that's `/milestone-report`, not `/decision`. They compose: `/decision`
> is per-choice; `/milestone-report` is end-of-session.

## Steps

1. **Read the current store** so you can propose consolidation edges and
   pick the right milestone bucket. Call the MCP tools:
   ```
   decision_resume                # what's open/deferred right now
   milestone_list                 # active milestones to consider
   feature_list                   # features that exist (to assign milestone)
   config_get key: "tag_policy"   # knowing tag_policy avoids dead proposals
   ```
   Note the existing nodes — the new decision may resolve one, and probably
   belongs to an existing active milestone (continue) rather than a new one.

2. **Draft a `CapturePayload`** (see `src/types.ts` in the stele repo)
   from the conversation. Fill *every* field you can infer — do NOT reduce it
   to a title + rationale:

   - `id`: pass anything (e.g. `"?"`); the MCP tool will reassign it to
     `<milestoneId>/<local>` after milestone resolution. The local part is
     `D-NN` for `type=decision`, `DEF-NN` for `deferred`, `OQ-NN` for `open`.
   - `milestoneId`: required by the schema; pass anything (e.g. `"?"`) — the
     tool reassigns based on the `milestone` field.
   - `type`: `"decision"` | `"deferred"` | `"open"`.
   - `status`: omit for `type='decision'`; `"open"` for `deferred`/`open`
     (until a later decision resolves it).
   - `title`: a question (`"X 还是 Y?"`), not a verdict (`"我们选了 X"`).
   - `raisedBy.trigger`: what in the conversation surfaced this (1 line).
   - `raisedBy.actor` / `layer`: ambient identity + governance layer
     (district / school / personal — personal is the default for solo use).
   - `raisedBy.at`: ISO timestamp (use the conversation's clock).
   - `revisit`: for `deferred`/`open` only — `{trigger: {kind, ...}, cond?}`
     where `kind` is `manual` / `metric` / `event` / `dependency`. **Never
     free text** — the resume layer can't tell a free-text trigger is due.
   - `detail`: the rich body. For `type='decision'`, REQUIRED with at least
     `options` (pass `[]` to assert "no real fork"):
     - `optionAxis`: e.g. `"Approach"` / `"Storage backend"` — what the
       options vary on
     - `trigger`: prose surface of what surfaced this
     - `constraint`: the hard thing that made the choice non-obvious
     - `options[]`: every alternative weighed, `{name, desc?, verdict, why?, chosen?}`.
       Mark exactly one `verdict='chosen'` for `type='decision'`.
     - `why[]`: free-text rationale paragraphs
     - `locks`: `{in?, out?}` — what gets cheap / expensive downstream
     - `artifact`: `{file?, commit?}` — the primary artifact tied to the decision
   - `affects`: `EntityRef[]` — `{kind:"file"|"feature"|"skill"|"lesson", id}`.
   - `milestone`: the skill / user's judgment.
     - `{mode:"continue", id:"M-04"}` — the conversation has been working
       on an existing active milestone
     - `{mode:"new", draft:{name, about?, featureId?, featureDraft?:{name}}}` —
       the user just planned something fresh. Provide either an existing
       `featureId` or a `featureDraft` to open a new Feature alongside.
     - `{mode:"unscoped"}` — rare; use only for genuine exploration with no goal
   - `sourceSession`: `{source:"claude-code", sourceSessionId:"<id>"}`. Always
     pass this so multiple captures in the same conversation share one
     Session entity.
   - `sessionId` (alternative): if the user already ran `session_start`
     explicitly, pass the returned Session id here and skip `milestone` +
     `sourceSession`.
   - `tags`: `[{name, reason?, suggestedColor?}, ...]`. Reuse existing tag
     names when they fit; only propose new names when no existing tag captures
     the concern. Under `tag_policy=propose` (default), each new name requires
     a `reason`. Max 2-3 tags per decision.

3. **Propose edges** against existing open/deferred nodes from step 1. If this
   decision answers a pending one, draft a `resolves` edge; if related, `relates`;
   if it builds on another, `depends_on`. Put authored edges in `payload.edges` —
   the MCP tool will ALSO run the consolidate layer and propose more.

4. **Call the tool.** One MCP call captures the node AND prints the
   consolidate-proposed additional edges:
   ```
   decision_capture
     decision:      <the Decision object you drafted>
     edges:         <your authored Edge[] (optional)>
     milestone:     <Step 2 judgment>
     sourceSession: { source: "claude-code", sourceSessionId: <hook-provided id> }
     tags:          <Step 2 tag requests (optional)>
   ```

5. **Confirm** to the user: the id captured, your authored edges, and any
   *additional* edges the consolidate layer proposed. For each proposed edge
   the user wants to accept, call:
   ```
   decision_resolve  relation: "resolves" | "relates" | "depends_on" | ...
                     from: <by>
                     to:   <target>
                     note: <optional one-liner>
   ```

## Do NOT

- Do not ask the user to fill fields. Draft, then let them correct.
- Do not invent a decision if none was reached — `/decision` on a trivial
  exchange should produce nothing; say so.
- Do not put a free-text `revisit.trigger` on a deferral — it must be
  structured (`manual` / `metric` / `event` / `dependency`).
- Do not include `detail.options` with multiple `verdict='chosen'`. Exactly
  one chosen per `type='decision'`.
- Do not shell out to the bash CLI when the MCP tools are available — the MCP
  surface is the contract.
