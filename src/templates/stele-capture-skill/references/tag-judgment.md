# Step 0.5 — Tag judgment

Tags are a cross-cutting classification — `security`, `backend`, `perf`,
`compliance`, etc. — that lives alongside (not instead of) milestones.
A decision can carry several tags; same tag spans many decisions.

The Stop hook injects the project's **active tags** and current
**tag_policy**. Read those before deciding what to pass.

## Field shape

```
tags: [
  { name: "security", reason?: "OWASP A1 surface", suggestedColor?: "#942929" },
  { name: "backend",  reason?: "category mark" },
  ...
]
```

- `name` — short, lowercase-kebab if multi-word (`browser-ui`, not
  `Browser UI`).
- `reason` — REQUIRED when policy is `propose` and `tag_require_reason=true`
  (the default). One line on *why this decision needs THIS tag*.
- `suggestedColor` — optional `#RRGGBB` hex; otherwise the server picks one.

## Read the policy first

`tag_policy` is one of `auto` / `propose` / `locked`:

| Policy | What happens to a NEW tag name |
|---|---|
| `auto` | Created immediately, status='active', origin='agent' |
| `propose` (default) | Queued into `tag_proposals` for the user to confirm |
| `locked` | Refused; logged as `outcome='blocked'`; NO error to the agent |

What happens to an EXISTING active tag name: **always applied directly,
regardless of policy**. Reuse before propose.

## Reuse before propose

If any active tag fits the decision, pass its `name` exactly — the server
will reuse the existing tag rather than create a new one. Only propose a
new name when nothing existing captures the cross-cutting concern.

## Restraint

At most 2-3 tags per decision. Tagging everything `backend` defeats the
point. A tag is for cross-cutting concerns the *human* will want to filter
by later — not a redundant copy of the milestone name.

## Return value shape

The capture result tells you what happened to each tag:

```
{
  applied: [{name, tagId}, ...],          // existing tags re-applied
  pending: [{name, proposalId}, ...],     // queued via 'propose' policy
  blocked: [{name, proposalId}, ...],     // refused via 'locked' policy
  errors:  [{name, message}, ...]         // schema / validation failures
}
```

**Check `blocked` and `errors` even when the call succeeded** — a tag in
`blocked` did NOT attach to the decision.
