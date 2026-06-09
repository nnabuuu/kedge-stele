# Step 0.7 — Feature judgment

When `milestone.mode === "new"`, you also have to decide which Feature
owns the new milestone. Three options.

## Use an existing Feature

```
milestone: {
  mode: "new",
  draft: { name: "...", featureId: "F-03" }
}
```

Call `feature_list` first to see what exists. Use this when the new
milestone clearly belongs to an existing structural area (`CcaaS`,
`Live Lesson`, `Skill Registry`, etc.).

**Default to this if any existing Feature fits.** Feature proliferation
is worse than milestone proliferation — projects rarely need more than
5-10 features over their lifetime.

## Open a new Feature

```
milestone: {
  mode: "new",
  draft: { name: "...", featureDraft: { name: "Telemetry" } }
}
```

Use this when the user is starting a genuinely new structural area —
something that will get multiple milestones over the long run. The
`featureDraft.name` is short and structural (single noun phrase like
"Telemetry" or "Compliance"), not a goal description.

## Omit both (fall through to unscoped)

```
milestone: {
  mode: "new",
  draft: { name: "..." }   // no featureId, no featureDraft
}
```

The milestone lands under the auto-created per-project unscoped Feature.
Use sparingly — milestones under the unscoped Feature don't show in the
left rail of the Project page in a useful way.

## When in doubt

Lean toward `featureId` (reuse) over `featureDraft` (create). Adding a
feature later is cheap; un-creating a fragmenting feature later is awkward
(you'd have to reassign all its milestones).
