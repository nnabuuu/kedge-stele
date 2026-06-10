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
  assert.equal(s.skill, false);
  assert.equal(s.steleFeature, false);
  assert.equal(s.settingsHasEntry, false);

  installHooks(projectDir);
  s = hooksStatus(projectDir);
  assert.equal(s.hook, true);
  assert.equal(s.skill, true);
  assert.equal(s.steleFeature, true);
  assert.equal(s.settingsHasEntry, true);
});
