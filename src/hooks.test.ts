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

test("install writes slash command if missing, leaves it if present", () => {
  // First install: writes
  installHooks(projectDir);
  const cmdPath = join(projectDir, ".claude/commands/decision.md");
  assert.ok(existsSync(cmdPath));
  // Pre-set custom content, reinstall, should preserve
  writeFileSync(cmdPath, "USER CUSTOMIZED");
  installHooks(projectDir);
  assert.equal(readFileSync(cmdPath, "utf8"), "USER CUSTOMIZED");
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

test("uninstall removes hook script + skill dir, leaves /decision command", () => {
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
  // /decision should stay (user may have customized)
  assert.ok(
    existsSync(join(projectDir, ".claude/commands/decision.md")),
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
  assert.equal(s.skill, false);
  assert.equal(s.settingsHasEntry, false);

  installHooks(projectDir);
  s = hooksStatus(projectDir);
  assert.equal(s.hook, true);
  assert.equal(s.skill, true);
  assert.equal(s.command, true);
  assert.equal(s.settingsHasEntry, true);
});
