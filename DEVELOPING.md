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
src/         core (store, projections, consolidate, render, seed, resolver, paths, types)
src/cli.ts   CLI subcommands incl. `stele init`
src/mcp.ts   stdio MCP server
bin/         JS wrappers that npm publishes as `stele` and `stele-mcp` bins
.claude/commands/decision.md   the /decision slash command (reference copy)
sample-report.html             seed fixture for the cold-start acceptance scenario
```

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

The Zod schemas in `mcp.ts` mirror `types.ts`. If you change `Status` or
`EdgeKind`, both must move in lockstep.

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

## Reference

- Brand & naming: [naming-stele.md](./naming-stele.md)
- Design rationale: [ProductDesign.md](./ProductDesign.md)
- End-user docs: [README.md](./README.md)
- Slash command behaviour: [.claude/commands/decision.md](./.claude/commands/decision.md)
- Type schema (the source of truth for the store): [src/types.ts](./src/types.ts)
