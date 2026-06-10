# Changelog

All notable changes to **stele-mcp** are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions use SemVer with a `-snapshot` pre-release tag during the alpha
phase — **the API may shift between snapshot releases**. The `latest`
npm dist-tag is intentionally pinned at `0.0.1-snapshot`; install
explicit snapshots via:

```bash
npm install -g stele-mcp@snapshot
```

## [Unreleased]

— nothing yet —

## [0.3.0] · 2026-06-10

**Breaking release.** Four product-shape changes shipped together — the
ones that came out of the post-0.2.0 UX review:

1. **One layer too many in the hierarchy.** `Project → Feature → Milestone
   → Session → Decision` collapses to `Project → Feature → Session →
   Decision`. The 0.2-era umbrella `Feature` (CcaaS / Live Lesson) is
   gone; its naming becomes a tag. What used to be a `Milestone` IS the
   new `Feature` — same shape (5-state, `about`, `sequenceAfter`, dates)
   plus a NEW rolling `summary` field that `/stele:feature` rewrites.
2. **One slash command, not three.** `/decision`, `/milestone-report`,
   `/resume` are all deleted outright — no aliases, no migration period.
   They're replaced by the single namespaced `/stele:feature`, an
   idempotent reconcile pass that catches what the conversation already
   decided and rewrites the rolling summary. `stele init` on an upgraded
   0.2.x project deletes the orphaned command files automatically.
3. **MCP tool surface shrinks 22 → 19.** `session_start`, `session_end`,
   `resume_command`, and the umbrella `feature_open` / `feature_list` are
   gone. The (formerly) milestone tools renamed: `milestone_list` /
   `milestone_open` / `milestone_report` → `feature_list` /
   `feature_open` / `feature_report`. New: `feature_decisions` (the data
   behind `/stele:feature` step 2) and `feature_set_summary` (the step 5
   sink). Agent's mental load drops.
4. **Local-first release flow.** Snapshots `0.3.0-snapshot.{1,2,3}` landed
   on GitHub only — no per-snapshot `npm publish`. The user dogfooded
   `/stele:feature` against a `npm install -g .` install in a throwaway
   project before this stable cut.

### Added

- `feature_decisions(featureId)` projection + MCP tool + `GET
  /api/features/<id>/decisions` route — every decision on a Feature
  across every Session, ordered newest-first.
- `feature_set_summary(featureId, summary)` MCP tool + `POST
  /api/features/<id>/summary` route — the `/stele:feature` step 5 sink.
  Replaces (does not append) `Feature.summary`.
- `Feature.summary` field — rolling 2-4 sentence prose summary of where
  this Feature stands, rewritten by `/stele:feature` on every call.
- `featuresList(state?)` projection — flat per-project feature list with
  tags + counts + lastActivity. Replaces the umbrella-grouped
  `featureRail`. Drives `GET /api/features`.
- `.claude/commands/stele/feature.md` template — the single slash
  command. Carries the 5-step reconcile algorithm.
- 0.3.0 `Store` constructor detects pre-0.3.0 DBs (either pre-0.1 shape
  with `decisions.status_kind`, or 0.1–0.2 shape with the umbrella
  `features` table) and renames the file aside to `<path>.0.2.x.db`
  before creating a fresh schema. `migratedFromLegacy` surfaces the
  hint via CLI / MCP.

### Changed

- **Schema**: `Decision.featureId` (was `milestoneId`); decision id format
  is `<featureId>/<local>` (e.g. `F-01/D-04`). `Tagging.targetKind ∈
  {feature, decision}` (was `{milestone, decision}`). Session retains
  `outcome` / `pauseReason` as decodable legacy fields; the agent-facing
  path no longer writes them.
- **Projections**: `milestoneSummary` → `featureSummary`,
  `milestoneDetail` → `featureDetail`, `projectRollup.milestonesByState`
  → `featuresByState`, `projectListSummary.topMilestone` → `topFeature`,
  `traceStitch.{earlier,later}Session.milestoneName` → `featureName`,
  `graphSlice.milestones` → folded into `graphSlice.features` (the
  columns ARE the Features now).
- **HTTP routes**: `/api/milestones[/<id>[/report]]` → `/api/features[/
  <id>[/report]]`. `GET /api/features` returns the flat
  `featuresList` shape; `?summary=1` keeps the legacy `featureSummary`
  shape for callers that still want it. `GET /<slug>/api/feature-rail`
  is gone (its data lives in `/api/features`).
- **Hooks installer** (`src/hooks.ts`) rewrites the install layout: a
  single `/stele:feature` slash command at
  `.claude/commands/stele/feature.md`, and an `installHooks` that
  unconditionally cleans up `.claude/commands/{decision,milestone-
  report,resume}.md` from prior 0.2.x installs. `InstallReport` /
  `StatusReport` shape changed to match.
- **Stop hook** (`src/templates/stele-stop-hook.sh`): shells out to
  `stele features list --state going --json` (was `stele milestones
  list`); injected context label "Active milestones" → "Active
  features".
- **Stele-capture skill** (`src/templates/stele-capture-skill/`): the
  `milestone-judgment.md` reference retires (umbrella collapsed); the
  surviving `feature-judgment.md` describes continue/new/unscoped at
  the Feature level. `SKILL.md` adds a section on the `/stele:feature`
  reconcile pattern. The Decision shape itself did NOT change.
- **Web SPA** (`web/pages/*.js`): `topMilestone` → `topFeature`;
  `milestonesByState` → `featuresByState`; the Project page collapses
  one layer (flat feature rail + selected-feature detail with session
  timeline). Class names rename (`.ms-state-pill` → `.fe-state-pill`).
  `?m=<mid>` URL state becomes `?f=<fid>` with a one-release legacy
  alias.

### Removed

- MCP tools: `session_start`, `session_end`, `resume_command`, and the
  umbrella `feature_open` / `feature_list`.
- Slash commands: `/decision`, `/milestone-report`, `/resume`.
- HTTP routes: `POST /api/features` (umbrella open), `POST
  /api/sessions/start`, `POST /api/sessions/<id>/end`, `GET
  /<slug>/api/feature-rail`.
- Skill reference: `stele-capture-skill/references/milestone-
  judgment.md`.
- Projection: `featureRail` (replaced by `featuresList`).

### Migration story

When `Store` opens a pre-0.3.0 `.stele/decisions.db`, it renames the
file aside to `<path>.0.2.x.db` and creates a fresh 0.3.0 schema. The
snapshot CLI / MCP prints a one-time hint pointing at the backup. No
auto-translation of prior Decision rows — query the backup via
`sqlite3` if you need the data. `stele init` on an upgraded project
also deletes the orphaned 0.2.x slash command files.

### Tests

181 pass / 0 fail. Reworked `acceptance`, `capture`, `projections`,
`schemas`, `serve`, `hooks` test suites for the new shape; the
`milestones.test.ts` file moved to `features.test.ts` along with the
entity rename.

### Out of scope (deferred to 0.3.1+)

- `IntentDelta` bundle layer (still deferred-but-on-purpose).
- Real `EntityResolver` (stub stays).
- Auto-proposing `depends_on` from the consolidate layer.
- Cross-project queries / federation.

## [0.2.0] · 2026-06-09

**SPA rebuild against the design taxonomy.** Multi-snapshot release
(`0.2.0-snapshot.{1..7}`) that brought `web/` from its 0.0.7-era
incidental shape into the page taxonomy + token systems documented in
`design/*.html`. New page modules: Projects overview, Project page
with feature rail + session timeline, Trace page with cross-session
stitch, Tags page with policy panel + pending proposals, Decision
Graph with `graphSlice` projection + SVG renderer. Per-page CSS scopes
(`v-base` / `v-trace` / `v-graph`). Single-project mode for `stele
serve` (no `--multi`) added so the dev loop doesn't need the daemon.
URL decoding fixes for non-ASCII feature names. No backend schema
changes in this release.

## [0.1.0-snapshot] · 2026-06-09

**Breaking release.** The 0.0.x → 0.1.0 cut. Decision shape, milestone state
enum, edge field name, and id format all change. Pre-0.1.0 databases are
auto-renamed aside (see Migration below); the snapshot npm channel is the
intended audience, so the blast radius is small.

### Added — domain model

- **Project** is a first-class DB entity now (was registry-only). Each
  per-project `.stele/decisions.db` holds exactly one Project row with
  `name`, `code`, `path`, `status ∈ {active, winding, dormant, archived}`,
  and a `createdAt` timestamp. `stele init` bootstraps it.
- **Feature** is a new entity between Project and Milestone. The structural
  axis (`CcaaS`, `Live Lesson`, ...) that pairs with cross-cutting Tags.
  Each Feature has an `id`, `projectId`, `name`, and optional `links[]` to
  other Features. Each project gets an auto-created "unscoped" Feature for
  decisions that don't fit a real Feature.
- **Milestone state** widens from 3 states (`active/shipped/abandoned`) to
  **5 states (`draft/going/winding/done/paused`)**. State transitions:
  - opens at `draft` until a session opens on it (auto-advance to `going`)
  - `session_end({outcome:{type:'resolved'}})` advances `going → winding`
  - explicit transitions to `done` / `paused` via CLI
- **Milestone** gains `about` (one-line context), `sequenceAfter[]`
  (predecessor milestone ids), and a required `featureId` FK.
- **Session** gains structured fields: `provenance` (cwd + zellij info +
  `layoutAlive` flag), `outcome` (typed: `advanced` | `resolved` | `touched`
  + summary + resolves[] + via), and `pauseReason` (kind + note).
- **Decision** splits the old discriminated `Status` union into separate
  columns: `type ∈ {decision, deferred, open}`, `status ∈ {null, open,
  resolved}`, `resolvedBy`, `supersededBy`. A rich `detail` body holds
  `optionAxis` / `trigger` / `constraint` / `options[]` / `why[]` /
  `locks{in,out}` / `artifact{file,commit}`. A new derived `nodeState`
  helper rolls the split back into the 6-state UI label.
- **Decision id format** changes from `D-NN` / `DEF-NN` / `OQ-NN` to
  `<milestoneId>/<local>` (e.g. `M-01/D-04`). The status-prefixed local
  part is still glanceable. Unscoped decisions live under the auto-created
  unscoped milestone, so every id parses with one regex.
- **Edge** field rename: `kind` → `relation`. A new `depends_on` value joins
  the relation enum. `resolves` and `supersedes` still flip the target;
  `depends_on` / `relates` / `reconciles` are non-mutating.

### Added — MCP tools (22 total, was 17)

- New: `feature_open`, `feature_list`
- New: `session_start`, `session_end`, `milestone_report`, `resume_command`
- Renamed: `decision_resolve` arg `kind` → `relation`
- Extended: `decision_capture` accepts the new Decision shape, an explicit
  `sessionId` (when `session_start` was called separately), and an updated
  `milestone.draft` shape with `featureId` / `featureDraft`.
- Retired: `milestone_close` (state advances via the `milestone_report` /
  `session_end` flow + explicit `set-state` CLI).

### Added — slash commands

- New: `/milestone-report` ("走之前留话") — agent drafts a session summary
  + structured pause_reason + open-loop list, user confirms, tool advances
  milestone state.
- New: `/resume` ("回来时念回来") — agent reads back the last session's
  outcome + pause_reason and prints a copy-paste `claude --resume` command.
  Mode is `jump` (zellij layout still alive) or `rebuild`.

### Added — CLI subcommands

- `stele project {show, set-status}` — current project's DB row + rollup
- `stele features {list, open}`
- `stele sessions {list, start, end, resume, continue}` — `continue` is
  the CLI equivalent of `/resume`
- `stele milestones {list, open, report, show, set-state}` — `close`
  retired; `set-state` for explicit transitions; `report` for the
  walk-away ritual
- `stele depends-on <from> <to> [note]` — author depends_on edges
- Retired: `stele seed` (source file kept for one snapshot in case users
  have unmigrated HTML archives) and `stele milestones close`.

### Added — HTTP routes

- `GET /api/project`, `GET/POST /api/features`, `GET /api/features/:id`,
  `GET /api/sessions`, `GET /api/sessions/:id`, `POST /api/sessions/start`,
  `POST /api/sessions/:id/end`, `GET /api/sessions/:id/resume-command`,
  `GET /api/milestones/:id/report`, `POST /api/project/status`.
- `GET /api/decisions/<milestone>/<local>` works with the slash in the id.

### Added — agent surface

- The Stop hook now queries `stele milestones list --state going --json`
  and surfaces only active milestones to the skill.
- `stele-capture` skill grew **Step 0.7 — Feature judgment** and a
  rewritten Decision-shape primer for the new split form.

### Migration story

When `Store` opens a pre-0.1.0 `.stele/decisions.db` (detected by the
`decisions.status_kind` column), it **auto-renames the file aside** to
`<path>.0.0.x.db` and creates a fresh 0.1.0 schema. The snapshot CLI/MCP
prints a one-time hint pointing at the backup. No auto-translation of
prior Decision rows — query the backup via `sqlite3` if you need the data.

### Tests

138 → 169 (added Project/Feature/Session lifecycle tests, end-to-end
acceptance scenario; rewrote all schema/projection/capture/serve tests for
the new shape).

### Out of scope (deferred to 0.1.1+)

- `web/` SPA rebuild against the design mocks. The frontend keeps its
  0.0.7 shape this release and renders incompletely; the rebuild is the
  next planning round.
- `IntentDelta` bundle layer.
- Auto-proposing `depends_on` from the consolidate layer (authored only
  in 0.1.0).
- Real `EntityResolver` (stub stays).

## [0.0.7-snapshot] · 2026-06-09

### Added
- **Tags as first-class.** A `Tag` is a cross-cutting label
  (`security`, `backend`, `perf`, ...) attachable to both decisions and
  milestones via `Tagging` (M:N). Tags carry `origin` (`you` / `agent`),
  `status` (`active` / `archived`), a hex color, and a unique
  case-insensitive `name`.
- **Tag policy engine** (`src/tags.ts`). The local `tag_policy` config
  (per-project, in the new `config` table) gates whether the agent can
  create new tags directly:
  - `auto` — create immediately (`origin='agent'`, `status='active'`),
    audit-logged as `auto_adopted` in `tag_proposals`
  - `propose` (default) — queue into `tag_proposals` for the human;
    `tag_require_reason` (default `true`) makes `reason` mandatory
  - `locked` — refuse, log the attempt as `blocked`
  Existing active tags always apply directly regardless of policy —
  only NEW tag CREATION is gated.
- New SQLite tables: `tags`, `taggings`, `tag_proposals`, `config`.
  All created idempotently via `CREATE TABLE IF NOT EXISTS` — pre-0.0.7
  databases pick them up on first open with no migration step.
- **WAL journaling** enabled on the SQLite store. Existing rows are
  unaffected; concurrent readers (e.g. the always-on daemon while a CLI
  command is writing) no longer serialise.
- New MCP tools: `tag_propose`, `tag_apply`, `tag_confirm`, `tag_reject`,
  `tag_recolor`, `tag_rename`, `tag_archive`, `tag_restore`, `config_get`,
  `config_set` (10 in total).
- `decision_capture` grew an optional `tags` field — each
  `{name, reason?, suggestedColor?}` runs through the policy engine and
  the result (applied / pending / blocked / error) is reported back in
  the capture-result text.
- `stele tags {list, propose, apply, confirm, reject, recolor, rename,
  archive, restore, proposals}` CLI subcommand. `--json` output on
  `tags list` is what the Stop hook consumes.
- `stele config {list, get, set}` CLI subcommand for managing
  `tag_policy` / `tag_require_reason` (and any future keys).
- HTTP API: `GET/POST /<slug>/api/tags`, `GET /<slug>/api/tags/proposals`,
  `POST /<slug>/api/tags/proposals/:id/{confirm,reject}`,
  `POST /<slug>/api/tags/:id/{apply,recolor,rename,archive,restore}`,
  `DELETE /<slug>/api/tags/:id/tagging`, `GET /<slug>/api/decisions/:id/tags`,
  `GET /<slug>/api/milestones/:id/tags`,
  `GET/POST /<slug>/api/config[/<key>]`. Routes ship without a frontend
  consumer this release; the browser UI catches up in 0.0.8.
- Stop hook injects active tags and current `tag_policy` into
  `additionalContext` so the `stele-capture` skill knows what to reuse vs
  propose without a separate round-trip.
- `stele-capture` skill grew **Step 0.5 — Tag judgment** with reuse-first
  guidance and the policy → behaviour table.

### Tests
- 31 new tests (21 for the policy engine in `src/tags.test.ts`, 10 for
  the HTTP routes in `src/serve.test.ts`). Total: 138 → 169.

### Out of scope (deferred to 0.0.8)
- Web UI for tags (management page, chip rendering on decision /
  milestone detail, capture-form picker). Backend is in; frontend
  catches up next release.

## [0.0.6-snapshot] · 2026-06-09

### Added
- **Two-level grouping over the decision graph.** New entities:
  - `Milestone` — aspirational unit ("ship the multi-tenant daemon")
    with status (`active` / `shipped` / `abandoned`).
  - `Session` — one tool-conversation (Claude Code session, Codex run,
    OpenCode chat, ...) belonging to a milestone. Multiple sessions per
    milestone are common; each new decision capture from the same Claude
    Code session collapses to the same Session entity via
    `UNIQUE(source, sourceSessionId)`.
  - `Decision.sessionId` — optional foreign key to a Session. Decisions
    on pre-0.0.6 databases stay unscoped; the column is added lazily
    via `ALTER TABLE` on first open.
- New MCP tools: `milestone_list`, `milestone_open`, `milestone_close`.
- `decision_capture` grew two optional fields — `milestone` (continue
  an existing milestone, open a new one, or unscoped) and `sourceSession`
  (source tool + native session id). The MCP server wires up the
  Milestone + Session + Decision relationship in one round-trip.
- `stele milestones {list,open,close,show}` CLI subcommand.
  `--json` output on `list` is what the Stop hook consumes.
- Stop hook injects the **active milestones list** and the Claude Code
  session id into `additionalContext` so the skill can make the
  continue-vs-new judgment without a separate MCP roundtrip.
- The `stele-capture` skill (and `/decision` slash command) grew a
  **Step 0: milestone judgment**: pick `continue` if the conversation
  topically matches an active milestone (the safer default), `new` if
  the user just kicked off a fresh direction, or `unscoped` for
  exploration. Always pass `sourceSession` so multi-capture sessions
  collapse cleanly.
- Web UI: new `/<slug>/milestones` list page + `/<slug>/milestones/:id`
  detail (shows milestone metadata + sessions + decisions grouped by
  session). Topbar nav adds "milestones" link, `g m` keyboard shortcut.
  Decision detail page now shows the session id when present.
- 15 new tests in `src/milestones.test.ts` covering milestone/session
  CRUD, dedup, decisionsInMilestone aggregation, and the lazy schema
  migration on pre-0.0.6 databases. Total now **124 tests**.

### Changed
- `Decision.raisedBy.session` (free-text) is now legacy — the new
  `sessionId` field is the canonical link. Existing data is preserved
  unchanged.
- The `stele-capture` skill's `description` keeps the same wording the
  hook semantically activates against; only the body gained Step 0.

### Coming in 0.0.7
- Overview at `/` rewritten to be milestone-grouped (currently the
  per-project overview is still the resume digest).
- Capture form at `/<slug>/new` gets a milestone picker (continue / new
  / unscoped radio). Currently captures from the browser are unscoped.



## [0.0.5-snapshot] · 2026-06-08

### Added
- **56 new tests** (109 total) covering `projections.ts` (resume
  ordering, needsCheck semantics for metric / event / dependency
  triggers, trace edges with direction, traceEntity), `consolidate.ts`
  (proposeEdges heuristic — entity-only vs title-only, skip already-
  resolved deferreds, sort order), `paths.ts` (walk-up with `$HOME`
  boundary, `STELE_DB` override, `.stele` FILE-not-dir handled), and
  `serve.ts` HTTP roundtrips for both single-project and multi-tenant
  modes (22 tests — including the registry-mtime live-update path).
- `serve.ts` exports `startServerForeground` for the CLI's
  keep-alive-until-SIGINT use case, separated from the testable
  `startServer`.

### Changed
- **`startServer` no longer never-resolves.** It now returns a
  `RunningServer` handle (`{ server, url, port, host, close() }`)
  once the port is bound. The previous blocking behavior is preserved
  for `stele serve` via `startServerForeground`. External callers
  must update their `await` pattern.

## [0.0.4-snapshot] · 2026-06-08

### Added
- **First test suite (53 tests)** using built-in `node:test` (zero new
  runtime deps; adds `typescript` + `@types/node` as dev). Coverage
  focused on regression-prone seams:
  - `registry.ts` — slug generation, collision suffixes, idempotent
    register, corrupt-JSON tolerance, atomic write.
  - `schemas.ts` — discriminated-union pinning for Trigger (the
    structured-not-free-text contract), Decision happy paths and
    rejections.
  - `hooks.ts` — settings.json merge **including a permanent
    regression test for the 0.0.1 broken shape**.
- `npm test` script.

### Fixed
- `src/serve.ts:225` type error (Zod 4 discriminated union inferring
  `revisitWhen` as optional) via an `unknown` cast that bridges the
  Zod-inferred and canonical `Decision` shapes. The Zod safeParse
  enforces the constraint at runtime; the cast is purely a static
  bridge. **Build is now warning-free for the first time since
  0.0.1.**

## [0.0.3-snapshot] · 2026-06-08

### Added
- **Single multi-tenant daemon** at `http://127.0.0.1:3939/` serving
  every registered project at `/<slug>/`. Replaces the previous
  one-daemon-per-project / one-port-per-project model.
- Global project registry at `~/.stele/registry.json` mapping unique
  slugs to absolute paths. Slug defaults to the directory basename;
  collisions get `-2` / `-3` suffixes.
- `stele projects list` and `stele projects remove <slug>` subcommands.
- `stele serve --multi` flag (the daemon always uses it; foreground
  `stele serve` defaults to single-project mode for backward
  compatibility).
- Overview page at `/` showing every project with open-loop counts.
- Project switcher dropdown in the browser UI topbar.
- `g p` keyboard shortcut (overview).

### Changed
- `stele init` registers the current directory into the global
  registry and prints the resulting `http://127.0.0.1:3939/<slug>/`
  URL as the next-step link.
- **`stele daemon install` is idempotent and automatically sweeps
  legacy plists** from pre-0.0.3 installs. It reads each old plist's
  `WorkingDirectory` and re-registers the project into the global
  registry, so no decisions go missing across the upgrade.
- Daemon Label fixed at `com.stele.daemon` (was `com.stele.<hash>`
  per project).
- Logs moved from `<project>/.stele/serve.log` to
  `~/.stele/daemon.log`.

### Removed
- `stele init --port N` flag (the daemon is a singleton at 3939).
  Foreground `stele serve --port N` still works.

## [0.0.2-snapshot] · 2026-06-08

### Fixed
- **`.claude/settings.json` Stop hook shape.** 0.0.1 wrote
  `{ type, command }` directly into the `Stop` array; Claude Code's
  real schema requires
  `{ matcher: "", hooks: [{ type, command }, ...] }`. `/doctor`
  flagged it. This fix nests the entry correctly **and** detects the
  broken legacy shape on reinstall, healing it in place. Unrelated
  Stop entries and other hook events (e.g. `PostToolUse`) are
  preserved.

## [0.0.1-snapshot] · 2026-06-08

### Added
- **First public npm release.** A local decision-provenance store
  for Claude Code:
  - Per-project SQLite store at `.stele/decisions.db`.
  - MCP server registering four tools — `decision_capture`,
    `decision_resume`, `decision_trace`, `decision_resolve`.
  - Browser UI via `stele serve` (resume digest, decision detail,
    full capture form, edge operations).
  - `stele init` bootstraps `.stele/` + `.mcp.json` + per-project
    daemon + Stop hook + stele-capture skill in one command.
  - Per-project always-on daemon via launchd (macOS) or systemd
    (Linux user units).
  - CLI subcommands: `init`, `serve`, `daemon`, `hooks`, `resume`,
    `trace`, `trace-entity`, `list`, `seed`, `add`, `resolve`,
    `relate`.

### Infrastructure
- Distributed as `stele-mcp` on npm with two PATH bins (`stele`,
  `stele-mcp`).
- TypeScript source-of-truth, transpiled to `dist/` via `tsc` +
  `scripts/build.mjs` (required because Node 22 refuses to type-strip
  `.ts` files inside `node_modules/`).
- Shebangs use `#!/usr/bin/env -S node --no-warnings` to suppress
  the SQLite experimental warning end-users would otherwise see on
  every invocation.

## Pre-public history

Internal iterations before the first npm publish are kept in git but
not numbered here — that history covered project-based store layout,
the browser UI, and always-on integration. The first public release
**reset to `0.0.1-snapshot`** to honour SemVer's "public API not yet
stable" semantics; internal version numbers like `0.5.0` referred to
iteration count, not API maturity.
