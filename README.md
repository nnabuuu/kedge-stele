# 实录 · Stele

**English** · [中文](./README.zh-CN.md)

> *Carve decisions as they're made, traceable ever after.*

> **Status: 0.4.1** — three-layer auto-capture model plus the
> `main_language` setting. Schema is additive from 0.3.0 (existing DBs
> open unchanged); the agent surface is stable. Pin a version with
> `npm install -g stele-mcp@0.4.1`.

A local decision-provenance store for Claude Code. When a decision
crystallizes in conversation — what you chose, what you rejected, what
you deferred, what's still open — it lands in a structured graph,
either automatically as the agent captures it in-flight or via a
slash command you invoke. Later, ask "what's waiting on me?" and the
unresolved loops come back in seconds.

The atom is the **decision**, not the report. A `deferred` item from
three weeks ago that a later decision resolves updates everywhere
automatically, because every view is a live query over the graph, never
a frozen snapshot.

Decisions roll up into **sessions** (one Claude Code conversation),
which roll up into **features** (a chunk of work like "ship multi-tenant
daemon"), which roll up into a **project** (one `.stele/` directory).
The agent does the bucketing for you — you don't manage which feature
or session a decision belongs to manually.

---

## Install

Requires **Node ≥ 22.6** (any modern Node works; no Python, no Docker).
Claude Code ≥ **2.1.0** is required for the SessionStart / SessionEnd
hooks to register correctly — `stele init` pins this in your project's
`settings.json` so an older client refuses to start rather than
silently misbehaving.

```bash
npm install -g stele-mcp@0.4.1
```

This puts two commands on your PATH:
- `stele` — CLI for inspecting and editing the decision store
- `stele-mcp` — the MCP server that Claude Code talks to

> **Windows users**: the SessionStart hook is a bash script. Install
> WSL to use it, or pass `--skip-hooks` to `stele init` and use the
> `/stele:feature` slash command manually instead. (Native Windows
> support is on the roadmap.)

## Bootstrap a project

In any project where you want to track decisions:

```bash
cd /path/to/your-project
stele init
```

This single command sets up the full read/write loop:

- **`.stele/`** — the decision store (SQLite) for this project
- **`.mcp.json`** — so Claude Code in this directory sees the `stele` MCP server
- **`.gitignore`** — adds `.stele/` so the DB isn't accidentally committed
- **Always-on browser UI** — launchd (macOS) or systemd-user (Linux) keeps
  the multi-tenant daemon alive at `http://127.0.0.1:3939` across reboots
- **SessionStart hook + capture skill + slash commands** — Claude Code
  picks these up automatically next time you open the project (see
  "How capture works" below)

Opt-outs:

```bash
stele init --skip-daemon                       # no always-on browser UI
stele init --skip-hooks                        # no SessionStart hook, no skill
stele init --enable-session-end-auto-extract   # also install the opt-in Layer 3 hook
stele init --port 4000                         # daemon on a non-default port
```

The MCP tools (`decision_capture`, `decision_resume`, `decision_trace`,
`decision_resolve`, plus `feature_*` and `tag_*`) become available in
Claude Code after a restart.

## How capture works — three layers

Stele captures decisions through three layers that backstop each other.
They share a **dedup key** (sha256 of `featureId | normalized-title |
sorted-affects`) so the same decision can't get carved twice — if two
layers observe the same moment, the second call silently dedups.

| Layer | Trigger | Fidelity | Cost | Default |
|---|---|---|---|---|
| 1 · live | The agent self-governs in-conversation via the `stele-capture` skill (auto-activated when the agent is reasoning about whether to capture). | **Highest** — full conversation context. | 0 per-turn overhead. | **on** |
| 2 · read | SessionStart hook injects `cc_session_id`, your active features, tag policy, top tags, and the open-loops digest as declarative prose at session open. | N/A — read-side only. | One shell-out per session open. | **on** |
| 3a · post-hoc auto | SessionEnd hook spawns an isolated Claude with a scoped MCP allow-list; it reads the just-ended transcript and captures anything Layer 1 missed. | Medium — text archaeology, no live context. | Blocks session close ≤60s. **No `claude -p` billing surface** — uses Claude Code's `agent`-type hook so the conversation runs on your existing plan. | **off** (opt-in) |
| 3b · manual | `/stele:scan` slash command — reconciles historical sources (CC transcripts, git log, files). Re-runnable any time. | Same as 3a (text archaeology). | One conversation turn + your review. | **on demand** |

To enable Layer 3 auto:

```bash
stele hooks enable session-end-auto-extract     # turn it on
stele hooks disable session-end-auto-extract    # turn it off
stele hooks status                              # see what's installed
```

### The two slash commands

`stele init` installs two project-scoped slash commands:

- **`/stele:feature`** — reconcile pass over the **current** session.
  Idempotent, callable any time. Finds your currently-going Feature
  (or opens one), diffs the captured decisions against the live
  transcript, captures any gaps, and rewrites the Feature's rolling
  summary. Use it any time you feel the auto-capture might have
  missed something.

- **`/stele:scan`** — reconcile pass over **other** sources.
  Walks historical Claude Code transcripts at
  `~/.claude/projects/<sanitized-cwd>/*.jsonl`, optionally `git log
  --since=<date>` and arbitrary files. Presents candidate decisions
  for confirm-before-capture. First-install backfill is the common
  use case, but it's re-runnable: run it after a long planning
  conversation in another tool, after a big feature-branch merge, or
  any time you want to audit the graph.

```
/stele:scan                       scan historical CC transcripts (default)
/stele:scan --last N              only the N most recent transcripts
/stele:scan --git-since 2026-01-01  also scan recent commits
/stele:scan --files <path>...     also scan specific files
/stele:scan --dry-run             show what would be captured, don't write
```

Both commands run **in your live Claude Code conversation** — no
headless `claude -p`, no separate billed surface.

## Always-on browser UI

`stele init` installs a single multi-tenant daemon that serves every
registered project at the same URL:

```
http://127.0.0.1:3939/                ← overview of all projects
http://127.0.0.1:3939/<slug>/         ← that project's view (feature rail + decisions)
http://127.0.0.1:3939/<slug>/trace/   ← decision-graph trace
http://127.0.0.1:3939/<slug>/tags/    ← tag management
```

One daemon, one URL to bookmark, one process to manage. As you `stele
init` in more projects, each one registers in `~/.stele/registry.json`
(slug defaults to the directory's basename; collisions get
`-2`/`-3` suffixes) and shows up as a new card on the overview without
a daemon restart.

- macOS → `~/Library/LaunchAgents/com.stele.daemon.plist` (launchd)
- Linux → `~/.config/systemd/user/stele-daemon.service` (systemd user)

Manage with:

```bash
stele daemon status                   # is it loaded? how many projects?
stele daemon install                  # idempotent — also sweeps legacy plists
stele daemon uninstall                # remove the unit + unload
stele projects list                   # registry contents
stele projects remove <slug>          # forget a project (doesn't delete .stele/)
```

Logs live at `~/.stele/daemon.log` and `daemon.err.log`.

> **Linux**: services run only while you're logged in. For true always-on,
> run `sudo loginctl enable-linger <you>` (one-time, system level).
> **Upgrading from 0.0.2**: `stele daemon install` automatically removes
> the old per-project plists/units and registers their working
> directories into the global registry, so no decisions go missing.

## Daily use

```
discuss a design in Claude Code
   ↓
agent recognizes a decision crystallized → captures it on its own
(Layer 1 · live; you'll see the capture in the dashboard)
   ↓
if you suspect something was missed: /stele:feature
   ↓
if you want to backfill a historical transcript: /stele:scan
```

After time away, start a new session and ask:

> what's waiting on me?

The agent calls `decision_resume`. You see every open + un-resolved
deferred node, with the most-likely-due ones first. Pick one and ask
the agent to **trace** it — you get the full arc: who raised it, why it
was deferred, what triggers should bring it back.

The core verb is **carve** ("刻"). Capturing a decision is carving it
into the stele — present-tense, deliberate, hard to erase.

## Browser UI tour

`stele serve` opens a local web UI (or use the always-on daemon at
`http://127.0.0.1:3939`). Bookmark it — it's a real entry point you can
come back to, not a one-shot HTML export.

```bash
stele serve                    # http://127.0.0.1:3939 (single-project mode)
stele serve --multi            # multi-tenant mode (what the daemon runs)
stele serve --port 4000        # non-default port
stele serve --open             # also opens your default browser
```

Pages you'll use:

- **Projects** (`/`) — overview of every registered project.
- **Project** (`/<slug>/`) — feature rail on the left, selected feature
  on the right with session timeline and decision chips. Each decision
  chip shows a coloured source pill: warm for `agent-live`, amber for
  `session-extract`, none for `manual`. Filter the rail with
  `?src=session-extract` for batch review of post-hoc captures.
- **Trace** (`/<slug>/trace/<id>`) — focal decision card plus its graph
  neighbourhood (depends_on / relates / resolves / supersedes /
  reconciles).
- **Tags** (`/<slug>/tags/`) — tag policy panel, pending proposals,
  active / archived tags. Rename, recolor, archive, restore.
- **Decision Graph** (`/<slug>/graph/`) — interactive whole-project
  graph view.

The server listens on `127.0.0.1` only — no external access. All
three surfaces (CLI, MCP, web) read and write the same
`.stele/decisions.db`, so a capture from Claude Code shows up on
browser refresh.

## Cross-project view

Stele resolves the decision store by walking up from cwd looking for a
`.stele/` directory (like git looks for `.git/`). If you organize
multiple projects under one parent, `stele init` in the parent gives
you a unified store across all of them:

```bash
cd ~/projects        # contains foo/, bar/, baz/
stele init           # one .stele/ here
claude               # decisions captured from any subdirectory roll up here
```

The walk stops at `$HOME`, so a project under `~/projects/foo/` never
silently picks up `~/.stele/` — you have to opt in explicitly.

## CLI reference

```
stele --version                                  print version

# Bootstrap
stele init [--port N] [--skip-daemon] [--skip-hooks]
           [--enable-session-end-auto-extract]
                                                 set up everything for a project

# Daemon
stele daemon <install|uninstall|status>          always-on multi-tenant serve

# Hooks + skill
stele hooks <install|uninstall|status>           SessionStart hook + skill + slash commands
stele hooks enable session-end-auto-extract      opt into Layer 3 auto-capture
stele hooks disable session-end-auto-extract     opt out of Layer 3 auto-capture

# Project registry
stele projects <list|remove <slug>>              view/manage the global project registry
stele project <show|set-status>                  the current project's metadata

# Domain entities
stele features <list|open|show|set-state|report>
                                                 features (the 0.3.0 rename of "milestones")
stele sessions <list|start|end|resume|continue>  session lifecycle (sessions also auto-bucket
                                                 inside decision_capture)
stele tags <list|propose|apply|confirm|reject|recolor|rename|archive|restore|proposals>
                                                 cross-cutting labels
stele config <list|get|set>                      per-project preferences (e.g. tag_policy)

# Queries
stele resume [--for-context] [--html out.html]   what's waiting on me
stele trace <id>                                 a decision + its graph neighbourhood
stele trace-entity <kind> <id>                   everything touching an entity (file/feature/skill...)
stele list                                       all decisions by nodeState

# Edges
stele resolve <byId> <defId> [note]              manually stitch a later decision as resolving an old one
stele relate <a> <b> [note]                      link two decisions
stele depends-on <from> <to> [note]              author a depends_on edge

# Other
stele serve [--multi] [--port N] [--open]        browser UI (default http://127.0.0.1:3939)
stele add                                        capture from stdin JSON (matches decision_capture shape)
```

## Tags

Tags are cross-cutting labels (`security`, `backend`, `perf`, ...)
that attach to both decisions and features. They live alongside
features, not instead of them — feature is "what big push is this part
of?", tag is "what cross-cutting concerns does this touch?".

The agent doesn't get free reign over the namespace. The per-project
`tag_policy` config decides what happens when the agent reaches for a
name that doesn't exist yet:

| Policy   | What new agent-proposed tags do                                                |
| -------- | ------------------------------------------------------------------------------ |
| `auto`   | created immediately, `origin='agent'`, audit-logged                            |
| `propose` | queued into `tag_proposals` for your `stele tags confirm` (default)           |
| `locked` | refused outright; attempt logged as `blocked`                                  |

Existing tags get re-applied regardless of policy — the gate is on
creation, not reuse.

```bash
stele config list                                # see current policy
stele config set tag_policy auto                 # trust the agent fully
stele tags list                                  # all active tags
stele tags proposals                             # what the agent has suggested
stele tags confirm tp-abc12345                   # accept a proposal → becomes active
stele tags reject  tp-abc12345                   # drop a proposal
stele tags propose security --reason "OWASP" --target decision:F-01/D-9
```

In `decision_capture`, the agent can pass `tags: [{name, reason?}, ...]`
to tag the new decision in one round-trip. Each name flows through the
policy engine, and the capture result tells you which landed, which are
pending, and which were blocked.

## Main language

If you want every captured decision written in a specific language
regardless of what language you're chatting in, set:

```bash
stele config set main_language 中文
stele config set main_language English
stele config set main_language "中文，专有名词保留英文"   # free-text, the agent reads it
```

The next time Claude Code opens a session in this project, the
SessionStart hook injects the setting plus the rule:

> 自由文本字段 (title / context / detail.* / summary / rationale) 一律用此语言;
> technical terms, IDs, file paths, code identifiers, proper nouns — preserve as-is.

So `title` and `context` land in your chosen language while file paths,
schema field names, command names, and ids stay verbatim. Unset (the
default) means the agent uses whatever language the conversation is
in — no change from before.

To clear:

```bash
stele config set main_language ""
```

## Backup

`.stele/decisions.db` is a regular SQLite file. While no MCP server is
connected, `cp` is safe. For a hot backup:

```bash
sqlite3 .stele/decisions.db ".backup /backup/path.db"
```

## Override the store location

If you want to pin a specific DB regardless of cwd:

```bash
STELE_DB=/abs/path/decisions.db stele resume
```

Or in `.mcp.json`:

```jsonc
{ "mcpServers": { "stele": {
  "command": "stele-mcp",
  "env": { "STELE_DB": "/abs/path/decisions.db" }
}}}
```

## Upgrading from 0.3.x

- DB schema is additive — existing 0.3.x stores open unchanged. New
  rows get `source` / `confidence` / `dedupKey`; legacy rows decode
  as `source='manual'` implicitly.
- Re-run `stele hooks install` in projects upgraded from 0.3.x to
  pick up the SessionStart hook and the `requiredMinimumVersion: "2.1.0"`
  pin in `.claude/settings.json`.
- The legacy `/decision` / `/milestone-report` / `/resume` slash
  commands are cleaned up automatically — both project-level and the
  user-level `~/.claude/commands/` versions (with a content-fingerprint
  guard so commands by the same name from other tools survive).
- The earlier Stop hook is gone. If your project has a leftover
  `.claude/hooks/stele-stop.sh`, re-running `stele hooks install` deletes
  it and scrubs the corresponding entry from `.claude/settings.json`.

---

## More

- **Why this exists**, the design rationale — [ProductDesign.md](./ProductDesign.md)
- **Brand & naming** — [naming-stele.md](./naming-stele.md)
- **Contributing / running from source** — [DEVELOPING.md](./DEVELOPING.md)
- **Full release notes** — [CHANGELOG.md](./CHANGELOG.md)
