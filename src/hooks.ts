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
// 0.4.0 — SessionStart hook ("read-side inject"): runs `stele resume
// --for-context` and the stdout becomes additionalContext at session-start
// so the agent sees open loops without the user having to ask.
const SESSION_START_HOOK_PATH_REL = ".claude/hooks/stele-session-start.sh";
// 0.4.0 — SessionEnd hook (Layer 3, post-hoc capture). Async-detached
// shell wrapper that spawns `claude -p` with the stele-extract agent
// definition as the prompt. `type:"agent"` hooks in Claude Code 2.1.x
// take only a `prompt: string` field (no allowed_tools, no documented
// async), so we use command-type + a wrapper instead. The trade-off is
// `claude -p` being billed (per the design doc's warning) — bounded to
// once per session.
const SESSION_END_HOOK_PATH_REL = ".claude/hooks/stele-session-end.sh";
// The agent definition file is what the wrapper reads to construct the
// prompt sent to `claude -p`. Replaced wholesale on each install so the
// algorithm + schema reference stay in sync with the templated version.
const EXTRACT_AGENT_REL = ".claude/agents/stele-extract.md";
const SKILL_DIR_REL = ".claude/skills/stele-capture";
const SKILL_FILE_REL = ".claude/skills/stele-capture/SKILL.md";
// 0.3.0 — single namespaced slash command `/stele:feature` replaces the
// three 0.2.x commands (/decision, /milestone-report, /resume). The
// namespaced sub-path matches how Claude Code reads `stele:feature`.
const STELE_FEATURE_COMMAND_REL = ".claude/commands/stele/feature.md";
// 0.4.0 — second slash command `/stele:scan`. Re-runnable historical
// backfill / fine-grained audit pass. Lives in the same namespace as
// /stele:feature so they pair conceptually (one reconciles the current
// transcript, the other reconciles OTHER sources).
const STELE_SCAN_COMMAND_REL = ".claude/commands/stele/scan.md";
const STELE_COMMAND_DIR_REL = ".claude/commands/stele";
const LEGACY_COMMAND_RELS = [
  ".claude/commands/decision.md",
  ".claude/commands/milestone-report.md",
  ".claude/commands/resume.md",
];
const SETTINGS_REL = ".claude/settings.json";

// 0.4.0 — async hook (SessionEnd subagent, landing in phase 4) requires
// Claude Code ≥ 2.1.0. We pin this in settings.json so a too-old install
// refuses to start instead of silently running an inconsistent stele.
const REQUIRED_MIN_VERSION = "2.1.0";

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
// settings.json merge — multi-event aware (0.4.0)
// -----------------------------------------------------------------------------

type HookEvent = "Stop" | "SessionStart" | "SessionEnd";

type StopHookCommand = { type?: string; command?: string; agent?: string; async?: boolean };
type StopHookEntry = { matcher?: string; hooks?: StopHookCommand[] };

type SettingsShape = {
  hooks?: Record<HookEvent, Array<StopHookEntry & StopHookCommand> | undefined> & Record<string, unknown>;
  requiredMinimumVersion?: string;
} & Record<string, unknown>;

/**
 * One managed hook entry per event. Each carries:
 *   • event — which top-level Claude Code hook event it lives under
 *   • build() — fresh entry object to install (returns a NEW object every
 *     time so writers don't share state across calls)
 *   • isOurs() — detect "this is the stele entry" so reinstall replaces
 *     in place and uninstall removes only ours, never anyone else's.
 *
 * The Stop entry's isOurs() handles BOTH the broken 0.0.1 flat shape
 * ({ type, command } direct in the array) and the correct nested shape
 * ({ matcher, hooks: [...] }), so reinstall heals legacy installs.
 */
interface ManagedEntry {
  event: HookEvent;
  build(): StopHookEntry & StopHookCommand;
  isOurs(entry: unknown): boolean;
}

function endsWithScript(cmd: unknown, basename: string): boolean {
  return typeof cmd === "string" && cmd.endsWith(basename);
}

function nestedHasScript(entry: unknown, basename: string): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as StopHookEntry & StopHookCommand;
  if (endsWithScript(e.command, basename)) return true;
  if (Array.isArray(e.hooks)) {
    return e.hooks.some((h) => h && typeof h === "object" && endsWithScript(h.command, basename));
  }
  return false;
}

const MANAGED_ENTRIES: ManagedEntry[] = [
  {
    event: "Stop",
    build: () => ({ matcher: "", hooks: [{ type: "command", command: HOOK_PATH_REL }] }),
    isOurs: (e) => nestedHasScript(e, "stele-stop.sh"),
  },
  {
    event: "SessionStart",
    build: () => ({
      matcher: "",
      hooks: [{ type: "command", command: SESSION_START_HOOK_PATH_REL }],
    }),
    isOurs: (e) => nestedHasScript(e, "stele-session-start.sh"),
  },
  {
    // 0.4.0 — Layer 3: post-hoc extract via command-type hook + wrapper.
    // The wrapper script spawns `claude -p` in the background with the
    // stele-extract agent definition as the prompt. `async: true` on a
    // command-type hook IS documented and works — the user's session
    // close doesn't wait. The wrapper uses setsid+nohup to fully detach
    // so the extraction subprocess survives Claude Code exiting.
    //
    // Previous attempt used `type: "agent"` with `agent: <path>` — that
    // shape doesn't match the actual Claude Code 2.1.x schema (which
    // takes a `prompt: string` only on agent type, no async). The
    // settings.json was rejected at parse time. command+wrapper is the
    // design the original auto-capture doc described.
    event: "SessionEnd",
    build: () => ({
      matcher: "",
      hooks: [{
        type: "command",
        command: SESSION_END_HOOK_PATH_REL,
        async: true,
        timeout: 10,
      }],
    }),
    isOurs: (e) => nestedHasScript(e, "stele-session-end.sh"),
  },
];

function loadSettings(projectRoot: string): SettingsShape {
  const path = join(projectRoot, SETTINGS_REL);
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`could not read ${SETTINGS_REL}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`could not parse ${SETTINGS_REL}: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${SETTINGS_REL} is not a JSON object`);
  }
  return parsed as SettingsShape;
}

function saveSettings(projectRoot: string, settings: SettingsShape): void {
  const path = join(projectRoot, SETTINGS_REL);
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}

function mergeSettings(projectRoot: string): { note: string } {
  const settings = loadSettings(projectRoot);

  if (!settings.hooks || typeof settings.hooks !== "object") {
    settings.hooks = {} as SettingsShape["hooks"];
  }
  const hooks = settings.hooks as Record<string, unknown>;

  const notes: string[] = [];

  for (const m of MANAGED_ENTRIES) {
    if (!Array.isArray(hooks[m.event])) hooks[m.event] = [];
    const arr = hooks[m.event] as Array<StopHookEntry & StopHookCommand>;
    let replaced = false;
    for (let i = 0; i < arr.length; i++) {
      if (m.isOurs(arr[i])) {
        arr[i] = m.build();
        replaced = true;
        break;
      }
    }
    if (!replaced) arr.push(m.build());
    notes.push(replaced ? `updated ${m.event} entry` : `added ${m.event} entry`);
  }

  // 0.4.0 — pin requiredMinimumVersion. Claude Code refuses to start when
  // its version is lower than this, which prevents the async SessionEnd
  // hook (landing in phase 4) from silently no-op'ing on too-old installs.
  let versionNote: string;
  if (settings.requiredMinimumVersion === REQUIRED_MIN_VERSION) {
    versionNote = `requiredMinimumVersion already pinned at ${REQUIRED_MIN_VERSION}`;
  } else {
    settings.requiredMinimumVersion = REQUIRED_MIN_VERSION;
    versionNote = `pinned requiredMinimumVersion to ${REQUIRED_MIN_VERSION}`;
  }
  notes.push(versionNote);

  saveSettings(projectRoot, settings);
  return { note: notes.join("; ") };
}

function unmergeSettings(projectRoot: string): { note: string } {
  const path = join(projectRoot, SETTINGS_REL);
  if (!existsSync(path)) return { note: "no settings.json — nothing to do" };
  const settings = loadSettings(projectRoot);
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;

  const removed: string[] = [];
  for (const m of MANAGED_ENTRIES) {
    const arr = hooks[m.event];
    if (!Array.isArray(arr)) continue;
    const before = arr.length;
    const filtered = (arr as Array<StopHookEntry & StopHookCommand>).filter((e) => !m.isOurs(e));
    const took = before - filtered.length;
    if (took > 0) {
      if (filtered.length === 0) delete hooks[m.event];
      else hooks[m.event] = filtered;
      removed.push(`${took} ${m.event}`);
    }
  }
  // Don't delete settings.hooks entirely — other hook events may still live there.

  // Leave requiredMinimumVersion alone on uninstall — yanking it could
  // surprise the user (their project might still have other hooks that
  // need it). They can drop it manually.

  saveSettings(projectRoot, settings);
  return { note: removed.length > 0 ? `removed ${removed.join(", ")} stele entries` : "no stele entries were present" };
}

// Detect whether the settings.json carries any stele hook entry across
// all managed events. Used by hooksStatus().
function settingsHasAnyEntry(settings: SettingsShape): boolean {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  for (const m of MANAGED_ENTRIES) {
    const arr = hooks[m.event];
    if (Array.isArray(arr) && arr.some((e) => m.isOurs(e))) return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface InstallReport {
  hook: string;
  sessionStartHook: string;
  extractAgent: string;
  skill: string;
  steleFeature: string;
  steleScan: string;
  legacyCommandsCleaned: string;
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

/**
 * 0.3.0 dropped the three 0.2.x slash commands (/decision,
 * /milestone-report, /resume). Re-running `stele init` on a project
 * upgraded from 0.2.x should delete the orphaned command files so the
 * user doesn't have unreachable / outdated commands lingering in their
 * `.claude/commands/`. We delete unconditionally — these were
 * tool-managed files, not user-authored content.
 */
function cleanLegacyCommands(projectRoot: string): string {
  const removed: string[] = [];
  for (const rel of LEGACY_COMMAND_RELS) {
    const p = join(projectRoot, rel);
    if (existsSync(p)) {
      rmSync(p);
      removed.push(rel);
    }
  }
  if (removed.length === 0) return "no legacy commands to clean";
  return `removed ${removed.length} legacy command${removed.length === 1 ? "" : "s"} (${removed.join(", ")})`;
}

export function installHooks(projectRoot: string): InstallReport {
  const report: InstallReport = {
    hook: "", sessionStartHook: "", extractAgent: "",
    skill: "", steleFeature: "", steleScan: "",
    legacyCommandsCleaned: "", settings: "",
  };

  // 1. Stop hook script (per-turn nudge — strengthened in phase 3 to drive
  //    the live-track decision_capture call)
  const hookPath = join(projectRoot, HOOK_PATH_REL);
  ensureDir(dirname(hookPath));
  writeFileSync(hookPath, readTemplate("stele-stop-hook.sh"));
  chmodSync(hookPath, 0o755);
  report.hook = `wrote ${HOOK_PATH_REL} (executable)`;

  // 1b. SessionStart hook script (0.4.0 — read-side inject of open loops
  //     via `stele resume --for-context`)
  const sessionStartPath = join(projectRoot, SESSION_START_HOOK_PATH_REL);
  ensureDir(dirname(sessionStartPath));
  writeFileSync(sessionStartPath, readTemplate("stele-session-start-hook.sh"));
  chmodSync(sessionStartPath, 0o755);
  report.sessionStartHook = `wrote ${SESSION_START_HOOK_PATH_REL} (executable)`;

  // 1c. SessionEnd wrapper script (0.4.0 — Layer 3, post-hoc capture).
  //     Async-detached shell that spawns `claude -p` with the extract
  //     agent prompt in the background. Wire `async: true` on the hook
  //     entry (set above in MANAGED_ENTRIES) so the user's session
  //     close doesn't wait.
  const sessionEndPath = join(projectRoot, SESSION_END_HOOK_PATH_REL);
  ensureDir(dirname(sessionEndPath));
  writeFileSync(sessionEndPath, readTemplate("stele-session-end-hook.sh"));
  chmodSync(sessionEndPath, 0o755);

  // 1d. Extract agent definition file — the wrapper reads this to build
  //     the prompt for `claude -p`. Replaced wholesale on each install
  //     so the algorithm + schema reference stay in sync with the
  //     templated version. The user is welcome to edit it; reinstall
  //     blows their edits away (the prompt is part of the contract).
  const extractPath = join(projectRoot, EXTRACT_AGENT_REL);
  ensureDir(dirname(extractPath));
  writeFileSync(extractPath, readTemplate("stele-extract-agent.md"));
  report.extractAgent = `wrote ${SESSION_END_HOOK_PATH_REL} (executable) + ${EXTRACT_AGENT_REL}`;

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

  // 3. Slash commands — only write if missing (don't clobber user edits).
  //    0.3.0 added /stele:feature; 0.4.0 added /stele:scan.
  report.steleFeature = installCommand(projectRoot, STELE_FEATURE_COMMAND_REL, "stele-feature-command.md");
  report.steleScan    = installCommand(projectRoot, STELE_SCAN_COMMAND_REL,    "stele-scan-command.md");

  // 4. Clean up legacy 0.2.x commands from prior installs.
  report.legacyCommandsCleaned = cleanLegacyCommands(projectRoot);

  // 5. Settings merge (Stop + SessionStart entries + requiredMinimumVersion)
  const s = mergeSettings(projectRoot);
  report.settings = s.note;

  return report;
}

export function uninstallHooks(projectRoot: string): InstallReport {
  const report: InstallReport = {
    hook: "", sessionStartHook: "", extractAgent: "",
    skill: "", steleFeature: "", steleScan: "",
    legacyCommandsCleaned: "", settings: "",
  };

  const hookPath = join(projectRoot, HOOK_PATH_REL);
  if (existsSync(hookPath)) {
    rmSync(hookPath);
    report.hook = `removed ${HOOK_PATH_REL}`;
  } else {
    report.hook = `${HOOK_PATH_REL} not present`;
  }

  const sessionStartPath = join(projectRoot, SESSION_START_HOOK_PATH_REL);
  if (existsSync(sessionStartPath)) {
    rmSync(sessionStartPath);
    report.sessionStartHook = `removed ${SESSION_START_HOOK_PATH_REL}`;
  } else {
    report.sessionStartHook = `${SESSION_START_HOOK_PATH_REL} not present`;
  }

  const sessionEndPath = join(projectRoot, SESSION_END_HOOK_PATH_REL);
  if (existsSync(sessionEndPath)) {
    rmSync(sessionEndPath);
  }
  const extractPath = join(projectRoot, EXTRACT_AGENT_REL);
  if (existsSync(extractPath)) {
    rmSync(extractPath);
  }
  // Combined report — they're a pair now.
  const sessionEndRemoved = !existsSync(sessionEndPath);
  const extractRemoved = !existsSync(extractPath);
  if (sessionEndRemoved || extractRemoved) {
    report.extractAgent = `removed ${SESSION_END_HOOK_PATH_REL} + ${EXTRACT_AGENT_REL}`;
  } else {
    report.extractAgent = `${SESSION_END_HOOK_PATH_REL} + ${EXTRACT_AGENT_REL} not present`;
  }

  const skillDir = join(projectRoot, SKILL_DIR_REL);
  if (existsSync(skillDir)) {
    rmSync(skillDir, { recursive: true });
    report.skill = `removed ${SKILL_DIR_REL}`;
  } else {
    report.skill = `${SKILL_DIR_REL} not present`;
  }

  // Never delete the slash commands on uninstall — users may have customized.
  report.steleFeature = `${STELE_FEATURE_COMMAND_REL} left in place (manual delete if you want)`;
  report.steleScan    = `${STELE_SCAN_COMMAND_REL} left in place (manual delete if you want)`;
  report.legacyCommandsCleaned = "uninstall doesn't touch legacy 0.2.x commands";

  const s = unmergeSettings(projectRoot);
  report.settings = s.note;

  return report;
}

export interface StatusReport {
  hook: boolean;
  sessionStartHook: boolean;
  extractAgent: boolean;
  skill: boolean;
  steleFeature: boolean;
  steleScan: boolean;
  settingsHasEntry: boolean;
  settingsHasMinVersion: boolean;
}

export function hooksStatus(projectRoot: string): StatusReport {
  const settingsPath = join(projectRoot, SETTINGS_REL);
  let settingsHasEntry = false;
  let settingsHasMinVersion = false;
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsShape;
      settingsHasEntry = settingsHasAnyEntry(settings);
      settingsHasMinVersion = settings.requiredMinimumVersion === REQUIRED_MIN_VERSION;
    } catch {
      // ignore — treat as no entry
    }
  }
  return {
    hook: existsSync(join(projectRoot, HOOK_PATH_REL)),
    sessionStartHook: existsSync(join(projectRoot, SESSION_START_HOOK_PATH_REL)),
    extractAgent: existsSync(join(projectRoot, EXTRACT_AGENT_REL)),
    skill: existsSync(join(projectRoot, SKILL_FILE_REL)),
    steleFeature: existsSync(join(projectRoot, STELE_FEATURE_COMMAND_REL)),
    steleScan: existsSync(join(projectRoot, STELE_SCAN_COMMAND_REL)),
    settingsHasEntry,
    settingsHasMinVersion,
  };
}
