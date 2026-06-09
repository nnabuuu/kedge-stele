# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**实录 / Stele** — a local decision-provenance store distributed as an npm package (`stele-mcp`). Primary client is Claude Code via a stdio MCP server; a CLI is a secondary adapter onto the same store. Runtime is Node ≥22.6 running TypeScript directly via `--experimental-strip-types`. Storage is SQLite via `node:sqlite`. The only non-stdlib deps are `@modelcontextprotocol/sdk` and `zod` (for the MCP adapter). End-user install is `npm install -g stele-mcp` → bins `stele` and `stele-mcp` on PATH; the `bin/*.js` wrappers re-exec Node on `src/*.ts` with the type-strip flags so the package works on any Node ≥22.6 and on Windows (npm bin shims don't read shebang flags). The `design/` folder is canonical — backend spec at `design/Stele Backend Design.md`, UI mocks at `design/*.html`. See § Project ambition and § Frontend canonical reference below.

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

# When testing the installed-bin distribution flow from this checkout:
npm install -g .                                  # puts `stele` and `stele-mcp` on PATH, pointing at src/
```

No build step, no test suite. There is no linter wired up. Verify changes by running the acceptance scenario in DEVELOPING.md (seed → add → resume → trace → trace-entity).

## Architecture

### The atom is a decision node, not a report

`src/types.ts` is the source of truth for the model. The store holds a graph: nodes are `Decision` records with a discriminated `Status` (`open` / `decided` / `deferred` / `superseded` / `resolved` / `conflicted`), edges are typed (`resolves` / `supersedes` / `reconciles` / `relates`). Every report, backlog, or resume digest is a **projection** (live query) over this graph — never a frozen snapshot. This is the load-bearing invariant: adding a `resolves` edge today retroactively updates how a three-week-old report renders, because the report re-queries the live node.

Status flips happen inside `Store.addEdge` (`src/store.ts`): a `resolves` edge mutates the target's status to `{kind:"resolved", by}`; `supersedes` does the same for `superseded`. Projections rely on this — don't bypass `addEdge` to write edges directly.

### Module layout (everything is headless except the two adapters)

- `src/types.ts` — schema source of truth. `Project`, `Feature`, `Milestone`, `Session`, `Decision`, `Edge`, `CapturePayload`, plus `Tag` / `Tagging` / `TagProposal` / `TagPolicy`, plus the 0.1.0 `MilestoneReportDraft` / `ResumeCommandResult` shapes. `Decision` is the split shape: `type` + `status` + `resolvedBy` + `supersededBy` + rich `detail`. `Edge` uses `relation` (not `kind`); five values incl `depends_on`. Milestone state is 5-state (`draft/going/winding/done/paused`). If you change any enum or any of the entity shapes, `src/schemas.ts` (Zod) AND the capture form in `web/app.js` must be updated in lockstep.
- `src/schemas.ts` — Zod schemas mirroring `types.ts`. Imported by both `mcp.ts` (MCP tool input validation) and `serve.ts` (HTTP POST validation) so the two adapters can't drift.
- `src/store.ts` — SQLite-backed graph. Owns 11 tables: `projects`, `features`, `milestones`, `sessions`, `decisions`, `edges`, `affects`, `tags`, `taggings`, `tag_proposals`, `config`. Answers entity-anchored queries (`decisionsAffecting`) without any ontology. 0.1.0 changes: Decision split into `type` + `status` + `resolved_by` + `superseded_by` columns; `edges.relation` (not `kind`); new tables `projects` + `features`; milestone state widens to 5 values; sessions store JSON `provenance` + `outcome` + `pause_reason`. **Pre-0.1.0 databases are NOT auto-migrated**: the constructor detects the legacy `decisions.status_kind` column and renames the file aside to `<path>.0.0.x.db` before creating a fresh schema. `migratedFromLegacy` is set so the CLI / MCP can print a one-time hint. Session dedup is still `UNIQUE(source, source_sess_id)`; tag-name dedup is still `UNIQUE COLLATE NOCASE`. WAL is set in the constructor.
- `src/tags.ts` — tag policy engine. `ensureTag(store, name, ctx)` is the single chokepoint: if the name already exists active, it's reused; otherwise the local `tag_policy` config (`auto` / `propose` / `locked`) decides whether the agent gets to create it, queue a proposal, or be blocked. Called by `decision_capture`, by `tag_propose` (MCP / CLI / HTTP), and by `applyCaptureTags` (the batch wrapper). The only module allowed to enforce policy — `store.ts` is policy-blind.
- `src/capture.ts` — milestone + feature + session resolution for `decision_capture`, plus the explicit `recordSessionStart` / `recordSessionEnd` helpers used by the `session_start` / `session_end` MCP tools and the `/milestone-report` flow. First session on a 'draft' milestone auto-advances state to 'going'; `session_end({outcome:{type:'resolved'}})` advances 'going' → 'winding'. Other state transitions are explicit.
- `src/projections.ts` — read-only views: `resumeDigest` (what's waiting), `trace` (node neighbourhood), `traceEntity` (everything touching a file/feature/skill). These return plain data; formatting lives in the adapters.
- `src/consolidate.ts` — on capture, proposes `resolves` / `relates` edges against every still-pending node via token-jaccard + shared-entity heuristic. This is the "Evaluator agent's seat" — the human (via `decision_resolve`) confirms.
- `src/render.ts` — HTML rendering for the resume digest (self-contained CSS, no framework).
- `src/seed.ts` — HTML feature-report → decision graph parser. Used only for cold-start; not part of the runtime path.
- `src/resolver.ts` — `EntityResolver` interface. `stubResolver` returns bare `kind:id` labels. This is the **only** coupling point to an external ontology; swapping it is how the tool would light up across a real entity model.
- `src/paths.ts` — single source of truth for the DB path. Project-based: walks up from cwd looking for a `.stele/` marker directory (stopping at `$HOME` to avoid silently picking up a stale global store). If no marker is found, throws `SteleNotInitializedError` — both `cli.ts` and `mcp.ts` catch it and print a hint pointing the user at `stele init`. No auto-create (deliberate footgun-avoidance for the distributed binary). `STELE_DB` (or legacy `PROV_DB`) overrides everything. Never hardcode another path.
- `src/cli.ts` — CLI adapter. Writes to stdout freely. Owns four storeless subcommands (`init`, `hooks`, `daemon`, `serve`) plus all data-touching ones. `init` is the bootstrap entry: creates `.stele/`, writes `.mcp.json` + `.gitignore`, then by default also installs hooks (via `src/hooks.ts`) and a daemon (via `src/daemon.ts`). `--skip-daemon` / `--skip-hooks` are opt-outs.
- `src/hooks.ts` — installer for the write-path integration. Writes `.claude/hooks/stele-stop.sh`, `.claude/skills/stele-capture/SKILL.md`, `.claude/commands/decision.md`, and merges a Stop hook entry into `.claude/settings.json` preserving any other configured hooks. All artifacts read from `src/templates/`.
- `src/daemon.ts` — launchd (macOS) / systemd user (Linux) installer for the **single multi-tenant daemon** (`com.stele.daemon` / `stele-daemon.service`). Writes the unit file with **absolute `node` + script path** (from `process.execPath` and `process.argv[1]`), so launchd/systemd don't need a working PATH. `install` first sweeps any legacy per-project plists (`com.stele.<hash>` from 0.0.2-), bootouts them, reads their WorkingDirectory and registers the projects into `~/.stele/registry.json` so no decisions go missing.
- `src/templates/` — source-of-truth for everything `stele init` / `stele hooks install` writes into a project. Three slash commands as flat files: `decision-command.md` (`/decision`), `milestone-report-command.md` (`/milestone-report`), `resume-command.md` (`/resume`). The `stele-capture` skill is a **folder** (per Anthropic's progressive-disclosure pattern, [link](https://claude.com/blog/lessons-from-building-claude-code-how-we-use-skills)): `stele-capture-skill/SKILL.md` is the entry point with overview + when_to_use + 4-step checklist + pointers; `stele-capture-skill/gotchas.md` holds the concrete traps; `stele-capture-skill/references/{decision-schema,milestone-judgment,feature-judgment,tag-judgment}.md` hold field-level detail loaded on demand. `stele-stop-hook.sh` (bash regex detector — shells out to `stele milestones list --state going --json`, `stele config get tag_policy`, and `stele tags list --json` to inject active context). Changing project-installed content means changing here. `hooks.ts` writes each command file only if missing (no overwriting user edits) but always replaces the skill folder wholesale (no stale references files surviving a version bump).
- `src/mcp.ts` — stdio MCP server. Registers 22 tools as of 0.1.0: four capture-path tools (`decision_capture` / `decision_resume` / `decision_trace` / `decision_resolve`), two feature tools (`feature_open` / `feature_list`), three milestone tools (`milestone_list` / `milestone_open` / `milestone_report`), three session tools (`session_start` / `session_end` / `resume_command`), eight tag tools (`tag_propose` / `tag_apply` / `tag_confirm` / `tag_reject` / `tag_recolor` / `tag_rename` / `tag_archive` / `tag_restore`), and two config tools (`config_get` / `config_set`). `decision_resolve` takes `relation` (not `kind`) and accepts `depends_on`. `milestone_close` is retired (state advances via `session_end` / explicit CLI `set-state`). Catches `SteleNotInitializedError` at startup; prints the legacy-DB migration hint via `store.migratedFromLegacy`.
- `src/serve.ts` — `node:http` server backing `stele serve`. Two modes: **single-project** (cwd's store, routes at `/api/*` — used by dev) and **multi-tenant** (`--multi`, reads `~/.stele/registry.json`, lazy-opens a `Store` per slug, routes at `/<slug>/api/*` plus `/api/projects` and `/`). The daemon always uses `--multi`. POST bodies validate via `src/schemas.ts`. localhost-only.
- `src/registry.ts` — global project registry at `~/.stele/registry.json`. `register(path)` is idempotent on path, generates a URL-safe slug from basename (collisions get `-2`/`-3` suffixes), saves atomically. `stele init` calls it; multi-tenant `serve` reads it; `daemon install` legacy-sweep populates it from old per-project plists.
- `web/index.html`, `web/styles.css`, `web/app.js` — single-page web UI; vanilla JS, no framework, no build. Slug-aware: `currentSlug` extracted from `location.pathname` first segment, `apiGet`/`apiPost` auto-prefix it, `slugUrl(path)` is used in href construction. Views: overview (no slug) / resume / all decisions / decision detail / entity / capture form. Project switcher dropdown in topbar. **This is what exists today; it lags the canonical design — see § Frontend canonical reference for the target.**
- `bin/stele.js`, `bin/stele-mcp.js` — JS wrappers npm publishes as the `stele` and `stele-mcp` PATH bins. Each re-execs Node with `--experimental-strip-types --no-warnings` against the corresponding `src/*.ts` and inherits stdio. Edits to `src/` are picked up without rebuilding.

### Frontend canonical reference

The `design/` folder is the source of truth for the frontend. The HTML mocks are not throwaway sketches — they encode the page taxonomy, the design tokens, and the visual identity (seal red, teal accent, Fraunces serif headlines on a warm off-white). The current `web/` SPA is a much smaller earlier version; any new UI work brings it closer to these mocks, never further.

**Page taxonomy** (this is what `web/` is converging on)

| Page | Design file | Role |
|---|---|---|
| Landing | `Stele Landing v2.html` (v2 supersedes `Stele Landing.html`) | Hero / entry — "what is this, why should you care" |
| Projects | `Stele Projects.html` | Multi-project list + resume strip + new-project; the daemon's `/` |
| Project | `Stele Project.html` | Single project = left **feature rail** + main milestone × session timeline + decision cards |
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

- Domain hierarchy: **Project → Feature → Milestone → Session → Decision**, with Tag and Edge as cross-cutting
- "Milestone" — never "phase" (the spec renamed it; old prototypes still use `dg-v1`'s phrasing — ignore)
- Milestone `state ∈ {draft, going, winding, done, paused}` (5-state; design colors them teal=going, green=done, amber=paused, …)
- Project `status ∈ {active, winding, dormant, archived}`
- Session `outcome.type ∈ {advanced, resolved, touched}`; `pause_reason.kind ∈ {blocked, waiting_dep, out_of_time, lost_thread, done_enough, other}`
- Decision `type ∈ {decision, deferred, open}`; derived `nodeState ∈ {decided, deferred, superseded, resolved, open, conflicted}`
- Decision id format: `<milestone>/<local>` (e.g. `ccaas-1a/D-04`) — URL-encode the slash in route paths
- Edge `relation ∈ {depends_on, resolves, supersedes, relates, reconciles}`

When `web/` and the design diverge on naming, the design wins. When `web/` and the current 0.0.7 `types.ts` diverge on naming, that's tracked in § Backend gaps below — don't quietly fix one to match the other.

**Verification rule for this section.** An earlier draft of this section flattened the two systems into one fictional block and got the radius scale, the serif font, and the variable casing wrong. If something matters down to the hex value (a token in `web/styles.css`, a chart axis colour, an exported PDF theme), open the actual `:root` block in the corresponding `design/*.html` and verify against it — don't trust any summary, including this one. The tables above are correct as of 2026-06-09, but only the source files are normative.

### MCP server stdio discipline

`src/mcp.ts` is a JSON-RPC server over stdio. **stdout is reserved for the MCP framing** — any stray `console.log` corrupts the protocol and the client hangs with no error. All informational output goes to `stderr` (use `console.error` or `process.stderr.write`). Only `cli.ts` is allowed to write to stdout. If you add diagnostics to any module that `mcp.ts` imports, route them to stderr.

### Deferred-but-on-purpose

Two things are stored but not active, by design:
- **IntentDelta** (`status.delta` / `status.draftDelta`) is persisted but never folded into an effective bundle and never conflict-checked. That needs a bundle layer the POC omits. Don't add fold/conflict logic without that layer.
- **EntityResolver** is a stub. Replace `stubResolver` with a real resolver if you want hydrated labels; do not move ontology knowledge into `store.ts` or `projections.ts`.

### Slash commands

`.claude/commands/decision.md` is the `/decision` slash command — per-decision capture. It drives the MCP tools (not the CLI) and instructs the agent to draft a full `CapturePayload` from conversation context. If you change the `Decision` schema in `types.ts`, also update the field-by-field instructions in this command file.

0.1.0 added two milestone-level commands:

- `.claude/commands/milestone-report.md` — `/milestone-report` (走之前留话). Agent draws a `milestone_report` draft, fills `summary` + `resumeEdge` + `suggestedPauseReason`, shows it to the user, then calls `session_end` with the confirmed outcome + pause_reason. Advances milestone state.
- `.claude/commands/resume.md` — `/resume` (回来时念回来). Agent calls `resume_command`, reads back the last session's outcome + pause_reason, and prints a copy-paste `claude --resume` command (mode `jump` if zellij layout still alive, else `rebuild`).

The three slash commands compose: `/decision` runs many times per session, `/milestone-report` runs once when closing, `/resume` runs once when coming back.

## Conventions specific to this repo

- **No build step, no transpile.** TypeScript runs directly. Imports must use `.ts` extensions (`import { Store } from "./store.ts"`) — this is required for `--experimental-strip-types`.
- **`revisitWhen` on a deferred decision must be a structured `Trigger`** (`metric` / `event` / `dependency` / `manual`), never free text. The resume layer relies on the discriminant to flag "needs check" — a free-text trigger is invisible to it forever.
- **`delta` is optional and rare.** Only decisions that modify an intent bundle carry it. Pure code/tooling decisions leave it off; their changes are captured in `affects` + `artifacts`.
- **Decision ids follow a convention by status kind:** `D-NN` for decided, `DEF-NN` for deferred, `OQ-NN` for open. The seed parser (`seed.ts`) relies on this when extracting cross-references from prose.
- **Sandbox DBs.** `.stele/` and the legacy `prov.db` are gitignored. By default each project gets its own `.stele/decisions.db`; use `STELE_DB="$PWD/sandbox.db"` for ad-hoc experiments that shouldn't touch the project store.
- **Schema migrations are nonexistent on purpose.** `Store`'s `CREATE TABLE IF NOT EXISTS` runs on every connect. Adding a column is fine (existing rows get NULL); renaming/dropping is a breaking change with no migration path — don't do it without one.
- **Tag policy lives in `src/tags.ts`, not in `store.ts`.** The store is a dumb persistence layer for tags / proposals / config; policy decisions (auto vs propose vs locked, require_reason) happen inside `ensureTag`. If you find yourself reaching for `store.getConfig("tag_policy")` outside `tags.ts`, you're probably about to duplicate the engine — call `ensureTag` instead. The same goes for tag-name dedup: always go through `findTagByName` (which is COLLATE NOCASE) or `ensureTag`, never compare `tag.name === input` directly.

## Backend gaps from the design spec (deferred, not missed)

The canonical spec is `design/Stele Backend Design.md`. **As of 0.1.0, the backend is fully aligned with the spec.** What's still deferred:

- **`web/` SPA rebuild** to match the design mocks — frontend keeps its 0.0.7-era shape this release and renders incompletely. Backend now feeds the right data; the rebuild is the next planning round (0.1.1 / 0.2.0).
- **`IntentDelta`** bundle layer (still deferred-but-on-purpose; no fold or conflict-check logic without it).
- **Real `EntityResolver`** — `stubResolver` continues to return bare `kind:id` labels.
- **Auto-proposing `depends_on`** from the consolidate layer — authored only in 0.1.0. The consolidate heuristic still emits `relates` / `resolves` only.
- **Cross-project queries / federation** — each `.stele/decisions.db` stays per-project.

**Already chosen departures from the design spec — do not re-litigate:**

- DB path stays per-project `<project>/.stele/decisions.db`, **not** the design's `~/.provenance/decisions.db`. The per-project model means the registry, the daemon's multi-tenant routing, and `.stele/` as a git marker all keep working — the global path optimises for the single-user single-machine case but breaks the rest.
- Runtime stays `node:sqlite`, **not** `better-sqlite3`. The zero-deps stance is load-bearing; we'd add `better-sqlite3` only if a measured perf gap forces it.
