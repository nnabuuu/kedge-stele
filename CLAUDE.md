# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**实录 / Stele** — a local decision-provenance store distributed as an npm package (`stele-mcp`). Primary client is Claude Code via a stdio MCP server; a CLI is a secondary adapter onto the same store. Runtime is Node ≥22.6 running TypeScript directly via `--experimental-strip-types`. Storage is SQLite via `node:sqlite`. The only non-stdlib deps are `@modelcontextprotocol/sdk` and `zod` (for the MCP adapter). End-user install is `npm install -g stele-mcp` → bins `stele` and `stele-mcp` on PATH; the `bin/*.js` wrappers re-exec Node on `src/*.ts` with the type-strip flags so the package works on any Node ≥22.6 and on Windows (npm bin shims don't read shebang flags).

## Commands

All scripts inject the `--experimental-strip-types --no-warnings` flag via the `_node` alias — call them through `npm run` rather than `node src/*.ts` directly, or you'll hit `ERR_UNKNOWN_FILE_EXTENSION` on Node <23.6.

```bash
npm install                                       # ~92 transitive packages, 2 real deps
npm run _node -- src/cli.ts init                  # bootstrap a .stele/ in this repo for local testing
npm run mcp                                       # start the MCP server (stdio)
npm run seed -- sample-report.html                # cold-start: ingest a feature-report HTML
npm run list                                      # raw dump of every node by status
npm run resume                                    # "什么在等我" — open + un-resolved deferred
npm run resume -- --html out.html                 # same, as styled HTML
npm run trace -- D-04                             # node + its graph neighbourhood
npm run _node -- src/cli.ts trace-entity file path/to/file.ts
npm run resolve -- D-NEW DEF-OLD "manual note"    # cross-session stitch (flips DEF-OLD to resolved)
npm run relate  -- D-A D-B "note"                 # non-destructive link
echo '<CapturePayload-json>' | npm run add        # same as MCP decision_capture

# When testing the installed-bin distribution flow from this checkout:
npm install -g .                                  # puts `stele` and `stele-mcp` on PATH, pointing at src/
```

No build step, no test suite. There is no linter wired up. Verify changes by running the acceptance scenario in DEVELOPING.md (seed → add → resume → trace → trace-entity).

## Architecture

### The atom is a decision node, not a report

`src/types.ts` is the source of truth for the model. The store holds a graph: nodes are `Decision` records with a discriminated `Status` (`open` / `decided` / `deferred` / `superseded` / `resolved` / `conflicted`), edges are typed (`resolves` / `supersedes` / `reconciles` / `relates`). Every report, backlog, or resume digest is a **projection** (live query) over this graph — never a frozen snapshot. This is the load-bearing invariant: adding a `resolves` edge today retroactively updates how a three-week-old report renders, because the report re-queries the live node.

Status flips happen inside `Store.addEdge` (`src/store.ts`): a `resolves` edge mutates the target's status to `{kind:"resolved", by}`; `supersedes` does the same for `superseded`. Projections rely on this — don't bypass `addEdge` to write edges directly.

### Module layout (everything is headless except the two adapters)

- `src/types.ts` — schema. If you change `Status` or `EdgeKind`, the Zod schemas in `mcp.ts` must be updated in lockstep.
- `src/store.ts` — SQLite-backed graph. Owns three tables (`decisions`, `edges`, `affects`) and answers entity-anchored queries (`decisionsAffecting`) without any ontology — it keeps its own reverse index.
- `src/projections.ts` — read-only views: `resumeDigest` (what's waiting), `trace` (node neighbourhood), `traceEntity` (everything touching a file/feature/skill). These return plain data; formatting lives in the adapters.
- `src/consolidate.ts` — on capture, proposes `resolves` / `relates` edges against every still-pending node via token-jaccard + shared-entity heuristic. This is the "Evaluator agent's seat" — the human (via `decision_resolve`) confirms.
- `src/render.ts` — HTML rendering for the resume digest (self-contained CSS, no framework).
- `src/seed.ts` — HTML feature-report → decision graph parser. Used only for cold-start; not part of the runtime path.
- `src/resolver.ts` — `EntityResolver` interface. `stubResolver` returns bare `kind:id` labels. This is the **only** coupling point to an external ontology; swapping it is how the tool would light up across a real entity model.
- `src/paths.ts` — single source of truth for the DB path. Project-based: walks up from cwd looking for a `.stele/` marker directory (stopping at `$HOME` to avoid silently picking up a stale global store). If no marker is found, throws `SteleNotInitializedError` — both `cli.ts` and `mcp.ts` catch it and print a hint pointing the user at `stele init`. No auto-create (deliberate footgun-avoidance for the distributed binary). `STELE_DB` (or legacy `PROV_DB`) overrides everything. Never hardcode another path.
- `src/cli.ts` — CLI adapter. Writes to stdout freely. Owns the `init` subcommand: creates `.stele/`, writes `.stele/README.md`, appends `.stele/` to project `.gitignore`, and merges a `stele` entry into the project's `.mcp.json` (preserving any other MCP servers already configured).
- `src/mcp.ts` — stdio MCP server. Registers four tools: `decision_capture`, `decision_resume`, `decision_trace`, `decision_resolve`. Catches `SteleNotInitializedError` at startup and exits 1 with a stderr hint, so Claude Code surfaces the "run stele init" message instead of a silent crash.
- `bin/stele.js`, `bin/stele-mcp.js` — JS wrappers npm publishes as the `stele` and `stele-mcp` PATH bins. Each re-execs Node with `--experimental-strip-types --no-warnings` against the corresponding `src/*.ts` and inherits stdio. Edits to `src/` are picked up without rebuilding.

### MCP server stdio discipline

`src/mcp.ts` is a JSON-RPC server over stdio. **stdout is reserved for the MCP framing** — any stray `console.log` corrupts the protocol and the client hangs with no error. All informational output goes to `stderr` (use `console.error` or `process.stderr.write`). Only `cli.ts` is allowed to write to stdout. If you add diagnostics to any module that `mcp.ts` imports, route them to stderr.

### Deferred-but-on-purpose

Two things are stored but not active, by design:
- **IntentDelta** (`status.delta` / `status.draftDelta`) is persisted but never folded into an effective bundle and never conflict-checked. That needs a bundle layer the POC omits. Don't add fold/conflict logic without that layer.
- **EntityResolver** is a stub. Replace `stubResolver` with a real resolver if you want hydrated labels; do not move ontology knowledge into `store.ts` or `projections.ts`.

### Slash command

`.claude/commands/decision.md` is the `/decision` slash command. It drives the MCP tools (not the CLI) and instructs the agent to draft a full `CapturePayload` from conversation context — the user does not fill fields. If you change the `Decision` schema in `types.ts`, also update the field-by-field instructions in this command file.

## Conventions specific to this repo

- **No build step, no transpile.** TypeScript runs directly. Imports must use `.ts` extensions (`import { Store } from "./store.ts"`) — this is required for `--experimental-strip-types`.
- **`revisitWhen` on a deferred decision must be a structured `Trigger`** (`metric` / `event` / `dependency` / `manual`), never free text. The resume layer relies on the discriminant to flag "needs check" — a free-text trigger is invisible to it forever.
- **`delta` is optional and rare.** Only decisions that modify an intent bundle carry it. Pure code/tooling decisions leave it off; their changes are captured in `affects` + `artifacts`.
- **Decision ids follow a convention by status kind:** `D-NN` for decided, `DEF-NN` for deferred, `OQ-NN` for open. The seed parser (`seed.ts`) relies on this when extracting cross-references from prose.
- **Sandbox DBs.** `.stele/` and the legacy `prov.db` are gitignored. By default each project gets its own `.stele/decisions.db`; use `STELE_DB="$PWD/sandbox.db"` for ad-hoc experiments that shouldn't touch the project store.
- **Schema migrations are nonexistent on purpose.** `Store`'s `CREATE TABLE IF NOT EXISTS` runs on every connect. Adding a column is fine (existing rows get NULL); renaming/dropping is a breaking change with no migration path — don't do it without one.
