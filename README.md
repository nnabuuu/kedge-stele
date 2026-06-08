# 实录 · Stele

> *Carve decisions as they're made, traceable ever after.*

> **Status: alpha snapshot release** — API may shift, not yet
> semver-stable. Pinned to the `snapshot` dist-tag on npm; install
> explicitly with `npm install -g stele-mcp@snapshot`.

A local decision-provenance store for Claude Code. When a decision
crystallizes in conversation — what you chose, what you rejected, what
you deferred, what's still open — type `/decision` and the agent carves
it into a structured graph. Later, ask "what's waiting on me?" and the
unresolved loops come back in seconds.

The atom is the **decision**, not the report. A `deferred` item from
three weeks ago that a later decision resolves updates everywhere
automatically, because every view is a live query over the graph, never
a frozen snapshot.

Decisions roll up into **sessions** (one Claude Code / Codex / OpenCode
conversation) which roll up into **milestones** (an aspirational goal
like "ship multi-tenant daemon"). The stele-capture skill decides at
each capture whether you're continuing an active milestone or kicking
off a new one — you don't manage this manually.

---

## Install

Requires **Node ≥ 22.6** (any modern Node works; no Python, no Docker).

```bash
npm install -g stele-mcp@snapshot
```

This puts two commands on your PATH:
- `stele` — CLI for inspecting and editing the decision store
- `stele-mcp` — the MCP server that Claude Code talks to

> **Windows users**: the Stop hook that auto-detects decisions is a
> bash script. Install WSL to use it, or pass `--skip-hooks` to
> `stele init` and use `/decision` manually instead. (Native Windows
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
  `stele serve` alive at `http://127.0.0.1:3939` across reboots
- **Stop hook + skill** — Claude Code is nudged to capture decisions when a
  conversation reaches one (see "Auto-detect decisions" below)

Pass `--port N` to pick a non-default port. Pass `--skip-daemon` or
`--skip-hooks` to opt out of either integration. The MCP tools
(`decision_capture`, `decision_resume`, `decision_trace`, `decision_resolve`)
become available in Claude Code after a restart.

## Always-on browser UI

`stele init` installs a single multi-tenant daemon that serves every
registered project at the same URL:

```
http://127.0.0.1:3939/                     ← overview of all projects
http://127.0.0.1:3939/<slug>/              ← that project's resume
http://127.0.0.1:3939/<slug>/decisions/    ← that project's full list
```

One daemon, one URL to bookmark, one process to manage. As you `stele init`
in more projects, each one registers in `~/.stele/registry.json` (slug
defaults to the directory's basename; collisions get `-2`/`-3` suffixes)
and shows up as a new card on the overview without a daemon restart.

- macOS → `~/Library/LaunchAgents/com.stele.daemon.plist` (launchd)
- Linux → `~/.config/systemd/user/stele-daemon.service` (systemd user)

Manage with:

```bash
stele daemon status                # is it loaded? how many projects?
stele daemon install               # idempotent — also sweeps legacy plists
stele daemon uninstall             # remove the unit + unload
stele projects list                # registry contents
stele projects remove <slug>       # forget a project (doesn't delete .stele/)
```

Logs live at `~/.stele/daemon.log` and `daemon.err.log`.

> **Linux**: services run only while you're logged in. For true always-on,
> run `sudo loginctl enable-linger <you>` (one-time, system level).
> **Upgrading from 0.0.2**: `stele daemon install` automatically removes
> the old per-project plists/units (`com.stele.<hash>`) and registers their
> working directories into the global registry, so no decisions go missing.

## Auto-detect decisions

`stele init` also installs a Stop hook (`.claude/hooks/stele-stop.sh`) and a
project-level skill (`.claude/skills/stele-capture/`). The hook scans
Claude's reply at the end of every turn for decision-y language ("we decided
to…", "let's defer…", "我们决定…", "锁定了…"). On a hit, it injects a
gentle reminder into Claude's next turn pointing at the skill, which knows
how to draft and capture a full `CapturePayload`.

This makes the write path **proactive**: Claude offers to carve the
decision when one happens, rather than you having to remember to type
`/decision`. The skill is conservative — if no real decision crystallized,
it stays silent.

Manage with:

```bash
stele hooks status
stele hooks uninstall              # remove just the auto-detection
stele hooks install                # reinstall
```

You can still type `/decision` manually whenever — the slash command and
the auto-detected skill share the same script.

## Daily use

```
discuss a design in Claude Code
   ↓
type /decision when something just got decided
   ↓
agent reads conversation → drafts the record → captures it
   ↓
agent shows you what it captured + any related edges it proposes
```

After time away, start a new session and ask:

> what's waiting on me?

The agent calls `decision_resume`. You see every open + un-resolved
deferred node, with the most-likely-due ones first. Pick one and ask the
agent to **trace** it — you get the full arc: who raised it, why it was
deferred, what triggers should bring it back.

The core verb is **carve** ("刻"). Capturing a decision is carving it
into the stele — present-tense, deliberate, hard to erase.

> The `/decision` slash command isn't installed by `stele init`. Install
> it once globally by copying `.claude/commands/decision.md` from this
> repository into `~/.claude/commands/`, or set it up your own way.

## Browser UI

`stele serve` opens a local web UI at `http://127.0.0.1:3939`. Bookmark
it — it's a real entry point you can come back to, not a one-shot HTML
export.

```bash
stele serve            # http://127.0.0.1:3939
stele serve --open     # also opens your default browser
stele serve --port 4000
```

What you can do in the UI:
- See "什么在等我" — the resume digest, live
- Browse every decision in the project, grouped by status
- Open any node, see its full graph neighbourhood (which edges connect
  where), affects, consequences
- **Capture a new decision** from a form — full Decision shape including
  options, structured deferred-triggers, affects. Server validates with
  the same schema MCP uses.
- Stitch edges: resolve a deferred node by a later one; relate two
  decisions; mark a node superseded.

Keyboard (Linear-style):

| | |
|---|---|
| `g r` | resume |
| `g a` | all decisions |
| `c` | capture a new decision |
| `/` | search (id or title) |
| `esc` | close modal |

The server listens on `127.0.0.1` only — no external access. Three
surfaces (CLI, MCP, web) all read and write the same `.stele/decisions.db`,
so changes from Claude Code show up on browser refresh.

## Cross-project view

stele resolves the decision store by walking up from cwd looking for a
`.stele/` directory (like git looks for `.git/`). If you organize
multiple projects under one parent, `stele init` in the parent gives you
a unified store across all of them:

```bash
cd ~/projects        # contains foo/, bar/, baz/
stele init           # one .stele/ here
claude               # decisions captured from any subdirectory roll up here
```

The walk stops at `$HOME`, so a project under `~/projects/foo/` never
silently picks up `~/.stele/` — you have to opt in explicitly.

## CLI reference

```
stele init [--port N] [--skip-daemon] [--skip-hooks]
                                    bootstrap a project: .stele/, .mcp.json, register, daemon, hooks
stele daemon <install|uninstall|status>  always-on multi-tenant serve via launchd / systemd
stele projects <list|remove <slug>>      view/manage the global project registry
stele milestones <list|open|close|show>  0.0.6+: group decisions by milestone + session
stele tags <list|propose|apply|confirm|reject|recolor|rename|archive|restore|proposals>
                                    0.0.7+: cross-cutting labels for milestones/decisions
stele config <list|get|set>         0.0.7+: per-project preferences (e.g. tag_policy)
stele hooks <install|uninstall|status>   Stop hook + stele-capture skill
stele serve [--multi] [--port N] [--open]   browser UI (default http://127.0.0.1:3939)
stele resume [--html out.html]      what's waiting on me — open loops, needs-check first
stele trace <id>                    a decision + its graph neighbourhood
stele trace-entity <kind> <id>      everything touching an entity (file/feature/skill...)
stele list                          all decisions by status
stele resolve <byId> <defId> [note] manually stitch a later decision as resolving an old one
stele relate <a> <b> [note]         link two decisions
stele seed <report.html>            cold-start: ingest an HTML feature-report
```

## Tags (0.0.7+)

Tags are cross-cutting labels (`security`, `backend`, `perf`, ...) that
attach to both decisions and milestones. They live alongside milestones,
not instead of them — milestone is "what big push is this part of?",
tag is "what cross-cutting concerns does this touch?".

The agent doesn't get free reign over the namespace. The per-project
`tag_policy` config decides what happens when the agent reaches for a
name that doesn't exist yet:

| Policy   | What new agent-proposed tags do                                                |
| -------- | ------------------------------------------------------------------------------ |
| `auto`   | created immediately, `origin='agent'`, audit-logged                            |
| `propose` | queued into `tag_proposals` for your `stele tags confirm` (default)            |
| `locked` | refused outright; attempt logged as `blocked`                                  |

Existing tags get re-applied regardless of policy — the gate is on
creation, not reuse.

```bash
stele config list                    # see current policy
stele config set tag_policy auto     # trust the agent fully
stele tags list                      # all active tags
stele tags proposals                 # what the agent has suggested
stele tags confirm tp-abc12345       # accept a proposal → becomes active
stele tags reject  tp-abc12345       # drop a proposal
stele tags propose security --reason "OWASP" --target decision:D-9
```

In `decision_capture`, the agent can pass `tags: [{name, reason?}, ...]`
to tag the new decision in one round-trip. Each name flows through the
policy engine, and the capture result tells you which landed, which are
pending, and which were blocked.

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

---

## More

- **Why this exists**, the design rationale — [ProductDesign.md](./ProductDesign.md)
- **Brand & naming** — [naming-stele.md](./naming-stele.md)
- **Contributing / running from source** — [DEVELOPING.md](./DEVELOPING.md)
