# Decision schema — field by field

The 0.1.0 Decision shape is a *split* form: the discriminated `Status`
union from 0.0.x is gone. The discriminator now lives in three separate
fields (`type` / `status` / `supersededBy`) and the rich content lives in
a dedicated `detail` body.

See `gotchas.md` for the traps Zod will throw at you.

## Top-level fields

- `id` — pass `"?"`. The tool reassigns to `<featureId>/<local>` after
  feature resolution. The local prefix follows `type`:
  `"D-NN"` for `decision`, `"DEF-NN"` for `deferred`, `"OQ-NN"` for `open`.
  The only time the tool honors a passed id is when it already matches the
  `<resolvedFeatureId>/<correct-prefix>-NN` format AND doesn't collide.
- `featureId` — pass `"?"`. The tool reassigns based on the `feature`
  field in the CapturePayload (NOT this field).
- `sessionId` — usually omit (the tool stamps the resolved session).
  Pass it only when you previously called `session_start` and want to bind
  this decision to that specific session.
- `type` — `"decision"` | `"deferred"` | `"open"`. The structural discriminator.
- `status` — `undefined` for `type='decision'`. `"open"` for `deferred`/`open`
  (until a later decision resolves them, at which point the store flips it
  to `"resolved"` for you).
- `resolvedBy` / `supersededBy` — leave undefined. The store sets these
  when a `resolves` / `supersedes` edge points at this decision.
- `title` — phrase as a **question** for `deferred`/`open` ("Should we use
  X or Y?"). Statement OK for `decision` ("Switched to per-session DBs").
- `scope` — optional one-word category like "Runtime" / "Backend" /
  "Design" / "Security".
- `raisedBy` — required:
  ```
  raisedBy: {
    trigger: "what conversation move surfaced this (1 line)",
    actor:   "agent" | "user" | "team-name",
    layer:   "district" | "school" | "personal",   // personal is the default for solo use
    at:      "<ISO timestamp>"
  }
  ```
- `revisit` — required for `deferred`/`open`, omitted for `decision`.
  See `Revisit` below.
- `detail` — REQUIRED for `type='decision'`, optional for the others.
  See `DecisionDetail` below.
- `affects` — `EntityRef[]`. The "things this decision touches". Each
  `EntityRef` is `{kind, id}` where `kind` is `"file"` / `"feature"` /
  `"skill"` / `"lesson"` / etc., and `id` is the path or slug.
- `artifacts` — top-level array of `{file, commit?}`. Prefer
  `detail.artifact` (singular, primary artifact) for new captures; this
  field exists for legacy seeded data.
- `sourceReport` — provenance string for seeded HTML records. Don't set on
  agent captures.
- `createdAt` — `<ISO timestamp>`.

## `DecisionDetail` (the rich body)

```ts
{
  optionAxis?: "Approach" | "Storage backend" | "Concurrency model" | ...
  trigger?:    "1-line prose of what surfaced the decision"
  constraint?: "the hard thing that made the choice non-obvious"
  options?:    DecisionOption[]
  why?:        ["rationale paragraph 1", "paragraph 2", ...]
  locks?:      { in?: "what this locks IN (cheap downstream)",
                 out?: "what this locks OUT (expensive downstream)" }
  artifact?:   { file?: "src/path.ts", commit?: "sha" }
}
```

**`options`** is the load-bearing field. For `type='decision'`, it's
REQUIRED. Each option:

```ts
{
  name:    "SQLite" | "Postgres" | ...    // short label
  desc?:   "one-line description"
  verdict: "chosen" | "rejected"          // EXACTLY one option has verdict='chosen'
  why?:    "why chosen / why rejected"
  chosen?: true                            // convenience mirror of verdict==='chosen'
}
```

If the choice was obvious enough that there was no real fork, pass
`options: []`. The schema accepts this — it means "I asserted no real
alternatives." DO NOT omit `detail` entirely; the schema rejects that.

## `Revisit` (for deferred / open)

```ts
{
  trigger: Trigger,
  cond?:   "human-readable description of when this should be revisited"
}
```

`Trigger` is a discriminated union — STRUCTURED, never free text:

```ts
{ kind: "manual" }                          // user will check in periodically
{ kind: "metric",     expr: "schools > 50" }     // a numeric / observable condition
{ kind: "event",      name: "ccaas-v2 ships" }   // a named event
{ kind: "dependency", on:   "F-04/D-01" }        // a specific other decision
```

For `dependency`, `on` is the **decision id**, not a sentence. Put the
sentence in `cond`.

## `CapturePayload` top-level

```ts
{
  decision: <Decision as above>,
  edges?:   Edge[],                        // authored edges, written verbatim
  feature?: CaptureFeatureMode,          // see references/feature-judgment.md
  sourceSession?: { source: "claude-code", sourceSessionId: "<cc_session_id>" },
  sessionId?:    "ses-<short hash>",       // if you explicitly session_start'd earlier
  tags?:    CaptureTagRequest[]            // see references/tag-judgment.md
}
```

## `Edge`

```ts
{
  from:     "<DecisionId>",
  to:       "<DecisionId>",
  relation: "resolves" | "supersedes" | "reconciles" | "relates" | "depends_on",
  note?:    "one-liner why"
}
```

`relation: "resolves"` and `relation: "supersedes"` MUTATE the target —
they flip the target's status / write `resolvedBy` or `supersededBy`. The
other three relations are non-mutating links.

The MCP tool rejects edges whose endpoints don't exist yet — so you can
author edges referencing the decision you're capturing in THIS call (using
its eventual `<featureId>/<local>` id), but you can't reference one that
hasn't been captured yet from a future call.
