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

// 0.4.0-snapshot.10 — the Stop hook is gone. The regex-based per-turn
// detector retired; the live agent self-governs via the stele-capture
// skill. Install MUST NOT create the .sh, and MUST remove any leftover
// from prior snapshots.

test("install does NOT write the legacy Stop hook script", () => {
  installHooks(projectDir);
  assert.equal(
    existsSync(join(projectDir, ".claude/hooks/stele-stop.sh")),
    false,
    "0.4.0-snapshot.10 retired the Stop hook — installer must not write it",
  );
});

test("install removes a legacy Stop hook script if one is present (upgrade)", () => {
  // Simulate a project upgraded from an earlier snapshot that had the
  // Stop hook installed.
  mkdirSync(join(projectDir, ".claude/hooks"), { recursive: true });
  writeFileSync(
    join(projectDir, ".claude/hooks/stele-stop.sh"),
    "#!/usr/bin/env bash\n# legacy from snapshot.3 etc.\n",
  );
  installHooks(projectDir);
  assert.equal(
    existsSync(join(projectDir, ".claude/hooks/stele-stop.sh")),
    false,
    "install must scrub the legacy Stop hook script on upgrade",
  );
});

test("install does NOT write a Stop entry in settings.json", () => {
  installHooks(projectDir);
  const s = readSettings();
  assert.equal(
    s.hooks?.Stop === undefined || (Array.isArray(s.hooks.Stop) && s.hooks.Stop.length === 0),
    true,
    "Stop entry must NOT appear in settings.json after 0.4.0-snapshot.10 install",
  );
});

test("install scrubs a previously-installed Stop entry from settings.json (upgrade)", () => {
  const claudeDir = join(projectDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    settingsPath(),
    JSON.stringify(
      {
        hooks: {
          Stop: [
            { matcher: "", hooks: [{ type: "command", command: ".claude/hooks/stele-stop.sh" }] },
          ],
        },
      },
      null,
      2,
    ),
  );
  installHooks(projectDir);
  const s = readSettings();
  assert.equal(
    s.hooks?.Stop === undefined || s.hooks.Stop.length === 0,
    true,
    "install must drop the legacy stele Stop entry on upgrade",
  );
});

test("install preserves unrelated Stop entries from other extensions", () => {
  const claudeDir = join(projectDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    settingsPath(),
    JSON.stringify(
      {
        hooks: {
          Stop: [
            { matcher: "", hooks: [{ type: "command", command: "other-script.sh" }] },
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
  assert.equal(s.otherTopLevelKey, "stays here");
  assert.equal(s.hooks.Stop.length, 1, "unrelated Stop entry was nuked");
  assert.equal(s.hooks.Stop[0].hooks[0].command, "other-script.sh");
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

// ---- User-level legacy cleanup (0.4.0-snapshot.11) -------------------
// The project-level cleanup above misses globally-installed legacy
// commands at ~/.claude/commands/. snapshot.11 extends the sweep to
// user level, but ONLY when content carries the stele fingerprint —
// the filenames (decision.md / milestone-report.md / resume.md) are
// generic enough that a user might have their own.

test("install removes stele-fingerprinted user-level legacy commands", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "stele-fake-home-"));
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const userCmdsDir = join(fakeHome, ".claude/commands");
    mkdirSync(userCmdsDir, { recursive: true });
    // Genuine stele 0.2-era /decision — carries the fingerprint
    writeFileSync(
      join(userCmdsDir, "decision.md"),
      "---\nname: decision\ndescription: Carve the decision just made into the stele (实录) store.\n---\n",
    );
    // 0.2-era /resume — also stele
    writeFileSync(
      join(userCmdsDir, "resume.md"),
      "---\nname: resume\ndescription: stele resume digest\n---\n",
    );

    installHooks(projectDir);

    assert.equal(existsSync(join(userCmdsDir, "decision.md")), false,
      "user-level /decision with stele fingerprint must be removed");
    assert.equal(existsSync(join(userCmdsDir, "resume.md")), false,
      "user-level /resume with stele fingerprint must be removed");
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("install LEAVES non-stele user-level files with the same name alone", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "stele-fake-home-"));
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const userCmdsDir = join(fakeHome, ".claude/commands");
    mkdirSync(userCmdsDir, { recursive: true });
    // User-authored /decision for a different purpose — no stele in it
    const userContent = "---\nname: decision\ndescription: My personal decision-making helper.\n---\nDo the thing.\n";
    writeFileSync(join(userCmdsDir, "decision.md"), userContent);

    installHooks(projectDir);

    assert.equal(existsSync(join(userCmdsDir, "decision.md")), true,
      "user-authored /decision (no stele fingerprint) must NOT be removed");
    assert.equal(readFileSync(join(userCmdsDir, "decision.md"), "utf8"), userContent,
      "user-authored content must not be modified");
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ---- Upgrade path — legacy 0.0.1 broken-shape Stop entries -----------
// (0.0.1 bug: { type, command } directly in the Stop array instead of
// { matcher, hooks: [...] }. 0.4.0-snapshot.10 retires the Stop hook
// entirely, so this scrubs both legacy shapes on upgrade.)

test("uninstall scrubs 0.0.1 broken-shape Stop entries", () => {
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

// ---- Uninstall ---------------------------------------------------------

test("uninstall removes the SessionStart hook + skill dir, leaves /stele:feature command", () => {
  installHooks(projectDir);
  uninstallHooks(projectDir);
  assert.equal(
    existsSync(join(projectDir, ".claude/hooks/stele-session-start.sh")),
    false,
    "SessionStart hook script not removed",
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

// ---- Status ------------------------------------------------------------

test("status reports ✗ on fresh dir, ✓ after install", () => {
  let s = hooksStatus(projectDir);
  assert.equal(s.legacyStopHookPresent, false);
  assert.equal(s.sessionStartHook, false);
  assert.equal(s.skill, false);
  assert.equal(s.steleFeature, false);
  assert.equal(s.settingsHasEntry, false);
  assert.equal(s.settingsHasMinVersion, false);

  installHooks(projectDir);
  s = hooksStatus(projectDir);
  // 0.4.0-snapshot.10: no Stop hook installed.
  assert.equal(s.legacyStopHookPresent, false);
  assert.equal(s.sessionStartHook, true);
  assert.equal(s.skill, true);
  assert.equal(s.steleFeature, true);
  assert.equal(s.settingsHasEntry, true);
  assert.equal(s.settingsHasMinVersion, true);
});

test("status surfaces a legacy Stop hook when present (upgrade hint)", () => {
  mkdirSync(join(projectDir, ".claude/hooks"), { recursive: true });
  writeFileSync(
    join(projectDir, ".claude/hooks/stele-stop.sh"),
    "#!/usr/bin/env bash\n# legacy\n",
  );
  const s = hooksStatus(projectDir);
  assert.equal(s.legacyStopHookPresent, true,
    "status must flag the legacy Stop hook so the user knows to re-run install");
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

// ---- 0.4.0-snapshot.9 — SessionEnd auto-extract is OPT-IN ----------------
// Default install no longer writes SessionEnd. Layer 3 lives in
// /stele:scan otherwise.

test("default install does NOT write a SessionEnd entry", () => {
  installHooks(projectDir);
  const s = readSettings();
  assert.equal(
    s.hooks.SessionEnd === undefined || (Array.isArray(s.hooks.SessionEnd) && s.hooks.SessionEnd.length === 0),
    true,
    "default install must not enable SessionEnd auto-extract",
  );
});

test("default install does NOT write the extract agent file", () => {
  installHooks(projectDir);
  assert.equal(
    existsSync(join(projectDir, ".claude/agents/stele-extract.md")),
    false,
    "default install must skip the agent file (opt-in only)",
  );
});

test("opt-in install writes SessionEnd entry as type:agent with inlined prompt + no async", () => {
  installHooks(projectDir, { sessionEndAutoExtract: true });
  const s = readSettings();
  assert.ok(Array.isArray(s.hooks.SessionEnd), "SessionEnd not an array");
  assert.equal(s.hooks.SessionEnd.length, 1);
  const inner = s.hooks.SessionEnd[0].hooks[0];
  // 0.4.0-snapshot.9: switched from snapshot.8's command+claude-p wrapper
  // to agent type with inlined pointer prompt. No `claude -p` billing.
  // Agent type has no `async` field per Claude Code 2.1.x docs — the
  // hook BLOCKS session close for up to `timeout` seconds. Accepted
  // trade-off when opting in.
  assert.equal(inner.type, "agent",
    "SessionEnd opt-in must be agent-type (no claude -p billing)");
  assert.equal(typeof inner.prompt, "string",
    "agent-type entry must inline a `prompt: string`");
  assert.ok(inner.prompt.includes("stele:session-end-auto-extract"),
    "inlined prompt must carry the stele marker so isOurs() can detect it");
  assert.ok(inner.prompt.includes("decision_capture"),
    "inlined prompt must reference the capture tool");
  assert.equal(inner.async, undefined,
    "agent-type hooks don't accept async per Claude Code docs");
  assert.equal(typeof inner.timeout, "number",
    "timeout should be set explicitly so the user knows the upper bound");
});

test("opt-in install writes the extract agent file", () => {
  installHooks(projectDir, { sessionEndAutoExtract: true });
  const agentPath = join(projectDir, ".claude/agents/stele-extract.md");
  assert.ok(existsSync(agentPath), "agent file missing under opt-in install");
  const content = readFileSync(agentPath, "utf8");
  assert.ok(content.includes("decision_capture") && content.includes("session-extract"),
    "agent body must describe the capture flow");
});

test("re-running install WITHOUT the flag DISABLES a previously opted-in SessionEnd", () => {
  installHooks(projectDir, { sessionEndAutoExtract: true });
  let s = readSettings();
  assert.equal(s.hooks.SessionEnd.length, 1);

  installHooks(projectDir);  // no opt-in this round
  s = readSettings();
  assert.equal(
    s.hooks.SessionEnd === undefined || s.hooks.SessionEnd.length === 0,
    true,
    "plain install must strip a previously-enabled stele SessionEnd entry",
  );
  assert.equal(
    existsSync(join(projectDir, ".claude/agents/stele-extract.md")),
    false,
    "agent file must be removed when SessionEnd is disabled on reinstall",
  );
});

test("opt-in install preserves unrelated SessionEnd entries (other extensions)", () => {
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
  installHooks(projectDir, { sessionEndAutoExtract: true });
  const s = readSettings();
  assert.equal(s.hooks.SessionEnd.length, 2, "other SessionEnd entry lost");
  const others = s.hooks.SessionEnd.filter((e: any) =>
    e.hooks?.[0]?.command === "other-session-end.sh");
  assert.equal(others.length, 1, "non-stele SessionEnd entry survived");
});

test("reinstall WITH opt-in is idempotent: SessionEnd count stays at 1", () => {
  installHooks(projectDir, { sessionEndAutoExtract: true });
  installHooks(projectDir, { sessionEndAutoExtract: true });
  installHooks(projectDir, { sessionEndAutoExtract: true });
  const s = readSettings();
  assert.equal(s.hooks.SessionEnd.length, 1,
    "duplicate SessionEnd entries piled up across opt-in reinstalls");
});

test("uninstall removes SessionEnd auto-extract artifacts unconditionally", () => {
  installHooks(projectDir, { sessionEndAutoExtract: true });
  uninstallHooks(projectDir);
  assert.equal(
    existsSync(join(projectDir, ".claude/agents/stele-extract.md")),
    false,
    "extract agent file not removed by uninstall",
  );
  const s = readSettings();
  assert.equal(
    Array.isArray(s.hooks.SessionEnd) && s.hooks.SessionEnd.length > 0,
    false,
    "stele SessionEnd entry not removed by uninstall",
  );
});

test("uninstall also cleans the legacy (snapshot.8) wrapper script if present", () => {
  // Simulate a snapshot.8 install: legacy wrapper at
  // .claude/hooks/stele-session-end.sh that snapshot.9 doesn't write.
  const legacyWrapper = join(projectDir, ".claude/hooks/stele-session-end.sh");
  mkdirSync(join(projectDir, ".claude/hooks"), { recursive: true });
  writeFileSync(legacyWrapper, "#!/usr/bin/env bash\n# legacy snapshot.8 wrapper\n");
  uninstallHooks(projectDir);
  assert.equal(existsSync(legacyWrapper), false,
    "uninstall must clean snapshot.8 legacy wrapper");
});

test("opt-in install replaces the extract agent file wholesale (no stale content)", () => {
  installHooks(projectDir, { sessionEndAutoExtract: true });
  const agentPath = join(projectDir, ".claude/agents/stele-extract.md");
  writeFileSync(agentPath, "STALE CONTENT FROM PRIOR VERSION");
  installHooks(projectDir, { sessionEndAutoExtract: true });
  const content = readFileSync(agentPath, "utf8");
  assert.ok(content.startsWith("---"),
    "agent file must be re-written from template on every opt-in install");
  assert.ok(!content.includes("STALE CONTENT"));
});

test("status: sessionEndAutoExtract starts off, flips on under opt-in", () => {
  let s = hooksStatus(projectDir);
  assert.equal(s.sessionEndAutoExtract, false);

  installHooks(projectDir);  // default: off
  s = hooksStatus(projectDir);
  assert.equal(s.sessionEndAutoExtract, false,
    "default install should leave auto-extract off");

  installHooks(projectDir, { sessionEndAutoExtract: true });
  s = hooksStatus(projectDir);
  assert.equal(s.sessionEndAutoExtract, true,
    "opt-in install should flip auto-extract on");
});

test("status: auto-extract is only 'on' when BOTH settings entry AND agent file exist", () => {
  installHooks(projectDir, { sessionEndAutoExtract: true });
  // Delete agent file but leave settings entry — broken half-state.
  rmSync(join(projectDir, ".claude/agents/stele-extract.md"));
  const s = hooksStatus(projectDir);
  assert.equal(s.sessionEndAutoExtract, false,
    "half-installed state must report off — both parts must agree");
});

// ---- 0.4.0 snapshot.6 — /stele:scan slash command -----------------------

test("install writes /stele:scan command if missing, leaves it if present", () => {
  // First install: writes
  installHooks(projectDir);
  const cmdPath = join(projectDir, ".claude/commands/stele/scan.md");
  assert.ok(existsSync(cmdPath), "stele/scan.md missing");
  const content = readFileSync(cmdPath, "utf8");
  assert.ok(content.startsWith("---"), "scan command missing frontmatter");
  assert.ok(content.includes("/stele:scan"),
    "scan command body should reference its own name");

  // Customize, reinstall, should preserve (commands are user-editable)
  writeFileSync(cmdPath, "USER CUSTOMIZED");
  installHooks(projectDir);
  assert.equal(readFileSync(cmdPath, "utf8"), "USER CUSTOMIZED",
    "user-customized scan command got clobbered on reinstall");
});

test("status reports /stele:scan", () => {
  let s = hooksStatus(projectDir);
  assert.equal(s.steleScan, false);

  installHooks(projectDir);
  s = hooksStatus(projectDir);
  assert.equal(s.steleScan, true);
});

test("uninstall leaves /stele:scan in place", () => {
  installHooks(projectDir);
  uninstallHooks(projectDir);
  assert.ok(
    existsSync(join(projectDir, ".claude/commands/stele/scan.md")),
    "uninstall must NOT delete /stele:scan — user may have customized it",
  );
});

test("both /stele:feature AND /stele:scan land in the same namespace dir", () => {
  installHooks(projectDir);
  const featPath = join(projectDir, ".claude/commands/stele/feature.md");
  const scanPath = join(projectDir, ".claude/commands/stele/scan.md");
  assert.ok(existsSync(featPath), "stele/feature.md missing");
  assert.ok(existsSync(scanPath), "stele/scan.md missing");
  // Same parent dir → both addressable as /stele:<name>
  assert.equal(
    join(projectDir, ".claude/commands/stele"),
    featPath.replace(/\/feature\.md$/, ""),
  );
});

test("scan command install is independent from legacy-command cleanup", () => {
  // Simulate a 0.2.x project upgraded through 0.3 and 0.4: has the
  // legacy /decision, /milestone-report, /resume files we should kill,
  // but does NOT yet have stele/scan.md (introduced in 0.4.0).
  const cmdsDir = join(projectDir, ".claude/commands");
  mkdirSync(cmdsDir, { recursive: true });
  writeFileSync(join(cmdsDir, "decision.md"), "old /decision body");
  writeFileSync(join(cmdsDir, "milestone-report.md"), "old /milestone-report body");
  writeFileSync(join(cmdsDir, "resume.md"), "old /resume body");

  installHooks(projectDir);

  // Legacy gone
  assert.equal(existsSync(join(cmdsDir, "decision.md")), false);
  assert.equal(existsSync(join(cmdsDir, "milestone-report.md")), false);
  assert.equal(existsSync(join(cmdsDir, "resume.md")), false);
  // Both 0.3+ and 0.4+ namespaced commands present
  assert.ok(existsSync(join(cmdsDir, "stele/feature.md")));
  assert.ok(existsSync(join(cmdsDir, "stele/scan.md")));
});
