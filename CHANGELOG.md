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
