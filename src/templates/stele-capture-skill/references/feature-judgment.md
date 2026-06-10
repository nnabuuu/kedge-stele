# Step 0 — Feature judgment

The `feature` field on `decision_capture` tells the tool how to wire the
decision into a feature + session. Three modes.

> **0.3.0 collapse:** Features used to come in two layers (an umbrella
> Feature like "CcaaS" with Milestones underneath). 0.3.0 dropped the
> umbrella. The Feature you pick here IS the chunk of work — what 0.2.x
> called a Milestone.

## `{ mode: "continue", id: "F-04" }`

The conversation has been working toward an existing active Feature.
Pick its id from the Stop hook's features block (or from
`/stele:feature` step 1, if that's how you got here).

**Default to this if any active Feature topically matches.** "Topically
matches" doesn't mean "same project" — it means "the decision belongs to
the same chunk of work the Feature is tracking." Be generous;
proliferation of Features is the larger risk.

**Gotcha**: the hook only injects `state='going'` Features. If the user
is continuing work on a `state='paused'` Feature, you have to call
`feature_list state: "paused"` yourself to find its id. Don't reflexively
pick `mode='new'` just because nothing showed up in the hook context.

## `{ mode: "new", draft: { name, about? } }`

The user just kicked off a new direction and none of the active Features
match. Open a new Feature.

Required:
- `name` — short title, ≤6 words. Phrased as a chunk of work
  ("Binary artifact + SSE auth"), not as a high-level area ("Auth").

Optional but worth filling:
- `about` — one sentence of context. The Project page reads this; help
  future-you understand what this Feature was for.

The new Feature starts in state `draft`. The first session opening on
it (which `decision_capture` does implicitly via `sourceSession`) advances
it to `going`.

**Heuristic for new vs continue**: did the user say "let me plan X" / "I
want to build Y" / "we're going to refactor Z" AND none of the active
Features match the topic? Then `new`. Otherwise `continue`.

## `{ mode: "unscoped" }`

Genuinely no targeted goal. Debugging, exploration, "what does this
function do" — that's `unscoped`. Use sparingly.

**Gotcha**: `unscoped` does NOT mean "no feature." The tool resolves it
to the per-project auto-created unscoped Feature (id starts with
`__unscoped:`). The decision still gets a real `<featureId>/<local>`
id. The unscoped Feature is real and queryable.

## After feature is chosen

`sourceSession` always:

```
{ source: "claude-code", sourceSessionId: "<the cc_session_id the hook gave you>" }
```

The Stop hook injects the cc_session_id. NOT the stele Session.id (that's
internal). If the hook didn't fire (manual capture without the Stop hook
context), source can be `"manual"` and sourceSessionId can be omitted.
