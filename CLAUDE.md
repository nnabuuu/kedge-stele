# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**实录 / Stele** — a local decision-provenance store distributed as an npm package (`stele-mcp`). Primary client is Claude Code via a stdio MCP server; a CLI is a secondary adapter onto the same store. Storage is SQLite via `node:sqlite`. The only non-stdlib deps are `@modelcontextprotocol/sdk` and `zod` (for the MCP adapter). **The dev loop and the distributed artifact run TypeScript differently** — see § Build & run model below. In dev, `npm run` scripts execute `src/*.ts` directly via `--experimental-strip-types` (no build). The published/installed package runs a **`tsc`-compiled `dist/`**: `npm install -g stele-mcp` puts `stele` and `stele-mcp` on PATH pointing at `dist/cli.js` / `dist/mcp.js` (plain compiled JS, shebang `node --no-warnings`), built by the `prepare` hook on install. Engines still pin Node ≥22.6 (for `node:sqlite`). The `design/` folder is canonical — backend spec at `design/Stele Backend Design.md`, UI mocks at `design/*.html`. See § Project ambition and § Frontend canonical reference below.

## Project ambition / quality bar

Stele is the user's flagship — not a casual MCP utility. Treat every patch as something they would want to ship publicly, not a sketch. The bar for "done" is set by `design/Stele Backend Design.md` (backend) and the six page mocks under `design/*.html` (frontend); current code lags both in places, but where it lags it's because we **chose** to defer, not because we missed it — see § Backend gaps from the design spec.

When a change has a choice between "ship it tactically right now" and "bring it closer to the canonical design," pick closer-to-canonical unless the user explicitly says otherwise. When in doubt about naming, typography, tone, or visual identity, defer to the design folder, not to historical code or your own taste.

## Commands

All scripts inject the `--experimental-strip-types --no-warnings` flag via the `_node` alias — call them through `npm run` rather than `node src/*.ts` directly, or you'll hit `ERR_UNKNOWN_FILE_EXTENSION` on Node <23.6.

```bash
npm install                                       # ~92 transitive packages, 2 real deps
npm run _node -- src/cli.ts init --skip-daemon --skip-hooks  # local-test init (skip system installs)
npm run _node -- src/cli.ts hooks status          # see whether hooks are installed in this repo
npm run _node -- src/cli.ts daemon status         # see whether the launchd/systemd daemon is loaded
npm run _node -- src/cli.ts serve                 # launch browser UI at http://127.0.0.1:3939
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

npm run build                                     # tsc src/ → dist/ + copy templates + chmod bins
# When testing the installed-bin distribution flow from this checkout:
npm install -g .                                  # runs `prepare` (build) → bins point at dist/cli.js, dist/mcp.js
```

### Build & run model — dev runs `src/`, the installed package runs `dist/`

There **is** a build step (this was once true and the doc lagged — it isn't anymore). Two distinct runtime paths, and conflating them will burn you:

- **Dev loop (no build):** `npm test`, `npm run _node -- src/cli.ts …`, `npm run mcp` all execute `src/*.ts` directly through the `_node` alias (`node --experimental-strip-types --no-warnings`). Edits to `src/` are live here with no rebuild.
- **Installed / published artifact (built):** `package.json` `bin` maps `stele` → `dist/cli.js` and `stele-mcp` → `dist/mcp.js`. These are **`tsc`-compiled plain JS** (no strip-types at runtime; shebang is `node --no-warnings`). `npm run build` (`scripts/build.mjs`) wipes `dist/`, runs `tsc` (type errors are non-blocking as long as `cli.js`+`mcp.js` emit — `noEmitOnError:false`), copies `src/templates` → `dist/templates`, and chmods the two bins. `prepare` + `prepublishOnly` both run it, so `npm install`/`npm install -g .`/`npm publish` all rebuild `dist/`. `dist/` is **gitignored**.
- **Consequence (the load-bearing one):** the global `stele`/`stele-mcp` and the **always-on daemon** run `dist/`, not `src/`. A `src/` edit does **not** reach the installed CLI, the MCP bin, or the daemon until you `npm run build` (and restart the daemon). When you change daemon/serve/CLI behaviour and want to see it live, the loop is: `npm run build` → `launchctl kickstart -k gui/$(id -u)/com.stele.daemon` (macOS). `dist/serve.js` resolves `webDir` as `dist/../web`, i.e. the checkout's `web/` — so static-asset edits are picked up per request once the rebuilt daemon is running (assets are read from disk per request, not cached at boot).

There is no linter wired up. `npm test` runs the full `node:test` suite (220+ tests across acceptance, capture, projections, schemas, serve, hooks, store, migration). Verify changes by running tests + `npx tsc --noEmit` + a smoke run of `npm run _node -- src/cli.ts serve --multi --port <N>`.

## Architecture

### The atom is a decision node, not a report

`src/types.ts` is the source of truth for the model. The store holds a graph: nodes are `Decision` records carrying a split discriminant (`type ∈ {decision, deferred, open}` × `status ∈ {null, open, resolved}` × optional `resolvedBy` / `supersededBy`); a derived `nodeState ∈ {decided, deferred, superseded, resolved, open, conflicted}` rolls the columns into the UI label. Edges are typed (`resolves` / `supersedes` / `reconciles` / `relates` / `depends_on`). Every report, backlog, or resume digest is a **projection** (live query) over this graph — never a frozen snapshot. This is the load-bearing invariant: adding a `resolves` edge today retroactively updates how a three-week-old report renders, because the report re-queries the live node.

Status flips happen inside `Store.addEdge` (`src/store.ts`): a `resolves` edge mutates the target's `status` to `'resolved'` and stamps `resolvedBy`; `supersedes` flips `supersededBy` on the source's target. Projections rely on this — don't bypass `addEdge` to write edges directly.

### Module layout (everything is headless except the two adapters)

- `src/types.ts` — schema source of truth. `Project`, `Feature`, `Session`, `Decision`, `Edge`, `CapturePayload`, plus `Tag` / `Tagging` / `TagProposal` / `TagPolicy`. `Decision` is the split shape: `type` + `status` + `resolvedBy` + `supersededBy` + rich `detail`. **0.4.0 additions on `Decision`**: `source: DecisionSource` (`'manual' | 'agent-live' | 'session-extract'`; default `'manual'` on legacy rows), optional `confidence: 0..1`, and `dedupKey: string` (sha256 of `featureId|normalize(title)|sort(affects)`, 16 hex chars — the load-bearing cross-layer dedup constraint). `Edge` uses `relation` (not `kind`); five values incl `depends_on`. Feature state is 5-state (`draft/going/winding/done/paused`) and carries a rolling `summary` field that `/stele:feature` rewrites on each pass. The legacy `SessionOutcome` / `PauseReason` / `FeatureReportDraft` / `ResumeCommandResult` types remain in the file for one release so existing rows decode — the agent-facing path no longer emits them. If you change any enum or any of the entity shapes, `src/schemas.ts` (Zod) AND `web/pages/*.js` must be updated in lockstep.
- `src/schemas.ts` — Zod schemas mirroring `types.ts`. Imported by both `mcp.ts` (MCP tool input validation) and `serve.ts` (HTTP POST validation) so the two adapters can't drift.
- `src/store.ts` — SQLite-backed graph. Owns 10 tables: `projects`, `features`, `sessions`, `decisions`, `edges`, `affects`, `tags`, `taggings`, `tag_proposals`, `config`. Answers entity-anchored queries (`decisionsAffecting`) without any ontology. 0.3.0 changes: the umbrella `features` table dropped (the old "Feature" entity is gone), the old `milestones` table is the new `features` table (id prefix `F-NN`, carries `state` + `about` + `summary` + `sequenceAfter` + `started_at` / `completed_at`); `decisions.feature_id` (was `milestone_id`); `taggings.target_kind ∈ {feature, decision}` (was `milestone | decision`). **Pre-0.3.0 databases are NOT auto-migrated**: the constructor detects either the legacy `decisions.status_kind` column (pre-0.1.0 shape) OR an `features` table missing the `state` column (0.1–0.2 umbrella shape) and renames the file aside to `<path>.0.2.x.db` before creating a fresh 0.3.0 schema. `migratedFromLegacy` is set so the CLI / MCP can print a one-time hint. Session dedup is still `UNIQUE(source, source_sess_id)`; tag-name dedup is still `UNIQUE COLLATE NOCASE`. WAL is set in the constructor.
- `src/tags.ts` — tag policy engine. `ensureTag(store, name, ctx)` is the single chokepoint: if the name already exists active, it's reused; otherwise the local `tag_policy` config (`auto` / `propose` / `locked`) decides whether the agent gets to create it, queue a proposal, or be blocked. Called by `decision_capture`, by `tag_propose` (MCP / CLI / HTTP), and by `applyCaptureTags` (the batch wrapper). The only module allowed to enforce policy — `store.ts` is policy-blind.
- `src/capture.ts` — feature + session resolution for `decision_capture`. First session on a 'draft' feature auto-advances state to 'going'; other state transitions (`going → winding → done`) happen manually via the dashboard or `stele features set-state`. `recordSessionStart` / `recordSessionEnd` remain exported for legacy callers but the agent-facing surface no longer uses them (0.3.0 retired `session_start` / `session_end` MCP tools).
- `src/projections.ts` — read-only views: `resumeDigest` (what's waiting), `trace` (node neighbourhood), `traceEntity` (everything touching a file/feature/skill), `featuresList` (flat per-project feature list with tags + counts; replaced the 0.2.x `featureRail`), `featureDecisions` (all decisions on a feature across every session; the data behind `/stele:feature` step 2). These return plain data; formatting lives in the adapters.
- `src/consolidate.ts` — on capture, proposes `resolves` / `relates` edges against every still-pending node via token-jaccard + shared-entity heuristic. This is the "Evaluator agent's seat" — the human (via `decision_resolve`) confirms.
- `src/render.ts` — HTML rendering for the resume digest (self-contained CSS, no framework).
- `src/seed.ts` — HTML feature-report → decision graph parser. Used only for cold-start; not part of the runtime path.
- `src/resolver.ts` — `EntityResolver` interface. `stubResolver` returns bare `kind:id` labels. This is the **only** coupling point to an external ontology; swapping it is how the tool would light up across a real entity model.
- `src/paths.ts` — single source of truth for the DB path. Project-based: walks up from cwd looking for a `.stele/` marker directory (stopping at `$HOME` to avoid silently picking up a stale global store). If no marker is found, throws `SteleNotInitializedError` — both `cli.ts` and `mcp.ts` catch it and print a hint pointing the user at `stele init`. No auto-create (deliberate footgun-avoidance for the distributed binary). `STELE_DB` (or legacy `PROV_DB`) overrides everything. Never hardcode another path.
- `src/cli.ts` — CLI adapter. Writes to stdout freely. Owns four storeless subcommands (`init`, `hooks`, `daemon`, `serve`) plus all data-touching ones. `init` is the bootstrap entry: creates `.stele/`, writes `.mcp.json` + `.gitignore`, then by default also installs hooks (via `src/hooks.ts`) and a daemon (via `src/daemon.ts`). `--skip-daemon` / `--skip-hooks` are opt-outs.
- `src/hooks.ts` — installer for the write-path integration. Writes `.claude/hooks/stele-stop.sh`, the `.claude/skills/stele-capture/` skill folder, `.claude/commands/stele/feature.md` (the namespaced `/stele:feature` slash command), and merges a Stop hook entry into `.claude/settings.json` preserving any other configured hooks. Re-running install on a 0.2.x-era project **deletes** any leftover `.claude/commands/{decision,milestone-report,resume}.md` so the retired commands don't linger. All artifacts read from `src/templates/`.
- `src/daemon.ts` — launchd (macOS) / systemd user (Linux) installer for the **single multi-tenant daemon** (`com.stele.daemon` / `stele-daemon.service`). Writes the unit file with **absolute `node` + script path** (from `process.execPath` and `process.argv[1]`), so launchd/systemd don't need a working PATH. `install` first sweeps any legacy per-project plists (`com.stele.<hash>` from 0.0.2-), bootouts them, reads their WorkingDirectory and registers the projects into `~/.stele/registry.json` so no decisions go missing.
- `src/templates/` — source-of-truth for everything `stele init` / `stele hooks install` writes into a project. **One** slash command file: `stele-feature-command.md` (installed at `.claude/commands/stele/feature.md` → `/stele:feature`). The `stele-capture` skill is a **folder** (per Anthropic's progressive-disclosure pattern, [link](https://claude.com/blog/lessons-from-building-claude-code-how-we-use-skills)): `stele-capture-skill/SKILL.md` is the entry point with overview + when_to_use + 4-step checklist + pointers; `stele-capture-skill/gotchas.md` holds the concrete traps; `stele-capture-skill/references/{decision-schema,feature-judgment,tag-judgment}.md` hold field-level detail loaded on demand. `stele-stop-hook.sh` (bash regex detector — shells out to `stele features list --state going --json`, `stele config get tag_policy`, and `stele tags list --json` to inject active context). Changing project-installed content means changing here. `hooks.ts` writes the slash command file only if missing (no overwriting user edits) but always replaces the skill folder wholesale (no stale references files surviving a version bump).
- `src/mcp.ts` — stdio MCP server. As of 0.3.0 registers **19 tools** (down from 22): four capture-path tools (`decision_capture` / `decision_resume` / `decision_trace` / `decision_resolve`), five feature tools (`feature_open` / `feature_list` / `feature_report` / `feature_decisions` / `feature_set_summary`), eight tag tools (`tag_propose` / `tag_apply` / `tag_confirm` / `tag_reject` / `tag_recolor` / `tag_rename` / `tag_archive` / `tag_restore`), and two config tools (`config_get` / `config_set`). `decision_resolve` takes `relation` (not `kind`) and accepts `depends_on`. **0.3.0 retirements**: the umbrella `feature_open` / `feature_list` were removed (the umbrella entity is gone); `session_start` / `session_end` / `resume_command` were removed (sessions auto-bucket inside `decision_capture`; the resume concept folded into `/stele:feature`). Catches `SteleNotInitializedError` at startup; prints the legacy-DB migration hint via `store.migratedFromLegacy`.
- `src/serve.ts` — `node:http` server backing `stele serve`. Two modes: **single-project** (cwd's store, routes at `/api/*` — used by dev) and **multi-tenant** (`--multi`, reads `~/.stele/registry.json`, lazy-opens a `Store` per slug, routes at `/<slug>/api/*` plus `/api/projects` and `/`). The daemon always uses `--multi`. POST bodies validate via `src/schemas.ts`. localhost-only. 0.3.0 routes: `GET /api/features` (flat list with optional `state` filter; `?summary=1` returns the legacy `featureSummary` shape), `GET /api/features/:id`, `GET /api/features/:id/decisions` (the projection backing `/stele:feature` step 2), `POST /api/features/:id/summary` (the `/stele:feature` step 5 sink). The 0.2.x `POST /api/features` (umbrella open), `POST /api/sessions/start`, `POST /api/sessions/:id/end`, and `GET /api/feature-rail` endpoints are gone.
- `src/registry.ts` — global project registry at `~/.stele/registry.json`. `register(path)` is idempotent on path, generates a URL-safe slug from basename (collisions get `-2`/`-3` suffixes), saves atomically. `stele init` calls it; multi-tenant `serve` reads it; `daemon install` legacy-sweep populates it from old per-project plists.
- `web/` — single-page web UI; vanilla JS, no framework, no build. Slug-aware: `currentSlug` extracted from `location.pathname` first segment, `apiGet`/`apiPost` auto-prefix it, `slugUrl(path)` is used in href construction. Page modules in `web/pages/`: `projects.js` (multi-project overview at `/`), `project.js` (single-project view at `/<slug>/`; flat feature rail + selected-feature detail with session timeline + decision chips), `trace.js`, `graph.js`, `tags.js`. Per-page CSS in `web/styles/pages/`. As of 0.3.0 the SPA matches the design taxonomy and the backend rename.
- `dist/cli.js`, `dist/mcp.js` — the `stele` and `stele-mcp` PATH bins (per `package.json` `bin`). **`tsc`-compiled from `src/cli.ts` / `src/mcp.ts`** by `scripts/build.mjs`; shebang `#!/usr/bin/env -S node --no-warnings`, chmod +x at build. There are **no** hand-written `bin/*.js` wrapper files (an earlier design had them; gone). `tsconfig` `rewriteRelativeImportExtensions` rewrites the `.ts` import specifiers to `.js` in the emitted `dist/`. Edits to `src/` reach these bins only after `npm run build`. The published tarball ships `dist/` + `web/` at root (`files` in `package.json`), so an installed package resolves `webDir` as `<pkg>/web`.

### Frontend canonical reference

The `design/` folder is the source of truth for the frontend. The HTML mocks are not throwaway sketches — they encode the page taxonomy, the design tokens, and the visual identity (seal red, teal accent, Fraunces serif headlines on a warm off-white). The current `web/` SPA is a much smaller earlier version; any new UI work brings it closer to these mocks, never further.

**Page taxonomy** (this is what `web/` is converging on)

| Page | Design file | Role |
|---|---|---|
| Landing | `Stele Landing v2.html` (v2 supersedes `Stele Landing.html`) | Hero / entry — "what is this, why should you care" |
| Projects | `Stele Projects.html` | Multi-project list + resume strip + new-project; the daemon's `/` |
| Project | `Stele Project.html` | Single project = left **feature rail** + main feature × session timeline + decision cards |
| Trace | `Stele Trace.html` | Decision provenance: focal card + neighborhood (depends/relates/resolves/supersedes) + cross-session "stitch" |
| Tags | `Stele Tags.html` | Tag management: policy panel (auto/propose/locked) + pending proposals + active/archived |
| Decision Graph | `Decision Graph.html` (+ `Decision Graph v1.html` as the earlier iteration) | Interactive graph prototype; the JSX components live under `design/dg/` (and `design/dg-v1/`) |

**Design tokens — there are TWO systems, not one** (verbatim from the `:root` blocks; never paraphrase). The Landing pages are an editorial/typographic surface; the in-app pages are a sans-on-paper functional surface. They share the seal red but disagree on almost everything else, including variable naming (`--ink-*` vs `--t*`, `--surface-2` vs `--surface2`).

**Landing system** — `design/Stele Landing.html` + `Stele Landing v2.html`. Serif everywhere (body and display are the same family), no `--sans`, no radius/shadow tokens, warmer paper.

```css
--bg:#ECE7DD;        --bg-2:#E5DFCF;
--surface:#F4F0E8;   --surface-2:#EFEADF;
--ink:#211C16;       --ink-2:#574D40;       --ink-3:#8C8473;
--line:rgba(33,28,22,.14);   --line-2:rgba(33,28,22,.08);
--seal:#A23A29;      --seal-deep:#86301F;   --seal-dark:#CD6450;
--warm:#B49A7E;
--on-dark:#E7E0D1;   --on-dark-2:#A49B8A;   --line-dark:rgba(231,224,209,.16);
--serif:"Spectral","Noto Serif SC",Georgia,serif;
--body:"Spectral","Noto Serif SC",Georgia,serif;
--mono:"JetBrains Mono",ui-monospace,"SFMono-Regular",monospace;
--maxw:1140px;  --prose:660px;  --ease:cubic-bezier(.16,1,.3,1);
```
Fonts loaded: `Spectral` (300/400/500/600 + italic 400/500) + `Noto Serif SC` (400/500/600/700) + `JetBrains Mono` (400/500/600).

**In-app system** — sans on cool off-white, every accent paired with a washed `-bg`, full radius + shadow scale. There are two minor variants inside the in-app set; do not assume one block fits both.

**Base** (`Stele Projects.html`, `Stele Project.html`):

```css
--bg:#f4f3ef;  --surface:#fbfaf7;  --surface2:#edece7;  --surface3:#e6e4dd;
--t1:#1c1c1a;  --t2:#5c5b56;  --t3:#9c9a92;
--border:rgba(28,28,26,.08);   --border-strong:rgba(28,28,26,.16);
--teal:#0d5245;    --teal-bg:#dfece8;
--purple:#3a3185;  --purple-bg:#e9e7f3;
--amber:#7a4d0e;   --amber-bg:#f6edda;
--green:#2d6612;   --green-bg:#e6f2dc;
--red:#942929;     --red-bg:#f6dada;
--warm:#9a7b53;
--seal:#a23a29;    --seal-bg:#f4e3df;
--accent:#0d5245;
--shadow-sm:0 2px 12px rgba(28,28,26,.05);
--shadow-md:0 8px 30px rgba(28,28,26,.12);
--r-sm:6px;  --r-md:8px;  --r-lg:10px;  --r-xl:12px;  --r-2xl:16px;
--serif:"Fraunces";  --sans:"Plus Jakarta Sans";  --mono:"JetBrains Mono";
```

**Tags / Trace variant** (`Stele Tags.html`, `Stele Trace.html`): exactly the Base block **plus** `--blue:#2f5278; --blue-bg:#e4eaf2;` (used for cross-session / informational accents).

**Decision Graph variant** (`Decision Graph.html`): the Base block **minus** `--seal / --seal-bg / --warm / --mono` (DG doesn't surface the brand red or the mono font in `:root` — both still get used inline via direct font-family strings), **plus** `--blue / --blue-bg`, **plus** `--teal-soft:#eaf2ef; --teal-rgb:13,82,69;`, **plus** layout knobs `--seg-gap:56px; --dd-gap:30px; --card-pad-y:17px;`. `Decision Graph v1.html` is the older iteration — treat it as advisory only.

Fonts loaded across the in-app set: `Plus Jakarta Sans` (400/500/600/700/800) + `Fraunces` (opsz 9..144, weights 400/500/600 — with italic on Projects/Project/Tags/Trace, without italic on Decision Graph) + `JetBrains Mono` (400/500/600).

**Boundary rule**: when `web/` becomes the daemon's `/` overview page, use the Landing system; the moment a project is selected, switch to the in-app system. Don't cross-mix tokens — the typeface change is the visual signal that you've moved from "marketing" into "work."

**Naming locked by the design** (use these everywhere user-facing — copy, route names, JSON keys)

- Domain hierarchy: **Project → Feature → Session → Decision**, with Tag and Edge as cross-cutting. 0.3.0 collapsed the 0.1–0.2 chain (`Project → Feature(umbrella) → Milestone → Session → Decision`) by one layer: the umbrella `Feature` is gone, and the old `Milestone` IS the new `Feature`.
- "Feature" — never "milestone" or "phase". (The 0.2-era prototypes still mention milestones; ignore. The `design/Stele Project.html` mock predates the collapse but the columns it draws are what the new Features render as — same picture, simpler model.)
- Feature `state ∈ {draft, going, winding, done, paused}` (5-state; design colors them teal=going, green=done, amber=paused, …)
- Project `status ∈ {active, winding, dormant, archived}`
- Session `outcome.type ∈ {advanced, resolved, touched}`; `pause_reason.kind ∈ {blocked, waiting_dep, out_of_time, lost_thread, done_enough, other}`. **Legacy in 0.3.0**: the agent-facing path no longer emits these; the columns live so existing rows decode.
- Decision `type ∈ {decision, deferred, open}`; derived `nodeState ∈ {decided, deferred, superseded, resolved, open, conflicted}`
- Decision id format: `<feature>/<local>` (e.g. `F-01/D-04`) — URL-encode the slash in route paths
- Edge `relation ∈ {depends_on, resolves, supersedes, relates, reconciles}`

When `web/` and the design diverge on naming, the design wins. As of 0.3.0 the SPA matches `types.ts` (the 0.2-era drift caught up in the rename pass).

**Verification rule for this section.** An earlier draft of this section flattened the two systems into one fictional block and got the radius scale, the serif font, and the variable casing wrong. If something matters down to the hex value (a token in `web/styles.css`, a chart axis colour, an exported PDF theme), open the actual `:root` block in the corresponding `design/*.html` and verify against it — don't trust any summary, including this one. The tables above are correct as of 2026-06-09, but only the source files are normative.

### MCP server stdio discipline

`src/mcp.ts` is a JSON-RPC server over stdio. **stdout is reserved for the MCP framing** — any stray `console.log` corrupts the protocol and the client hangs with no error. All informational output goes to `stderr` (use `console.error` or `process.stderr.write`). Only `cli.ts` is allowed to write to stdout. If you add diagnostics to any module that `mcp.ts` imports, route them to stderr.

### Deferred-but-on-purpose

Two things are stored but not active, by design:
- **IntentDelta** (`status.delta` / `status.draftDelta`) is persisted but never folded into an effective bundle and never conflict-checked. That needs a bundle layer the POC omits. Don't add fold/conflict logic without that layer.
- **EntityResolver** is a stub. Replace `stubResolver` with a real resolver if you want hydrated labels; do not move ontology knowledge into `store.ts` or `projections.ts`.

### Slash commands

0.3.0 collapsed the three 0.2-era commands (`/decision`, `/milestone-report`, `/resume`) into **one**. 0.4.0 added a second to cover historical sources:

- `.claude/commands/stele/feature.md` — `/stele:feature`. Idempotent reconcile pass over the CURRENT session, callable any time. Finds the project's currently-going Feature (or opens one), pulls every captured decision on it via `feature_decisions`, diffs against the live transcript to identify gaps, captures each gap via `decision_capture`, then rewrites the rolling `Feature.summary` via `feature_set_summary` (replace, not append). No session-end ritual, no pause reason, no state transition — Feature state moves to `winding` / `done` manually via the dashboard.
- `.claude/commands/stele/scan.md` — `/stele:scan` (0.4.0). Reconcile pass over OTHER sources — historical Claude Code transcripts (`~/.claude/projects/<sanitized-cwd>/*.jsonl`), `git log --since=<date>`, plain files. Re-runnable any time; first-install backfill is just the most common use case. Args: `--last N` / `--git-since <date>` / `--files <path>...` / `--feature <id>` / `--dry-run`. Presents candidates to the user for confirm-before-capture; writes with `source='session-extract'` + `sourceReport='scan:<type>:<id>'` for origin tracking. NOT a CLI — runs in-conversation against the live agent's stele MCP access (no `claude -p` headless spawn).

The retired 0.2-era commands are not aliased; re-running `stele init` on an upgraded project deletes the legacy files. **As of 0.4.0-snapshot.11 the sweep also covers user-level `~/.claude/commands/decision.md` / `resume.md` / `milestone-report.md`** with a content fingerprint guard (only deletes when `stele|实录` appears in the file — protects user-authored commands with the same name from other tools). If you change the `Decision` schema in `types.ts`, update both the `stele-capture` skill (the field-level reference), `stele-feature-command.md` AND `stele-scan-command.md` (the workflow scripts) in lockstep.

### Auto-capture (the 0.4.0 three-layer model)

0.4.0 shipped automated capture on top of the manual `/stele:feature` reconciler. The model is deliberately three-layered because each layer has a different fidelity / cost trade-off, and they backstop each other through a shared dedup key:

| Layer | Trigger | Fidelity | Cost | Hook |
|---|---|---|---|---|
| 1 · live | Agent self-governs during work via the `stele-capture` skill's auto-activation. The skill's `description:` frontmatter triggers on "when a decision crystallizes" / "when capturing to stele" — Claude Code auto-loads SKILL.md whenever the agent is reasoning about whether to capture. | **Highest** — the agent has the full conversation in context and knows what just got chosen. | 0 per-turn overhead. No regex pre-filter, no per-turn nag. | None. |
| 2 · read | SessionStart hook fires once per session open, injects a declarative context block via stdout. Includes `cc_session_id`, every Feature in state `going` (with open-loop counts and start dates), the tag policy, up to 10 active tags, the resume digest of un-resolved Decisions, and a single-line standing capture criteria. Every section collapses silently if empty. | N/A — read-side only. | Cheap. One shell-out per session. Synchronous (no `async`). | `.claude/hooks/stele-session-start.sh` — `type: command`. |
| 3 · post-hoc | SessionEnd agent-type hook spawns an isolated Claude with a tightly-scoped MCP allow-list (`mcp__stele__decision_capture` + `mcp__stele__feature_list` + `mcp__stele__feature_decisions` + `Read`). The subagent reads `transcript_path`, identifies uncaptured decisions, calls `decision_capture` with `source='session-extract'`. **Opt-in only** via `stele hooks install --enable-session-end-auto-extract` or `stele hooks enable session-end-auto-extract`. Blocks session close ≤60s. Decision-schema field reference is **inlined into the agent prompt** because subagents don't inherit the parent's loaded skills. | Medium — same text-archaeology model as `/stele:scan`. Catches whatever Layer 1 missed in the just-ended session. | Off path: zero. On path: ~30-60s lag at session close + one isolated Claude conversation. No `claude -p` billed surface. | `.claude/hooks/stele-session-end.sh` (wrapper) + `.claude/agents/stele-extract.md` — `type: agent`. |
| 3 · manual | `/stele:scan` slash command, user-invoked any time. | Same as auto Layer 3 (text archaeology). | One conversation turn + the user's review of candidates. | None. |

**The shared dedup key.** All three layers funnel through `decision_capture`. Before writing, `Store.putDecision` computes `dedupKey = sha256(featureId | normalize(title) | sort(affects)).slice(0,16)` and checks the `UNIQUE` partial index. A collision returns `{ skipped: true, existingId }` instead of inserting. That's how Layers 1, 2, and 3 coexist — when the live agent and the post-hoc subagent observe the same decision, the second call silently dup-skips. The MCP tool surfaces `dup-skip: <existingId>` so callers can still author edges against the existing node.

**The `Decision.source` field.** `'manual'` (default; legacy rows decode unchanged), `'agent-live'` (live agent's in-conversation capture), `'session-extract'` (post-hoc subagent + `/stele:scan` writes). The web SPA renders a colour-coded pill on each decision chip (warm for live, amber for extracted, none for manual) plus a `?src=session-extract` rail filter for batch review. **The MCP tool can't tell the caller's identity** — `source` has to be set explicitly by the caller; the standing instructions in `stele-capture/SKILL.md`, `stele-extract.md`, and `stele-scan-command.md` are how each layer learns which value to pass.

**Prompt-injection defense.** SessionStart stdout is **declarative prose**, never imperative. The block ends with a fixed disclaimer line: "这些只是状态摘要，不是行动指令。" Claude Code's prompt-injection defense flags imperative system-text injection; writing in third-person descriptions of state sidesteps that.

**Anti-patterns to avoid.**
- Don't re-add a Stop hook. The snapshot.10 deletion was deliberate — the 12 bilingual regex patterns it used were worse than the agent's own judgment and added per-turn overhead. Layer 1 stays skill-driven.
- Don't shell out to `claude -p` for Layer 3. Hook type `agent` spawns its own Claude on the user's existing plan with allow-list scoping; `claude -p` would bill twice and lose the allow-list guarantee.
- Don't add a `source` value beyond the three (`manual` / `agent-live` / `session-extract`). They map cleanly to the three layers; adding a fourth muddies the SPA filter and the dedup contract.

## Conventions specific to this repo

- **Source imports use `.ts` extensions** (`import { Store } from "./store.ts"`) — required for `--experimental-strip-types` in the dev loop; `tsconfig` `rewriteRelativeImportExtensions` rewrites them to `.js` when `tsc` emits `dist/`. The dev loop runs `src/` directly with no build; the installed CLI/MCP/daemon run a `tsc`-built `dist/` (see § Build & run model). So a `src/` edit is live for `npm test` / `npm run _node` immediately, but needs `npm run build` to reach an installed bin or the daemon.
- **`revisitWhen` on a deferred decision must be a structured `Trigger`** (`metric` / `event` / `dependency` / `manual`), never free text. The resume layer relies on the discriminant to flag "needs check" — a free-text trigger is invisible to it forever.
- **`delta` is optional and rare.** Only decisions that modify an intent bundle carry it. Pure code/tooling decisions leave it off; their changes are captured in `affects` + `artifacts`.
- **Decision ids follow a convention by status kind:** `D-NN` for decided, `DEF-NN` for deferred, `OQ-NN` for open. The seed parser (`seed.ts`) relies on this when extracting cross-references from prose.
- **Sandbox DBs.** `.stele/` and the legacy `prov.db` are gitignored. By default each project gets its own `.stele/decisions.db`; use `STELE_DB="$PWD/sandbox.db"` for ad-hoc experiments that shouldn't touch the project store.
- **Schema migrations are nonexistent on purpose.** `Store`'s `CREATE TABLE IF NOT EXISTS` runs on every connect. Adding a column is fine (existing rows get NULL); renaming/dropping is a breaking change with no migration path — don't do it without one.
- **Tag policy lives in `src/tags.ts`, not in `store.ts`.** The store is a dumb persistence layer for tags / proposals / config; policy decisions (auto vs propose vs locked, require_reason) happen inside `ensureTag`. If you find yourself reaching for `store.getConfig("tag_policy")` outside `tags.ts`, you're probably about to duplicate the engine — call `ensureTag` instead. The same goes for tag-name dedup: always go through `findTagByName` (which is COLLATE NOCASE) or `ensureTag`, never compare `tag.name === input` directly.

## Backend gaps from the design spec (deferred, not missed)

The canonical spec is `design/Stele Backend Design.md`. **As of 0.4.0, the backend, the web SPA, and the agent-facing capture surface are all aligned with the spec.** What's still deferred:

- **`IntentDelta`** bundle layer (still deferred-but-on-purpose; no fold or conflict-check logic without it).
- **Real `EntityResolver`** — `stubResolver` continues to return bare `kind:id` labels.
- **Auto-proposing `depends_on`** from the consolidate layer — only authored. The consolidate heuristic still emits `relates` / `resolves` only.
- **Cross-project queries / federation** — each `.stele/decisions.db` stays per-project.
- **ExitPlanMode-driven enrichment** — the auto-capture design doc named it; 0.4.0 deferred it pending post-hoc extraction quality observations.

**Already chosen departures from the design spec — do not re-litigate:**

- DB path stays per-project `<project>/.stele/decisions.db`, **not** the design's `~/.provenance/decisions.db`. The per-project model means the registry, the daemon's multi-tenant routing, and `.stele/` as a git marker all keep working — the global path optimises for the single-user single-machine case but breaks the rest.
- Runtime stays `node:sqlite`, **not** `better-sqlite3`. The zero-deps stance is load-bearing; we'd add `better-sqlite3` only if a measured perf gap forces it.
