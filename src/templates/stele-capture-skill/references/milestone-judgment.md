# Step 0 — Milestone judgment

The `milestone` field on `decision_capture` tells the tool how to wire the
decision into a milestone + session. Three modes.

## `{ mode: "continue", id: "M-04" }`

The conversation has been working toward an existing active milestone.
Pick its id from the Stop hook's milestones block.

**Default to this if any active milestone topically matches.** "Topically
matches" doesn't mean "same project" — it means "the decision belongs to
the same goal the milestone is tracking." Be generous; proliferation of
milestones is the larger risk.

**Gotcha**: the hook only injects `state='going'` milestones. If the user
is continuing work on a `state='paused'` milestone, you have to call
`milestone_list state: "paused"` yourself to find its id. Don't reflexively
pick `mode='new'` just because nothing showed up in the hook context.

## `{ mode: "new", draft: { name, about?, featureId?, featureDraft? } }`

The user just kicked off a new direction and none of the active milestones
match. Open a new milestone.

Required:
- `name` — short title, ≤6 words. Phrased as a chunk of work, not a
  feature ("Binary artifact + SSE auth", not "Auth").

Optional but worth filling:
- `about` — one sentence of context. The Project page reads this; help
  future-you understand what this milestone was for.
- `featureId` OR `featureDraft` — see `references/feature-judgment.md`.
  If you omit both, the milestone lands under the auto-created unscoped
  Feature.

The new milestone starts in state `draft`. The first session opening on
it (which `decision_capture` does implicitly via `sourceSession`) advances
it to `going`.

**Heuristic for new vs continue**: did the user say "let me plan X" / "I
want to build Y" / "we're going to refactor Z" AND none of the active
milestones match the topic? Then `new`. Otherwise `continue`.

## `{ mode: "unscoped" }`

Genuinely no targeted goal. Debugging, exploration, "what does this
function do" — that's `unscoped`. Use sparingly.

**Gotcha**: `unscoped` does NOT mean "no milestone." The tool resolves it
to the per-project auto-created unscoped milestone (id starts with
`__unscoped-M:`). The decision still gets a real `<milestoneId>/<local>`
id. The unscoped milestone is real and queryable.

## After milestone is chosen

`sourceSession` always:

```
{ source: "claude-code", sourceSessionId: "<the cc_session_id the hook gave you>" }
```

The Stop hook injects the cc_session_id. NOT the stele Session.id (that's
internal). If the hook didn't fire (manual capture without the Stop hook
context), source can be `"manual"` and sourceSessionId can be omitted.
