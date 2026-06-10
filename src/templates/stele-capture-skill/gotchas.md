# Gotchas

Concrete traps fresh-context agents fall into. Read this before drafting a
`CapturePayload` — you will hit at least one on your first try.

## 1. `decision.id` is REASSIGNED, not honored.

You think you're picking it; the MCP tool overwrites with
`<featureId>/<local>` based on the resolved feature + the `type` field.
Pass `"?"`. The ONLY exception: if you pass a valid `<resolvedFeatureId>/<D|DEF|OQ>-NN`
and that id doesn't already exist, the tool honors it. Pass anything else
(e.g. a different feature's prefix, or a non-slash format) and the tool
silently regenerates.

## 2. `detail.options` is REQUIRED for `type='decision'`, even when there was no real fork.

Pass `[]` to assert "no fork". The schema error message blames `options`
not `detail`, which is confusing. If the choice was obvious enough that
you don't have alternatives to list, `options: []` is the right answer —
NOT omitting `detail`.

## 3. `revisit.trigger.kind: "dependency"` wants the dep's `id`, not a description.

`{kind: "dependency", on: "F-04/D-01"}`. The `on` field is the decision id,
NOT a sentence. The human-readable description belongs in `revisit.cond`,
which is optional and free-text.

## 4. `feature.mode='unscoped'` does NOT mean "no feature".

It binds to the auto-created per-project unscoped Feature (id starts with
`__unscoped:`). The decision still gets a real `<featureId>/<local>` id.
The unscoped Feature is for genuine exploration / debugging — don't use
it as a "skip this field" escape hatch.

## 5. The Stop hook only injects Features with `state='going'`.

Draft / winding / paused / done Features are NOT in the hook context. If
the user is continuing work on a `paused` Feature, you have to call
`feature_list` explicitly to find it. Don't confidently pick `mode='new'`
just because no active Features showed up in your context.

## 6. `sourceSession.sourceSessionId` ≠ stele `Session.id`.

The hook gives you the Claude Code `session_id` (a UUID like
`4721a313-...`). The stele Session.id is something like `ses-a8f31b9c`.
Different things, different formats. Use the UUID for `sourceSessionId`;
the stele Session.id appears only in `decision_capture` responses and
internal references.

## 7. Tagging an existing active tag bypasses `tag_policy` entirely.

`tag_policy='locked'` still lets the agent stick existing tags onto new
decisions — the policy only gates new tag CREATION. If you're worried
about over-tagging, look at `tag list` first; don't assume `locked`
prevents you from applying anything.

## 8. `tag_policy='locked'` silently logs blocked proposals.

You propose a new tag, the tool returns success, but the tag has
`outcome='blocked'` and was NOT applied to the decision. No exception is
thrown. Check the response — if `kind: "blocked"` came back from
`tag_propose`, your tag did nothing.

## 9. `decision_capture` does NOT auto-apply proposed edges.

The consolidate layer suggests edges (e.g. "this looks like it resolves
DEF-03"). They are printed for confirmation, NOT written. For each one the
user wants, you have to call `decision_resolve` separately. Skipping this
step means the cross-session stitch never happens — and that's the whole
point of the tool.

## 10. The hook injects `tag_policy` ONLY when `stele` is on PATH and `.stele/` exists.

The block is best-effort. Don't assume it's always present in your
`additionalContext`. If you're unsure of the current policy, call
`config_get key: "tag_policy"` — it's cheap and authoritative. The hook
also caches stale during the same conversation; the MCP tool always returns
current state.
