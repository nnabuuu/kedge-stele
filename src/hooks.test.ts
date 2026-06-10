// Tests for src/hooks.ts — the project-level hook + skill installer.
//
// THE bug we want to never ship again: 0.0.1-snapshot wrote
//   { type: "command", command: "..." }
// directly into the Stop array, but Claude Code's real schema is
//   { matcher: "", hooks: [{ type, command }, ...] }
// /doctor caught it, we shipped 0.0.2. These tests pin the correct shape.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hooksStatus, installHooks, uninstallHooks } from "./hooks.ts";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "stele-hooks-test-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function settingsPath(): string {
  return join(projectDir, ".claude/settings.json");
}

function readSettings(): any {
  return JSON.parse(readFileSync(settingsPath(), "utf8"));
}

// ---- Fresh install -------------------------------------------------------

test("install writes hook script, executable", () => {
  installHooks(projectDir);
  const hookPath = join(projectDir, ".claude/hooks/stele-stop.sh");
  assert.ok(existsSync(hookPath), "hook script missing");
  // Check mode bit (0o100755 → executable)
  const mode = statSync(hookPath).mode & 0o777;
  assert.equal(mode & 0o100, 0o100, "owner exec bit not set");
});

test("install writes skill file with frontmatter", () => {
  installHooks(projectDir);
  const skillPath = join(projectDir, ".claude/skills/stele-capture/SKILL.md");
  assert.ok(existsSync(skillPath), "skill file missing");
  const content = readFileSync(skillPath, "utf8");
  assert.ok(content.startsWith("---"), "skill missing YAML frontmatter");
  assert.ok(content.includes("name: stele-capture"));
});

test("install writes the full skill folder (SKILL.md + gotchas + references)", () => {
  installHooks(projectDir);
  const root = join(projectDir, ".claude/skills/stele-capture");
  assert.ok(existsSync(join(root, "SKILL.md")));
  assert.ok(existsSync(join(root, "gotchas.md")));
  assert.ok(existsSync(join(root, "references/decision-schema.md")));
  assert.ok(existsSync(join(root, "references/feature-judgment.md")));
  assert.ok(existsSync(join(root, "references/tag-judgment.md")));
  // 0.3.0 dropped the umbrella; milestone-judgment.md is retired.
  assert.equal(
    existsSync(join(root, "references/milestone-judgment.md")),
    false,
    "0.3.0 retired milestone-judgment.md but it's still being installed",
  );
});

test("re-install replaces stale files (no leftover references from prior versions)", () => {
  installHooks(projectDir);
  // Plant a stale file under references/ that ISN'T in the current template set
  const stale = join(projectDir, ".claude/skills/stele-capture/references/STALE.md");
  writeFileSync(stale, "leftover from a prior install");
  // Re-install: the stale file must be cleaned up
  installHooks(projectDir);
  assert.equal(existsSync(stale), false, "stale references file survived re-install");
});

test("install writes /stele:feature command if missing, leaves it if present", () => {
  // First install: writes
  installHooks(projectDir);
  const cmdPath = join(projectDir, ".claude/commands/stele/feature.md");
  assert.ok(existsSync(cmdPath), "stele/feature.md missing");
  // Pre-set custom content, reinstall, should preserve
  writeFileSync(cmdPath, "USER CUSTOMIZED");
  installHooks(projectDir);
  assert.equal(readFileSync(cmdPath, "utf8"), "USER CUSTOMIZED");
});

test("install cleans up legacy 0.2.x command files", () => {
  // Simulate a project upgraded from 0.2.x: old commands sitting in
  // .claude/commands/ from a prior `stele init`.
  const cmdsDir = join(projectDir, ".claude/commands");
  mkdirSync(cmdsDir, { recursive: true });
  writeFileSync(join(cmdsDir, "decision.md"), "old /decision command body");
  writeFileSync(join(cmdsDir, "milestone-report.md"), "old /milestone-report body");
  writeFileSync(join(cmdsDir, "resume.md"), "old /resume body");

  installHooks(projectDir);

  assert.equal(existsSync(join(cmdsDir, "decision.md")), false, "legacy /decision survived install");
  assert.equal(existsSync(join(cmdsDir, "milestone-report.md")), false, "legacy /milestone-report survived install");
  assert.equal(existsSync(join(cmdsDir, "resume.md")), false, "legacy /resume survived install");
  // ...and the new command landed
  assert.ok(existsSync(join(cmdsDir, "stele/feature.md")), "new /stele:feature didn't write");
});

// ---- THE settings.json regression --------------------------------------

test("install writes CORRECT nested { matcher, hooks: [...] } shape", () => {
  installHooks(projectDir);
  const s = readSettings();
  assert.ok(s.hooks, "no hooks key");
  assert.ok(Array.isArray(s.hooks.Stop), "Stop not array");
  assert.equal(s.hooks.Stop.length, 1);
  const entry = s.hooks.Stop[0];
  assert.equal(typeof entry.matcher, "string", "missing matcher field — THIS WAS THE 0.0.1 BUG");
  assert.ok(Array.isArray(entry.hooks), "missing nested hooks array — THIS WAS THE 0.0.1 BUG");
  assert.equal(entry.hooks[0].type, "command");
  assert.ok(entry.hooks[0].command.endsWith("stele-stop.sh"));
});

test("install does NOT write the flat { type, command } shape (0.0.1 bug)", () => {
  installHooks(projectDir);
  const s = readSettings();
  // Top-level Stop entry must NOT have a direct `command` field
  const entry = s.hooks.Stop[0];
  assert.equal(
    entry.command,
    undefined,
    "Stop entry has top-level command — the 0.0.1 broken shape is back",
  );
});

// ---- Heal-from-broken on reinstall -------------------------------------

test("reinstall on 0.0.1 broken shape heals to correct shape", () => {
  // Plant the buggy 0.0.1-style settings.json
  const claudeDir = join(projectDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    settingsPath(),
    JSON.stringify(
      {
        hooks: {
          Stop: [
            // Buggy 0.0.1 shape
            { type: "command", command: ".claude/hooks/stele-stop.sh" },
          ],
        },
      },
      null,
      2,
    ),
  );

  installHooks(projectDir);

  const s = readSettings();
  assert.equal(s.hooks.Stop.length, 1, "should still have ONE entry, not duplicate");
  const entry = s.hooks.Stop[0];
  assert.equal(typeof entry.matcher, "string", "didn't heal to nested shape");
  assert.ok(Array.isArray(entry.hooks));
  assert.equal(entry.hooks[0].command, ".claude/hooks/stele-stop.sh");
});

// ---- Merge with unrelated hooks ----------------------------------------

test("install preserves unrelated Stop hooks AND other event hooks", () => {
  const claudeDir = join(projectDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    settingsPath(),
    JSON.stringify(
      {
        hooks: {
          Stop: [{ matcher: "", hooks: [{ type: "command", command: "other-script.sh" }] }],
          PostToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] },
          ],
        },
        otherTopLevelKey: "stays here",
      },
      null,
      2,
    ),
  );

  installHooks(projectDir);

  const s = readSettings();
  assert.equal(s.otherTopLevelKey, "stays here", "top-level keys clobbered");
  assert.equal(s.hooks.Stop.length, 2, "other Stop entries lost");
  assert.equal(s.hooks.PostToolUse.length, 1, "PostToolUse hook lost");
  assert.equal(s.hooks.PostToolUse[0].hooks[0].command, "audit.sh");
});

// ---- Uninstall ---------------------------------------------------------

test("uninstall removes hook script + skill dir, leaves /stele:feature command", () => {
  installHooks(projectDir);
  uninstallHooks(projectDir);
  assert.equal(
    existsSync(join(projectDir, ".claude/hooks/stele-stop.sh")),
    false,
    "hook script not removed",
  );
  assert.equal(
    existsSync(join(projectDir, ".claude/skills/stele-capture")),
    false,
    "skill dir not removed",
  );
  // /stele:feature should stay (user may have customized)
  assert.ok(
    existsSync(join(projectDir, ".claude/commands/stele/feature.md")),
    "command removed unexpectedly",
  );
});

test("uninstall removes the stele Stop entry, preserves others", () => {
  installHooks(projectDir);
  // Manually add an extra entry
  const s = readSettings();
  s.hooks.Stop.push({ matcher: "", hooks: [{ type: "command", command: "other.sh" }] });
  writeFileSync(settingsPath(), JSON.stringify(s, null, 2));

  uninstallHooks(projectDir);

  const after = readSettings();
  assert.equal(after.hooks.Stop.length, 1);
  assert.equal(after.hooks.Stop[0].hooks[0].command, "other.sh");
});

test("uninstall also handles the OLD broken shape", () => {
  // Plant broken 0.0.1 entry directly (without installing first)
  const claudeDir = join(projectDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    settingsPath(),
    JSON.stringify(
      {
        hooks: {
          Stop: [
            { type: "command", command: ".claude/hooks/stele-stop.sh" }, // broken shape
            { matcher: "", hooks: [{ type: "command", command: "other.sh" }] },
          ],
        },
      },
      null,
      2,
    ),
  );

  uninstallHooks(projectDir);

  const s = readSettings();
  assert.equal(s.hooks.Stop.length, 1, "broken-shape stele entry not removed");
  assert.equal(s.hooks.Stop[0].hooks[0].command, "other.sh");
});

// ---- Status ------------------------------------------------------------

test("status reports ✗ on fresh dir, ✓ after install", () => {
  let s = hooksStatus(projectDir);
  assert.equal(s.hook, false);
  assert.equal(s.sessionStartHook, false);
  assert.equal(s.skill, false);
  assert.equal(s.steleFeature, false);
  assert.equal(s.settingsHasEntry, false);
  assert.equal(s.settingsHasMinVersion, false);

  installHooks(projectDir);
  s = hooksStatus(projectDir);
  assert.equal(s.hook, true);
  assert.equal(s.sessionStartHook, true);
  assert.equal(s.skill, true);
  assert.equal(s.steleFeature, true);
  assert.equal(s.settingsHasEntry, true);
  assert.equal(s.settingsHasMinVersion, true);
});

// ---- 0.4.0 — SessionStart hook + requiredMinimumVersion ----------------

test("install writes SessionStart hook script, executable", () => {
  installHooks(projectDir);
  const hookPath = join(projectDir, ".claude/hooks/stele-session-start.sh");
  assert.ok(existsSync(hookPath), "SessionStart hook script missing");
  const mode = statSync(hookPath).mode & 0o777;
  assert.equal(mode & 0o100, 0o100, "owner exec bit not set on SessionStart hook");
});

test("install merges SessionStart entry into settings.json", () => {
  installHooks(projectDir);
  const s = readSettings();
  assert.ok(Array.isArray(s.hooks.SessionStart), "SessionStart not an array");
  assert.equal(s.hooks.SessionStart.length, 1);
  const entry = s.hooks.SessionStart[0];
  assert.equal(typeof entry.matcher, "string");
  assert.ok(Array.isArray(entry.hooks));
  assert.equal(entry.hooks[0].type, "command");
  assert.ok(entry.hooks[0].command.endsWith("stele-session-start.sh"));
});

test("install pins requiredMinimumVersion to 2.1.0", () => {
  installHooks(projectDir);
  const s = readSettings();
  assert.equal(s.requiredMinimumVersion, "2.1.0",
    "requiredMinimumVersion must pin the async-hook floor");
});

test("install preserves a pre-existing requiredMinimumVersion if it's already at 2.1.0", () => {
  // Pre-existing 2.1.0 pin shouldn't trigger an update note path.
  const claudeDir = join(projectDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    settingsPath(),
    JSON.stringify({ requiredMinimumVersion: "2.1.0", otherKey: "stays" }, null, 2),
  );
  installHooks(projectDir);
  const s = readSettings();
  assert.equal(s.requiredMinimumVersion, "2.1.0");
  assert.equal(s.otherKey, "stays");
});

test("install overwrites a lower requiredMinimumVersion", () => {
  // User has a lower pin; we raise it to the async-hook floor.
  const claudeDir = join(projectDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    settingsPath(),
    JSON.stringify({ requiredMinimumVersion: "1.9.0" }, null, 2),
  );
  installHooks(projectDir);
  const s = readSettings();
  assert.equal(s.requiredMinimumVersion, "2.1.0");
});

test("install preserves unrelated SessionStart hooks (other extensions)", () => {
  const claudeDir = join(projectDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    settingsPath(),
    JSON.stringify(
      {
        hooks: {
          SessionStart: [
            { matcher: "", hooks: [{ type: "command", command: "other-session-script.sh" }] },
          ],
        },
      },
      null,
      2,
    ),
  );
  installHooks(projectDir);
  const s = readSettings();
  assert.equal(s.hooks.SessionStart.length, 2,
    "other SessionStart entries lost");
  // The other entry survives and the stele entry is alongside it.
  const others = s.hooks.SessionStart.filter((e: any) =>
    e.hooks?.[0]?.command === "other-session-script.sh");
  assert.equal(others.length, 1, "non-stele SessionStart entry survived");
});

test("uninstall removes the SessionStart hook script + settings entry", () => {
  installHooks(projectDir);
  uninstallHooks(projectDir);
  assert.equal(
    existsSync(join(projectDir, ".claude/hooks/stele-session-start.sh")),
    false,
    "SessionStart hook script not removed",
  );
  const s = readSettings();
  // SessionStart array becomes empty → key deleted by the unmerger.
  assert.equal(
    Array.isArray(s.hooks.SessionStart) && s.hooks.SessionStart.length > 0,
    false,
    "stele SessionStart entry not removed",
  );
});

test("uninstall leaves requiredMinimumVersion in place", () => {
  installHooks(projectDir);
  uninstallHooks(projectDir);
  const s = readSettings();
  // Other hooks the project might have could still depend on the version pin —
  // we don't yank it on uninstall. The user can drop it manually if they want.
  assert.equal(s.requiredMinimumVersion, "2.1.0");
});

test("reinstall is idempotent: SessionStart count stays at 1", () => {
  installHooks(projectDir);
  installHooks(projectDir);
  installHooks(projectDir);
  const s = readSettings();
  assert.equal(s.hooks.SessionStart.length, 1,
    "duplicate SessionStart entries piled up across reinstalls");
});

// ---- 0.4.0 phase 4 — SessionEnd extract agent + hook entry --------------

test("install writes the stele-extract agent file", () => {
  installHooks(projectDir);
  const agentPath = join(projectDir, ".claude/agents/stele-extract.md");
  assert.ok(existsSync(agentPath), "stele-extract.md missing");
  const content = readFileSync(agentPath, "utf8");
  assert.ok(content.startsWith("---"), "agent missing YAML frontmatter");
  assert.ok(content.includes("name: stele-extract"));
  assert.ok(content.includes("allowed_tools:"),
    "agent must declare allowed_tools (mcp__stele__decision_capture etc.)");
});

test("install merges SessionEnd agent-type entry into settings.json with async:true", () => {
  installHooks(projectDir);
  const s = readSettings();
  assert.ok(Array.isArray(s.hooks.SessionEnd), "SessionEnd not an array");
  assert.equal(s.hooks.SessionEnd.length, 1);
  const entry = s.hooks.SessionEnd[0];
  assert.equal(typeof entry.matcher, "string");
  assert.ok(Array.isArray(entry.hooks));
  const inner = entry.hooks[0];
  assert.equal(inner.type, "agent",
    "SessionEnd must be agent-type, not command-type");
  assert.equal(inner.agent, ".claude/agents/stele-extract.md",
    "SessionEnd entry must point at the project-relative agent file");
  assert.equal(inner.async, true,
    "async:true is load-bearing — without it the hook would block session close");
});

test("status reports the extract agent + SessionEnd entry", () => {
  let s = hooksStatus(projectDir);
  assert.equal(s.extractAgent, false);

  installHooks(projectDir);
  s = hooksStatus(projectDir);
  assert.equal(s.extractAgent, true);
  assert.equal(s.settingsHasEntry, true,
    "settingsHasAnyEntry should still fire — covers Stop OR SessionStart OR SessionEnd");
});

test("reinstall is idempotent: SessionEnd count stays at 1", () => {
  installHooks(projectDir);
  installHooks(projectDir);
  installHooks(projectDir);
  const s = readSettings();
  assert.equal(s.hooks.SessionEnd.length, 1,
    "duplicate SessionEnd entries piled up across reinstalls");
});

test("install preserves unrelated SessionEnd entries (other extensions)", () => {
  const claudeDir = join(projectDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    settingsPath(),
    JSON.stringify(
      {
        hooks: {
          SessionEnd: [
            { matcher: "", hooks: [{ type: "command", command: "other-session-end.sh" }] },
          ],
        },
      },
      null,
      2,
    ),
  );
  installHooks(projectDir);
  const s = readSettings();
  assert.equal(s.hooks.SessionEnd.length, 2,
    "other SessionEnd entries lost");
  const others = s.hooks.SessionEnd.filter((e: any) =>
    e.hooks?.[0]?.command === "other-session-end.sh");
  assert.equal(others.length, 1, "non-stele SessionEnd entry survived");
});

test("uninstall removes the extract agent file + SessionEnd entry", () => {
  installHooks(projectDir);
  uninstallHooks(projectDir);
  assert.equal(
    existsSync(join(projectDir, ".claude/agents/stele-extract.md")),
    false,
    "extract agent file not removed",
  );
  const s = readSettings();
  assert.equal(
    Array.isArray(s.hooks.SessionEnd) && s.hooks.SessionEnd.length > 0,
    false,
    "stele SessionEnd entry not removed",
  );
});

test("install replaces the extract agent file wholesale (no stale content)", () => {
  installHooks(projectDir);
  const agentPath = join(projectDir, ".claude/agents/stele-extract.md");
  // Mutate the installed copy — simulating drift from a prior version's template
  writeFileSync(agentPath, "STALE CONTENT FROM PRIOR VERSION");
  installHooks(projectDir);
  const content = readFileSync(agentPath, "utf8");
  assert.ok(content.startsWith("---"),
    "extract agent must be re-written from template on every install");
  assert.ok(!content.includes("STALE CONTENT"),
    "stale agent content survived reinstall — overwrite missed");
});
