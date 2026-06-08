# 实录 · Stele

> *Carve decisions as they're made, traceable ever after.*

A local decision-provenance store for Claude Code. When a decision
crystallizes in conversation — what you chose, what you rejected, what
you deferred, what's still open — type `/decision` and the agent carves
it into a structured graph. Later, ask "what's waiting on me?" and the
unresolved loops come back in seconds.

The atom is the **decision**, not the report. A `deferred` item from
three weeks ago that a later decision resolves updates everywhere
automatically, because every view is a live query over the graph, never
a frozen snapshot.

---

## Install

Requires **Node ≥ 22.6** (any modern Node works; no Python, no Docker).

```bash
npm install -g stele-mcp
```

This puts two commands on your PATH:
- `stele` — CLI for inspecting and editing the decision store
- `stele-mcp` — the MCP server that Claude Code talks to

## Bootstrap a project

In any project where you want to track decisions:

```bash
cd /path/to/your-project
stele init
```

This creates `.stele/` (the decision store for this project), writes a
`.mcp.json` so Claude Code in this directory sees the `stele` MCP server,
and adds `.stele/` to your `.gitignore`.

**Restart Claude Code** in that directory. Four tools become available:
`decision_capture`, `decision_resume`, `decision_trace`, `decision_resolve`.

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
stele init                          create .stele/ + .mcp.json in this project
stele resume [--html out.html]      what's waiting on me — open loops, needs-check first
stele trace <id>                    a decision + its graph neighbourhood
stele trace-entity <kind> <id>      everything touching an entity (file/feature/skill...)
stele list                          all decisions by status
stele resolve <byId> <defId> [note] manually stitch a later decision as resolving an old one
stele relate <a> <b> [note]         link two decisions
stele seed <report.html>            cold-start: ingest an HTML feature-report
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

---

## More

- **Why this exists**, the design rationale — [ProductDesign.md](./ProductDesign.md)
- **Brand & naming** — [naming-stele.md](./naming-stele.md)
- **Contributing / running from source** — [DEVELOPING.md](./DEVELOPING.md)
