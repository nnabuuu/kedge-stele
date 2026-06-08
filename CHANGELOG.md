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
