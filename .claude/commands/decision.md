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

> **Transport**: this command drives the `stele` MCP server. The 4 tools
> (`decision_capture` / `decision_resume` / `decision_trace` / `decision_resolve`)
> must already be registered in the user's Claude Code MCP config (see the
> stele README for the JSON snippet). If they're not, fall back to the
> CLI by piping JSON into `npm run add` from inside the repo.

## Steps

1. **Read the current store** so you can propose consolidation edges. Call the
   MCP tool:
   ```
   decision_resume                # what's open/deferred right now
   ```
   Note the existing nodes — the new decision may resolve one.

2. **Draft a `CapturePayload`** (see `src/types.ts` in the stele repo)
   from the conversation. Fill *every* field you can infer — do NOT reduce it
   to a title + rationale:
   - `id`: pick the next free `D-NN` (or `DEF-NN` for deferral / `OQ-NN` for open).
   - `title`: phrase it as a **question** ("X 还是 Y?", not "我们选了 X").
   - `raisedBy.trigger`: what in the conversation surfaced this (1 line).
   - `raisedBy.actor` / `layer`: ambient identity + governance layer
     (district / school / personal — personal is the default for solo use).
   - `raisedBy.at`: ISO timestamp (use the conversation's clock).
   - `constraint`: the hard thing that made the choice non-obvious.
   - `status.options`: every alternative weighed, with `verdict` + `why`. Mark
     exactly one `chosen` for `status.kind === "decided"`.
   - `status.rationale`: *why this option* — the reasoning, not the choice.
   - `status.delta` (optional, often absent): the intent change as addressable
     patches. ONLY when the decision modifies an intent bundle; pure code /
     tooling decisions don't carry delta — leave it off.
   - `consequences.lockedIn` / `lockedOut`: what gets cheap / expensive downstream.
   - `affects`: `EntityRef[]` — `{kind:"file"|"feature"|"skill"|"lesson", id}`.
   - If this is a **deferral**, use `status.kind === "deferred"` with a
     STRUCTURED `revisitWhen` (`{kind:"metric"|"event"|"dependency"|"manual",...}`),
     NEVER free text — the resume layer can't tell a free-text trigger is due.
   - If it's a genuine unknown, use `status.kind === "open"` with `question`.

3. **Propose edges** against existing open/deferred nodes from step 1. If this
   decision answers a pending one, draft a `resolves` edge; if related, `relates`.
   Put authored edges in `payload.edges` — the MCP tool will ALSO run the
   consolidate layer and propose more for the human to confirm.

4. **Call the tool.** One MCP call captures the node AND prints the
   consolidate-proposed additional edges:
   ```
   decision_capture
     decision: <the Decision object you drafted>
     edges:    <your authored Edge[] (optional)>
   ```

5. **Confirm** to the user: the id captured, your authored edges, and any
   *additional* edges the consolidate layer proposed. For each proposed edge
   the user wants to accept, call:
   ```
   decision_resolve  kind: "resolves" | "relates" | ...
                     from: <by>
                     to:   <target>
                     note: <optional one-liner>
   ```

## Do NOT

- Do not ask the user to fill fields. Draft, then let them correct.
- Do not invent a decision if none was reached — `/decision` on a trivial
  exchange should produce nothing; say so.
- Do not put a free-text `revisitWhen` on a deferral — it must be structured
  (`metric` / `event` / `dependency` / `manual`) or resume can never surface
  the deferral as due.
- Do not include `status.delta` on pure code / tooling decisions. It's for
  decisions that mutate an intent bundle, not for everything.
- Do not shell out to bash CLI when the MCP tools are available — the MCP
  surface is the contract; falling back to `npm run add` is only for the
  setup-not-done escape hatch.
