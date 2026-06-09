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
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_PATH_REL = ".claude/hooks/stele-stop.sh";
const SKILL_DIR_REL = ".claude/skills/stele-capture";
const SKILL_FILE_REL = ".claude/skills/stele-capture/SKILL.md";
const COMMAND_FILE_REL = ".claude/commands/decision.md";
const MILESTONE_REPORT_FILE_REL = ".claude/commands/milestone-report.md";
const RESUME_FILE_REL = ".claude/commands/resume.md";
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

/**
 * Recursively walk a directory and yield every file path relative to root.
 * Used by the skill installer — skills are folders now (SKILL.md + gotchas.md
 * + references/*.md) per Anthropic's progressive-disclosure pattern.
 */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  function visit(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) visit(full);
      else out.push(full);
    }
  }
  if (existsSync(root)) visit(root);
  return out.map((p) => relative(root, p));
}

/**
 * Recursive copy of a template subdirectory into the install destination.
 * Returns the count of files written. Mode for executable scripts is set
 * separately by the caller.
 */
function copyTemplateDir(templateSubdir: string, destDir: string): number {
  const src = join(templatesDir(), templateSubdir);
  const files = walkFiles(src);
  for (const rel of files) {
    const srcPath = join(src, rel);
    const destPath = join(destDir, rel);
    ensureDir(dirname(destPath));
    writeFileSync(destPath, readFileSync(srcPath));
  }
  return files.length;
}

// -----------------------------------------------------------------------------
// settings.json merge
// -----------------------------------------------------------------------------

type StopHookCommand = { type?: string; command?: string };
type StopHookEntry = { matcher?: string; hooks?: StopHookCommand[] };

type SettingsShape = {
  hooks?: { Stop?: Array<StopHookEntry & StopHookCommand> } & Record<string, unknown>;
} & Record<string, unknown>;

// Claude Code's Stop hook schema is { matcher, hooks: [{ type, command }, ...] }.
// 0.0.1-snapshot shipped a broken shape that put { type, command } directly into
// the Stop array, which /doctor catches as "hooks.Stop.0.hooks: expected array".
const STELE_HOOK_ENTRY: StopHookEntry = {
  matcher: "",
  hooks: [{ type: "command", command: HOOK_PATH_REL }],
};

// Detect both the broken (0.0.1) and correct (0.0.2+) shapes so reinstall heals
// a prior buggy install.
function isOurHookEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as StopHookEntry & StopHookCommand;
  if (typeof e.command === "string" && e.command.endsWith("stele-stop.sh")) return true;
  if (Array.isArray(e.hooks)) {
    return e.hooks.some(
      (h) =>
        h &&
        typeof h === "object" &&
        typeof h.command === "string" &&
        h.command.endsWith("stele-stop.sh"),
    );
  }
  return false;
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

  // Stop array can contain either old broken { type, command } entries (from
  // 0.0.1-snapshot) or correct { matcher, hooks: [...] } entries (0.0.2+).
  // Type as a union so the array can hold either while we scan/replace.
  const stop = hooks.Stop as Array<StopHookEntry & StopHookCommand>;
  let replaced = false;
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
  const hooks = (settings.hooks ?? {}) as {
    Stop?: Array<StopHookEntry & StopHookCommand>;
  };
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
  milestoneReport: string;
  resume: string;
  settings: string;
}

function installCommand(projectRoot: string, relPath: string, templateName: string): string {
  const path = join(projectRoot, relPath);
  if (existsSync(path)) {
    return `${relPath} already exists, left as-is`;
  }
  ensureDir(dirname(path));
  writeFileSync(path, readTemplate(templateName));
  return `wrote ${relPath}`;
}

export function installHooks(projectRoot: string): InstallReport {
  const report: InstallReport = {
    hook: "", skill: "", command: "", milestoneReport: "", resume: "", settings: "",
  };

  // 1. Hook script
  const hookPath = join(projectRoot, HOOK_PATH_REL);
  ensureDir(dirname(hookPath));
  writeFileSync(hookPath, readTemplate("stele-stop-hook.sh"));
  chmodSync(hookPath, 0o755);
  report.hook = `wrote ${HOOK_PATH_REL} (executable)`;

  // 2. Skill — the stele-capture skill is a folder (SKILL.md + gotchas.md +
  // references/*.md) per Anthropic's progressive-disclosure pattern. Recursive
  // copy of every template file under templates/stele-capture-skill/. We
  // clean any pre-existing install first so stale references files from
  // older versions don't linger.
  const skillDir = join(projectRoot, SKILL_DIR_REL);
  if (existsSync(skillDir)) rmSync(skillDir, { recursive: true });
  ensureDir(skillDir);
  const skillFileCount = copyTemplateDir("stele-capture-skill", skillDir);
  report.skill = `wrote ${SKILL_DIR_REL}/ (${skillFileCount} file${skillFileCount === 1 ? "" : "s"}: SKILL.md + gotchas + references)`;

  // 3. Slash commands — only write if missing (don't overwrite user edits)
  report.command = installCommand(projectRoot, COMMAND_FILE_REL, "decision-command.md");
  report.milestoneReport = installCommand(projectRoot, MILESTONE_REPORT_FILE_REL, "milestone-report-command.md");
  report.resume = installCommand(projectRoot, RESUME_FILE_REL, "resume-command.md");

  // 4. Settings merge
  const s = mergeSettings(projectRoot);
  report.settings = s.note;

  return report;
}

export function uninstallHooks(projectRoot: string): InstallReport {
  const report: InstallReport = {
    hook: "", skill: "", command: "", milestoneReport: "", resume: "", settings: "",
  };

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

  // Never delete the slash commands on uninstall — user may have customized.
  report.command = `${COMMAND_FILE_REL} left in place (manual delete if you want)`;
  report.milestoneReport = `${MILESTONE_REPORT_FILE_REL} left in place`;
  report.resume = `${RESUME_FILE_REL} left in place`;

  const s = unmergeSettings(projectRoot);
  report.settings = s.note;

  return report;
}

export interface StatusReport {
  hook: boolean;
  skill: boolean;
  command: boolean;
  milestoneReport: boolean;
  resume: boolean;
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
    milestoneReport: existsSync(join(projectRoot, MILESTONE_REPORT_FILE_REL)),
    resume: existsSync(join(projectRoot, RESUME_FILE_REL)),
    settingsHasEntry,
  };
}
