// stele hooks + skill installer — writes the Stop hook script, the
// stele-capture skill, the /decision slash command, and merges a Stop hook
// entry into the project's .claude/settings.json. Idempotent: re-running
// install replaces the stele entry without touching other configured hooks.
//
// All artifacts go into .claude/ at the project root, matching Claude Code's
// project-level config convention. Templates live in src/templates/ and ship
// in the npm package; this module reads them at install time.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_PATH_REL = ".claude/hooks/stele-stop.sh";
const SKILL_DIR_REL = ".claude/skills/stele-capture";
const SKILL_FILE_REL = ".claude/skills/stele-capture/SKILL.md";
const COMMAND_FILE_REL = ".claude/commands/decision.md";
const SETTINGS_REL = ".claude/settings.json";

function templatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "templates");
}

function readTemplate(name: string): string {
  return readFileSync(join(templatesDir(), name), "utf8");
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

// -----------------------------------------------------------------------------
// settings.json merge
// -----------------------------------------------------------------------------

type SettingsShape = {
  hooks?: { Stop?: Array<{ type?: string; command?: string; matcher?: string }> } & Record<
    string,
    unknown
  >;
} & Record<string, unknown>;

const STELE_HOOK_ENTRY = {
  type: "command" as const,
  command: HOOK_PATH_REL,
};

function isOurHookEntry(entry: { command?: string } | null | undefined): boolean {
  if (!entry || typeof entry.command !== "string") return false;
  return entry.command.endsWith("stele-stop.sh");
}

function mergeSettings(projectRoot: string): { note: string } {
  const path = join(projectRoot, SETTINGS_REL);
  let settings: SettingsShape = {};

  if (existsSync(path)) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (e) {
      throw new Error(`could not read ${SETTINGS_REL}: ${(e as Error).message}`);
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        settings = parsed as SettingsShape;
      } else {
        throw new Error(`${SETTINGS_REL} is not a JSON object`);
      }
    } catch (e) {
      throw new Error(`could not parse ${SETTINGS_REL}: ${(e as Error).message}`);
    }
  }

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  const hooks = settings.hooks as { Stop?: unknown[] };
  if (!Array.isArray(hooks.Stop)) hooks.Stop = [];

  // Replace any existing stele entry, else append.
  let replaced = false;
  const stop = hooks.Stop as Array<{ command?: string }>;
  for (let i = 0; i < stop.length; i++) {
    if (isOurHookEntry(stop[i])) {
      stop[i] = { ...STELE_HOOK_ENTRY };
      replaced = true;
      break;
    }
  }
  if (!replaced) stop.push({ ...STELE_HOOK_ENTRY });

  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return { note: replaced ? "updated stele Stop hook entry" : "added stele Stop hook entry" };
}

function unmergeSettings(projectRoot: string): { note: string } {
  const path = join(projectRoot, SETTINGS_REL);
  if (!existsSync(path)) return { note: "no settings.json — nothing to do" };
  let settings: SettingsShape;
  try {
    settings = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`could not parse ${SETTINGS_REL}: ${(e as Error).message}`);
  }
  const hooks = (settings.hooks ?? {}) as { Stop?: Array<{ command?: string }> };
  if (!Array.isArray(hooks.Stop)) return { note: "no Stop hooks — nothing to remove" };

  const before = hooks.Stop.length;
  hooks.Stop = hooks.Stop.filter((e) => !isOurHookEntry(e));
  const removed = before - hooks.Stop.length;
  if (hooks.Stop.length === 0) delete (hooks as Record<string, unknown>).Stop;
  // Don't delete settings.hooks entirely — other hook events may still live there.

  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return { note: removed > 0 ? `removed ${removed} stele Stop hook entry` : "no stele entry was present" };
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface InstallReport {
  hook: string;
  skill: string;
  command: string;
  settings: string;
}

export function installHooks(projectRoot: string): InstallReport {
  const report: InstallReport = { hook: "", skill: "", command: "", settings: "" };

  // 1. Hook script
  const hookPath = join(projectRoot, HOOK_PATH_REL);
  ensureDir(dirname(hookPath));
  writeFileSync(hookPath, readTemplate("stele-stop-hook.sh"));
  chmodSync(hookPath, 0o755);
  report.hook = `wrote ${HOOK_PATH_REL} (executable)`;

  // 2. Skill
  const skillDir = join(projectRoot, SKILL_DIR_REL);
  const skillPath = join(projectRoot, SKILL_FILE_REL);
  ensureDir(skillDir);
  writeFileSync(skillPath, readTemplate("stele-capture-skill.md"));
  report.skill = `wrote ${SKILL_FILE_REL}`;

  // 3. /decision slash command — only if missing (don't overwrite user edits)
  const commandPath = join(projectRoot, COMMAND_FILE_REL);
  if (existsSync(commandPath)) {
    report.command = `${COMMAND_FILE_REL} already exists, left as-is`;
  } else {
    ensureDir(dirname(commandPath));
    writeFileSync(commandPath, readTemplate("decision-command.md"));
    report.command = `wrote ${COMMAND_FILE_REL}`;
  }

  // 4. Settings merge
  const s = mergeSettings(projectRoot);
  report.settings = s.note;

  return report;
}

export function uninstallHooks(projectRoot: string): InstallReport {
  const report: InstallReport = { hook: "", skill: "", command: "", settings: "" };

  const hookPath = join(projectRoot, HOOK_PATH_REL);
  if (existsSync(hookPath)) {
    rmSync(hookPath);
    report.hook = `removed ${HOOK_PATH_REL}`;
  } else {
    report.hook = `${HOOK_PATH_REL} not present`;
  }

  const skillDir = join(projectRoot, SKILL_DIR_REL);
  if (existsSync(skillDir)) {
    rmSync(skillDir, { recursive: true });
    report.skill = `removed ${SKILL_DIR_REL}`;
  } else {
    report.skill = `${SKILL_DIR_REL} not present`;
  }

  // Never delete the /decision command on uninstall — user may have customized.
  report.command = `${COMMAND_FILE_REL} left in place (manual delete if you want)`;

  const s = unmergeSettings(projectRoot);
  report.settings = s.note;

  return report;
}

export interface StatusReport {
  hook: boolean;
  skill: boolean;
  command: boolean;
  settingsHasEntry: boolean;
}

export function hooksStatus(projectRoot: string): StatusReport {
  const settingsPath = join(projectRoot, SETTINGS_REL);
  let settingsHasEntry = false;
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsShape;
      const stop = (settings.hooks as { Stop?: Array<{ command?: string }> } | undefined)?.Stop;
      if (Array.isArray(stop)) settingsHasEntry = stop.some(isOurHookEntry);
    } catch {
      // ignore — treat as no entry
    }
  }
  return {
    hook: existsSync(join(projectRoot, HOOK_PATH_REL)),
    skill: existsSync(join(projectRoot, SKILL_FILE_REL)),
    command: existsSync(join(projectRoot, COMMAND_FILE_REL)),
    settingsHasEntry,
  };
}
