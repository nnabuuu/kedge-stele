# Developing Stele

For end-user install / use, see [README.md](./README.md). This file is
for contributors running stele from source or making changes.

---

## Prerequisites

- **Node ≥ 22.6** — TypeScript runs directly via `--experimental-strip-types`.
  Default-on at 23.6+, but the package always passes the flag so any 22.6+ works.
- That's it. No Python, no Docker, no DB server. SQLite is via `node:sqlite`.
  Two real npm deps: `@modelcontextprotocol/sdk` and `zod` for the MCP adapter.

## Layout

```
src/             core TypeScript source (store, projections, consolidate, render, seed, resolver, paths, types)
src/cli.ts       CLI subcommands: `stele init`, `serve`, `daemon`, `hooks`, `projects`, `features`, `sessions`, `tags`, `config`
src/mcp.ts       stdio MCP server (per-project; Claude Code is per-session). 22 tools as of 0.5.0.
src/serve.ts     HTTP server — single-project default + `--multi` tenant dispatch
src/schemas.ts   Zod schemas shared by mcp.ts and serve.ts
src/tags.ts      0.0.7+: tag policy engine — single chokepoint for `auto` / `propose` / `locked`
src/daemon.ts    launchd (macOS) / systemd (Linux) installer for the single multi-tenant daemon
src/hooks.ts     installer for the Stop hook + stele-capture skill
src/registry.ts  global project registry at ~/.stele/registry.json — slug ↔ path mapping
src/templates/   source-of-truth for installed templates (decision-command.md, skill, hook)
dist/            build output (gitignored) — `npm run build` produces this; the npm package ships dist/, not src/
web/             single-page web UI — index.html / styles.css / app.js (vanilla)
tsconfig.json    tsc config (rewriteRelativeImportExtensions, target ES2022)
.claude/commands/decision.md   the /decision slash command (reference copy of the template)
sample-report.html             seed fixture for the cold-start acceptance scenario
```

## Tests

`npm test` runs the node:test suite over `src/**/*.test.ts`. Zero
dependencies (node 22's built-in runner + assert). Tests are excluded
from the published tarball (via `files` in package.json and the tsconfig
exclude).

Coverage focus is on regression-prone seams: `registry.ts` (slugify +
collision suffix), `schemas.ts` (the structured-trigger contract; the
0.0.1 hook schema bug shape), `hooks.ts` (settings.json merge — both
the fresh-install correct shape and the heal-from-broken-0.0.1 path).

Currently un-covered (planned for follow-ups):
- `serve.ts` HTTP roundtrips (single + multi-tenant routing)
- `daemon.ts` install / uninstall (subprocess + launchd, hard to assert)
- `web/app.js` (would need jsdom)

## Build

The npm package ships **transpiled JavaScript**, not TypeScript source.
This is required because Node ≥22 refuses to type-strip `.ts` files under
`node_modules/` (security policy), and any `npm install`'d package lives
in node_modules.

```bash
npm run build
```

does three things:

1. `tsc` — transpiles `src/*.ts` → `dist/*.js`, rewriting `.ts` import
   extensions to `.js` via `rewriteRelativeImportExtensions: true`
2. Copies `src/templates/` → `dist/templates/` (tsc doesn't carry
   non-TS files; `hooks.ts` resolves the templates dir via
   `import.meta.url`, so the relative layout matters)
3. `chmod +x dist/cli.js dist/mcp.js` (shebangs need exec permission)

`prepublishOnly` runs `build` automatically before `npm publish`, so you
don't have to remember to rebuild.

Dev work continues to run TypeScript directly via the `npm run` scripts —
no build needed for editing, only for shipping.

## Run from source

Clone the repo, install deps, and use the `npm run` scripts — they inject
the `--experimental-strip-types --no-warnings` flag for you. To exercise
the store you still need a `.stele/` somewhere — either `stele init` in
the kedge-stele repo itself, or run against an existing project's store
via `STELE_DB`.

```bash
git clone <repo-url> stele && cd stele
npm install
npm run _node -- src/cli.ts init      # bootstraps a .stele/ here
npm run resume                        # smoke — expect "0 个未闭合回路"
npm run seed -- sample-report.html    # optional: cold-start with sample data
npm run list                          # expect 14 decisions, mixed status
```

The npm scripts mirror the installed-bin subcommands:

```bash
npm run resume                                  # what's waiting
npm run resume -- --html ~/Desktop/resume.html  # visual digest
npm run trace -- D-04
npm run _node -- src/cli.ts trace-entity file path/to/file.ts
npm run resolve -- D-99 DEF-02 "optional note"
npm run relate -- D-A D-B "they reference the same constraint"
npm run mcp                                     # start the MCP server on stdio
echo '<payload-json>' | npm run add             # same as decision_capture
```

## Run the installed bins against the source

After `npm install -g .` from inside this repo, `stele` and `stele-mcp`
are on your PATH, pointing at this checkout via the bin wrappers in `bin/`.
Edits to `src/*.ts` are picked up immediately — the wrappers re-exec Node
on the .ts files each invocation, no rebuild step.

## Architecture overview

The atom is a `Decision` node, not a feature report. The store is a typed
graph: nodes have a discriminated `Status` (`open` / `decided` / `deferred`
/ `superseded` / `resolved` / `conflicted`), edges are typed
(`resolves` / `supersedes` / `reconciles` / `relates`). Reports, backlog,
and resume digests are all **projections** — live queries over the graph,
never frozen snapshots.

Key invariant: `Store.addEdge` flips status on `resolves` / `supersedes`
edges (target becomes `resolved` / `superseded`). Don't write edges by
any other path; projections rely on this side effect.

Module roles:
- `src/types.ts` — the schema. Source of truth.
- `src/store.ts` — SQLite-backed graph; three tables (`decisions`, `edges`,
  `affects`). Owns its own reverse index, doesn't need an ontology.
- `src/projections.ts` — `resumeDigest`, `trace`, `traceEntity`. Plain data
  out; formatting lives in the adapters.
- `src/consolidate.ts` — on capture, proposes `resolves` / `relates` edges
  via token-jaccard + shared-entity heuristic.
- `src/render.ts` — HTML rendering for the resume digest (self-contained CSS).
- `src/seed.ts` — HTML feature-report → decision graph parser. Cold-start
  only, not part of the runtime path.
- `src/resolver.ts` — `EntityResolver` interface; `stubResolver` returns
  bare `kind:id`. The only coupling point to an external ontology.
- `src/paths.ts` — single source of truth for the DB path. Walks up from
  cwd for a `.stele/` marker, stops at `$HOME`.
- `src/cli.ts` — CLI adapter. Free to write stdout.
- `src/mcp.ts` — stdio MCP server. **stdout reserved for JSON-RPC framing**
  — any stray `console.log` corrupts the protocol and the client hangs.

**Zod schemas live in `src/schemas.ts`** and are shared by `mcp.ts`
(MCP tool inputs) and `serve.ts` (HTTP POST bodies). If you change
`Status` or `EdgeKind` in `types.ts`, update `schemas.ts` in the same
commit — both adapters validate against the same shape, so a drift is
silently wrong. The capture form in `web/app.js` (`viewNew`) also
hand-builds payloads to this shape; it has to move in lockstep too.

## Web UI

`stele serve` runs an HTTP server (`src/serve.ts`) over the same store
as the CLI/MCP. localhost-only by default; bind elsewhere with `--host`.

### API contract

| Method | Route | Body / params | Returns |
|---|---|---|---|
| GET | `/` | — | HTML shell (serves `web/index.html`) |
| GET | `/assets/styles.css` | — | static |
| GET | `/assets/app.js` | — | static |
| GET | `/<other>` | — | SPA fallback → `web/index.html` (so deep links like `/decisions/D-04` work) |
| GET | `/api/resume` | — | `WaitingItem[]` (shape: `projections.ts:WaitingItem`) |
| GET | `/api/decisions` | — | `Decision[]` |
| GET | `/api/decisions/:id` | — | `Trace` (`projections.ts:Trace`) — decision + edges + affects |
| GET | `/api/entity/:kind/:id` | — | `{ ref: EntityRef, traces: Trace[] }` |
| GET | `/api/next-id` | `?prefix=D\|DEF\|OQ` | `"D-NN"` string |
| POST | `/api/decisions` | `CapturePayload` (`schemas.ts`) | `{ id, applied, proposed: EdgeCandidate[] }` |
| POST | `/api/edges` | `Edge` (`schemas.ts`) | `{ ok: true, edge }` |

Validation failures return `400` with `{ error, details }` where
`details` is the Zod issue array. Missing edge endpoints (POST
`/api/edges` with a non-existent `from` / `to`) also return `400`.

### Frontend

`web/app.js` is vanilla JS (no React/Vue/Svelte, no build step). Structure:

- `apiGet` / `apiPost` — thin fetch wrappers
- `h(tag, attrs, ...kids)` — DOM element helper
- A small history-API router (`route(pattern, fn, opts)` / `navigate(path)`)
- View renderers: `viewResume` / `viewAllDecisions` / `viewDecision` /
  `viewEntity` / `viewNew`
- Edge-picker modal (`buildEdgeModal`, `buildResolveByModal`)
- Search overlay (`/` shortcut)
- Capture form (`viewNew`) — the heaviest single piece

`web/styles.css` design tokens (color, font, card styles) are lifted
directly from `src/render.ts` so the browser UI and the `--html` export
look like a family. If you change one, change the other.

### Capture-form / schema sync

The form in `viewNew` (`web/app.js`) hand-builds a `CapturePayload`. If
you add or rename a Decision field in `types.ts` + `schemas.ts`, also:

1. Add the input in the relevant section of `viewNew`
2. Map it in `buildDecision()` so the POST body has the right shape

The server rejects unknown payloads via Zod, so a missed update fails
loudly at submit time — but invest the time to keep them in step.

## Acceptance scenario

End-to-end check the project promises. Run with the installed `stele` bin
(or substitute `npm run …` equivalents):

```bash
stele init                                # create .stele/ here
stele seed sample-report.html             # ingest 14 decisions
stele list                                # mixed status — decided/deferred/open
echo '{"decision":{...,"id":"D-NEW",...},"edges":[{"from":"D-NEW","to":"DEF-02","kind":"resolves"}]}' \
  | stele add                             # capture a new decision that resolves an old deferred
stele resume                              # DEF-02 should be gone (resolved by D-NEW)
stele trace DEF-02                        # full arc: raised → deferred → resolved-by D-NEW
stele trace-entity file path/to/the-file.ts   # pulls cross-session decisions
```

## Migrating from earlier versions

### From 0.0.7 → 0.1.0

The Decision shape, Edge field name, and id format all change in 0.1.0. **The
old DB is NOT auto-translated.** On first open, the store detects the
pre-0.1.0 schema (via the `decisions.status_kind` column) and renames the
file aside to `.stele/decisions.0.0.x.db`, then creates a fresh 0.1.0
database in its place. The MCP server and CLI print a one-time hint pointing
at the backup.

If you need rows from the backup, query it directly with `sqlite3`:

```bash
sqlite3 .stele/decisions.0.0.x.db "SELECT id, title FROM decisions"
```

The `/decision` and `/milestone-report` flows are the intended new write
path; bulk import from old data isn't a 0.1.0 feature.

### Earlier (pre-0.0.3) layouts

The old global `~/.stele/decisions.db` is no longer auto-detected from a
project subdirectory. To move data into a specific project:

```bash
mkdir -p /path/to/project/.stele
mv ~/.stele/decisions.db /path/to/project/.stele/decisions.db
rmdir ~/.stele   # if now empty
```

The legacy provenance-poc location (`~/.provenance/decisions.db`) is
analogous. `STELE_DB` and the legacy `PROV_DB` env vars are both still
honoured as overrides.

## Testing changes

There's no test suite (yet). Verify with the acceptance scenario above
plus targeted manual checks:

- **paths.ts**: walk-up from a subdirectory finds the marker at the project
  root; `$HOME` boundary prevents `~/.stele/` leaking into projects under
  home; `STELE_DB` overrides everything.
- **mcp.ts**: stderr-only logging. Pipe an MCP `initialize` request via
  stdin and confirm the first stdout line is valid JSON-RPC. A stray
  `console.log` will break this immediately.
- **cli.ts `init`**: refuses if `.stele/` exists; merges into an existing
  `.mcp.json` without clobbering other servers; appends `.stele/` to
  `.gitignore` only if missing.

## Publishing to npm

```bash
npm version <major|minor|patch>           # bumps version + creates a tag
npm publish                               # publishes the bin entry to npm
git push --follow-tags
```

The `files` field in `package.json` controls what ships: `src/`, `bin/`,
docs. `node_modules/`, `.stele/`, fixture DBs are excluded.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ERR_UNKNOWN_FILE_EXTENSION: '.ts'` when running `node src/cli.ts ...` directly | Node <23.6 doesn't strip types by default | Use `npm run <cmd>` (or the installed `stele` bin); both inject the flag |
| Claude Code can't find the MCP tools | `.mcp.json` missing, wrong cwd, or Claude Code not restarted | `stele init` writes `.mcp.json`; verify it's in the project root and restart Claude Code |
| MCP tool calls hang with no response | Something is writing to stdout — pollutes JSON-RPC frames | Look for stray `console.log` in `src/*` (should all be `console.error`); only `cli.ts` is allowed stdout |
| `no stele store found` | Cwd has no `.stele/` and no ancestor up to `$HOME` does either | `stele init` in your project root, or set `STELE_DB` |
| `unable to open database file` | `STELE_DB` points to a path whose parent doesn't exist | `mkdir -p` the parent, or unset `STELE_DB` |
| New `.stele/` appearing in an unexpected directory (older versions) | Auto-create from pre-0.3 builds | Upgrade to ≥0.3; the new behaviour errors instead of silently creating |
| `launchctl bootstrap` says "Bootstrap failed: 5: Input/output error" | A previous version of the same Label is still loaded, or the plist is malformed | `launchctl bootout gui/$UID/com.stele.<hash>` then retry; check `~/Library/LaunchAgents/com.stele.<hash>.plist` parses with `plutil -lint` |
| Daemon installed (`loaded: yes`) but `curl localhost:PORT` fails | The launchd-spawned `node` couldn't find a runtime (asdf/nvm shim resolution) | Verify the plist `ProgramArguments[0]` is an **absolute** node path — `stele daemon install` resolves `process.execPath` for exactly this reason; if you edited the plist by hand, re-run install |
| `systemctl --user enable` fails with "Failed to connect to bus" | No user systemd session (often the case under `ssh` without `--user-keep-env`) | Run `loginctl enable-linger $USER` (one-time, sudo); or run the daemon foreground via `stele serve` |
| Hook installed but no `additionalContext` fires in Claude | The regex didn't match Claude's response, or the project's `.claude/settings.json` got malformed | Run the hook by hand: `echo '{"response_text":"we decided to X"}' \| .claude/hooks/stele-stop.sh` — should emit JSON with `additionalContext`. Set `STELE_HOOK_DEBUG=1` for matched-signal stderr |
| Skill never activates even after the hook fires | Claude's semantic matcher doesn't see the right keywords | The hook's reminder text and the skill's `description` must share keywords (stele / capture / decision / crystallize). Check both haven't drifted from their templates |

## Reference

- Brand & naming: [naming-stele.md](./naming-stele.md)
- Design rationale: [ProductDesign.md](./ProductDesign.md)
- End-user docs: [README.md](./README.md)
- Slash command behaviour: [.claude/commands/decision.md](./.claude/commands/decision.md)
- Type schema (the source of truth for the store): [src/types.ts](./src/types.ts)
