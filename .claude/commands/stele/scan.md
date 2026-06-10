---
description: Scan historical sources (Claude Code transcripts, git log, files) for decisions not yet in the graph. Re-runnable any time — first-install backfill is just the most common use case.
---

# `/stele:scan` — historical backfill / fine-grained audit

The 3-layer auto-capture model (live track, SessionStart inject,
SessionEnd post-hoc subagent) covers **everything forward from
install**. This command covers **everything before** — historical Claude
Code transcripts, prior git history, existing project docs.

Re-runnable any time: first install, after a long planning conversation
in a different tool, after a big feature branch merge, when you want
to audit the graph for completeness.

Args (parse from the slash command invocation):

```
/stele:scan                        scan historical CC transcripts (default)
/stele:scan --last N               only the N most recent transcripts
/stele:scan --git-since <date>     also scan commits since <date>
/stele:scan --files <path>...      also scan these specific files
/stele:scan --feature <id>         force everything under this feature
/stele:scan --dry-run              show what would happen, don't capture
```

You are the **live agent** in the user's current Claude Code session.
You have full MCP access including all `mcp__stele__*` tools, plus
`Read` / `Bash` / `Glob`. Use them directly — no subagent spawn, no
`claude -p` headless.

## The 7-step algorithm

### Step 1 — Resolve sources

Default sources to scan:

- **Historical Claude Code transcripts** for this project. Path:
  `~/.claude/projects/<sanitized-cwd>/*.jsonl`. Sanitization rule:
  the absolute cwd with `/` replaced by `-`. Example: cwd
  `/Users/niex/Documents/GitHub/kedge-stele` becomes
  `-Users-niex-Documents-GitHub-kedge-stele`. Compute it with:
  ```bash
  cwd=$(pwd)
  sanitized=$(echo "$cwd" | sed 's|/|-|g')
  ls -1t ~/.claude/projects/$sanitized/*.jsonl 2>/dev/null
  ```
  `ls -1t` sorts by mtime desc so the newest are first. Cap at
  `--last N` if the user passed it (default unlimited, but warn if
  more than 10 — backfill cost scales).

- `--git-since <date>` → also `git log --since=<date> --pretty=format:"%H|%ad|%s|%b" --date=iso` from the project cwd.
  Each commit is a candidate source.

- `--files <path>...` → also each file as a candidate source.

- `--dry-run` → after Step 3, print what you'd scan and exit. No
  candidates analyzed, no captures.

### Step 2 — Pull current capture state

```
feature_list                   → list of features in this project
for each feature:
  feature_decisions featureId  → existing decision title / source / dedupKey
```

Keep this in working memory as a set of `(featureId, normalized-title)`
pairs + sourceReports already seen. You'll check candidates against it
in Step 4.

### Step 3 — Walk each source

**Claude Code transcripts (JSONL).** Each line is JSON with `type:
"user"` | `"assistant"` | `"tool_use"` | `"tool_result"`. Read line by
line; assistant messages carry the decision-y signal (the agent's reply
that crystallized a choice). Note the `timestamp` field on each entry
— you'll use it for `raisedBy.at` so the SPA timeline shows the
historical chronology.

For transcripts, also note the `sessionId` field that Claude Code
writes into the JSONL header (or derive from filename). This becomes
the cc_session_id you'll feed back through `sourceSession` when
capturing.

**Git commits.** The commit message is the source. Look at the body
for decision-y language. The commit SHA goes into `sourceReport`.
`raisedBy.at` from the commit date.

**Plain files.** Walk the file for decision-y prose. CLAUDE.md often
has "we will go with X" / "deferred Y" lines that the live track
would have captured if it had existed. The file path goes into
`sourceReport`.

Apply the **same definition** of decision-y the live track uses:

- An option chosen over alternatives.
- Something explicitly deferred.
- A constraint locked in.

NOT decision-y:

- Generic problem-solving descriptions.
- Tactical edits / refactor descriptions.
- Discussion of options without commitment.

### Step 4 — Pre-filter dups

For each candidate, compute the would-be `dedup_key` mentally:
normalize-title + featureId + affects-hash. If it matches an existing
captured decision, drop the candidate silently (would dup-skip on
capture anyway, but you waste tokens by presenting it to the user).

Also drop candidates that match a captured decision title fuzzily —
the title text doesn't have to be byte-identical to be the same
observation.

### Step 5 — Present candidates to the user

Print a numbered list, one per candidate, in this shape:

```
Found 12 candidate decisions (after filtering 5 dups and 3 non-decisions):

  Source · ~/.claude/projects/-Users-.../session-2026-06-08.jsonl (5):

   1. [DECIDED]  "Use SQLite, not Postgres" — backend
      Context: turn 14, agent said "going to commit to node:sqlite. ..."
      → would capture under Feature F-01 "Storage", confidence 0.88

   2. [DEFERRED] "Should the WAL be tunable?"
      Context: turn 22, user said "punt that for now"
      → would capture under Feature F-01 "Storage", confidence 0.75
      → revisit: { kind: "manual" }, cond: "if perf problems show up"

   3. [DECIDED]  "Drop the old Feature umbrella"
      ...

  Source · git commit 6eb6f34 (3):

   6. [DECIDED]  "Cut 0.3.0 stable after dogfood passes"
      ...

  Source · CLAUDE.md (4):
   ...

Which to keep? Reply with one of:
  • "all"                     — capture every candidate
  • "1,3,7"                   — capture only those numbers
  • "1-10 except 5"           — range minus exclusions
  • "none"                    — skip everything (effectively dry-run)
  • "edit 2: <new title>"     — override the candidate's title before capture
```

Wait for the user's reply. Parse their selection. For "edit" lines,
update the candidate's title in your in-memory list before capture.

### Step 6 — Capture each kept candidate

For each kept candidate:

1. **Resolve Feature.** If `--feature <id>` was passed, use it. Otherwise:
   - If the candidate's source is a CC transcript, try to infer
     which Feature it belongs to from `feature_list` + the
     transcript's topic. If unclear, default to the unscoped Feature
     (`mode: "unscoped"`).
   - If the source is a git commit or file, use `feature.mode:
     "unscoped"` unless the user specified a feature.

2. **Recreate the historical Session (if not already present).** For
   CC transcript sources, call `mcp__stele__decision_capture` with:
   ```
   sourceSession: {
     source: "claude-code",
     sourceSessionId: <session-id from the transcript>
   }
   ```
   The MCP server will find-or-create the Session row.
   `UNIQUE(source, source_sess_id)` handles re-runs — you can scan
   the same transcript twice without duplicating Sessions.

3. **Build the decision payload:**
   ```
   decision_capture
     decision:
       id:        "?"
       featureId: "?"
       type:      "decision" | "deferred" | "open"
       status:    omit for "decision"; "open" for the others
       title:     <candidate's title (possibly user-edited)>
       raisedBy:
         trigger: "scan: <one-line context excerpt>"
         actor:   "agent"
         layer:   "personal"
         at:      <transcript entry timestamp | commit date | "now" for files>
       affects:   EntityRef[] inferred from the source
       detail:    when type='decision', REQUIRED with at least options:[]
       sourceReport: "scan:cc-transcript:<sess-id>"
                  | "scan:git-commit:<sha>"
                  | "scan:file:<path>"
     feature: { mode: "continue", id: <step 1 resolution> }
             | { mode: "unscoped" }
     sourceSession: { source: "claude-code",
                      sourceSessionId: <sess-id> }    // CC transcript only
     source: "session-extract"
     confidence: 0..1
   ```

4. **Handle dup-skip responses.** `dup-skip: <existingId>` is success
   — your candidate matched something already captured. Don't retry;
   move to the next.

### Step 7 — Print summary

```
Scan complete:

  Captured  N total
    · X from historical CC transcripts
    · Y from git commits (--git-since)
    · Z from files

  Skipped   M total
    · J pre-filtered as dups against existing decisions
    · K declined by user
    · L returned dup-skip during capture (same content already on disk)

  Open SPA: <project-url>?src=session-extract to review.
  All captures go in with source='session-extract', so the same
  amber pill + filter that surfaces SessionEnd captures will surface
  these too. Edit / delete from the Trace page.
```

## Confidence calibration

Same tiers as the SessionEnd subagent (since the data they look at is
similar — neither has live working context, both reason from text):

- `0.85+` — the source text explicitly says "we'll go with X" / "let's
  defer Y". You're reading the commitment almost verbatim.
- `0.55–0.85` — strong signal but not surfaced as "decided"; an option
  is clearly preferred but the word "decided" isn't there.
- `0.30–0.55` — leaning but not committed. **Capture as `type='open'`
  rather than `type='decision'`** so the SPA flags for review.
- `<0.30` — too speculative. Pre-filter; don't present.

## Anti-patterns

- **Don't scan all transcripts without warning the user.** If the
  default scan finds >10 transcripts, ask first: "Found 47 historical
  transcripts. Process all, or limit to --last N?"
- **Don't write to the user's filesystem.** This command only reads.
- **Don't author edges.** Edges across historical decisions need
  user judgment that's hard to automate; stick to nodes. The
  user can author edges later in the Trace page.
- **Don't pass `source: 'agent-live'`.** That's the live track's
  classifier. Yours is always `source: 'session-extract'` (extracted
  post-hoc from a text source) + `sourceReport: 'scan:<type>:<id>'`
  for origin tracking.
- **Don't make up `raisedBy.at`.** If the source has a timestamp, use
  it. If not (plain file with no mtime context the user cares about),
  use the current time but flag this in the trigger line.
- **Don't capture decisions ABOUT how to do this scan.** Your own
  meta-moves don't get captured.

## Composes with

- **`/stele:feature`** — reconciles the CURRENT session's transcript.
  Run frequently during work. `/stele:scan` reconciles OTHER sources.
  Run on first install + when you want a deeper audit.
- **SessionEnd subagent** — runs automatically at session close, reads
  the JUST-ENDED session's transcript. `/stele:scan` reads earlier
  ones (the SessionEnd subagent has already done the current one for
  you). Together: live → SessionEnd → /stele:scan covers every
  conceivable backfill source.
- **Stop hook (live track)** — fires per turn during work. Captures
  decisions in-flight with full context. Highest fidelity; `/stele:scan`
  is the lowest-fidelity tier (text archaeology over historical
  sources), so let the live track win whenever both look at the
  same content. The dedup_key in `decision_capture` handles this for
  you — your scan's writes get `dup-skip:` whenever the live track
  already wrote the same observation.
