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

// 0.4.0-snapshot.10 — the Stop hook is GONE. No per-turn regex
// pre-filter, no per-turn nag. The live agent self-governs when to
// capture (see .claude/skills/stele-capture/SKILL.md). SessionStart
// (below) does the one-shot context inject for the whole session.
// We keep one constant pointing at the legacy path so install/
// uninstall can clean it up on upgrade.
const LEGACY_STOP_HOOK_PATH_REL = ".claude/hooks/stele-stop.sh";

// 0.4.0 — SessionStart hook (read-side + capture context inject):
// runs `stele resume --for-context` plus emits cc_session_id + active
// features + tag policy. stdout becomes additionalContext at session-
// start so the agent gets everything it needs for a whole session of
// captures in one shot.
const SESSION_START_HOOK_PATH_REL = ".claude/hooks/stele-session-start.sh";
// 0.4.0 — SessionEnd auto-extract (OPT-IN, Layer 3 post-hoc capture).
//
// Off by default. When the user opts in via
// `stele init --enable-session-end-auto-extract` or
// `stele hooks enable session-end-auto-extract`, we install a
// `type: "agent"` SessionEnd hook with an inlined POINTER prompt that
// tells the subagent to Read the EXTRACT_AGENT_REL file for the
// algorithm + schema reference.
//
// Why agent type, not command + `claude -p`?
//   • zero `claude -p` billing
//   • zero extra subprocess wrapper
//   • the subagent inherits the parent's MCP / file-system access so
//     it can call mcp__stele__decision_capture directly
//
// The known limitation (per Claude Code 2.1.x docs):
//   • `agent` type has no documented `async` field, so the SessionEnd
//     hook BLOCKS session close for up to `timeout` seconds (default
//     60). The user accepted this trade-off when opting in.
//
// Layer 3 still exists as `/stele:scan` (manual, user-driven) for users
// who don't opt in. Both paths set source='session-extract' and run
// through the same dedup_key, so a project can use either or both.
const EXTRACT_AGENT_REL = ".claude/agents/stele-extract.md";

// Marker string embedded in the inlined SessionEnd agent prompt. Lets
// `isOurs` detect our entry without inspecting the full prompt body.
const SESSION_END_PROMPT_MARKER = "[stele:session-end-auto-extract]";

// The inlined prompt that goes into settings.json's SessionEnd agent
// entry. Short — points the subagent at the on-disk algorithm file
// rather than embedding the full ~250-line content. Kept short so
// settings.json stays readable. The agent file is what the user edits
// to tweak extraction behavior.
const SESSION_END_AGENT_PROMPT = [
  SESSION_END_PROMPT_MARKER,
  "You are stele's Layer 3 post-hoc extract subagent. The user's Claude Code session just ended; your job is to read the transcript and capture decisions the live agent missed.",
  "",
  "Hook payload (JSON, contains transcript_path, session_id, cwd):",
  "$ARGUMENTS",
  "",
  "Steps:",
  "  1. Parse $ARGUMENTS as JSON. Extract transcript_path, session_id, cwd.",
  "  2. Read <cwd>/.claude/agents/stele-extract.md for the full 5-step algorithm + the inlined Decision schema reference. Do NOT try to load skills — they don't carry over to subagents.",
  "  3. Follow the algorithm. For each decision the live agent missed, call mcp__stele__decision_capture with source='session-extract' and a confidence value.",
  "  4. `dup-skip: <existingId>` responses are SUCCESS — the live track already captured that one. Move on, don't retry.",
  "  5. Log errors to <cwd>/.stele/extract.log; never write to stderr (nobody's reading it).",
  "",
  "IMPORTANT: this hook BLOCKS the user's session close for up to 60 seconds (Claude Code's agent-type hook has no async support as of 2.1.x). Work fast — prefer capturing fewer high-confidence decisions over many low-confidence ones. If you've been running ~50 seconds, gracefully wrap up the current decision and exit.",
].join("\n");
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

type StopHookCommand = {
  type?: string;
  command?: string;
  agent?: string;       // legacy (snapshot.4) — kept for detection compat
  prompt?: string;      // 0.4.0-snapshot.9: agent-type entries inline a prompt here
  async?: boolean;
  timeout?: number;
};
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

// 0.4.0-snapshot.9 — opt-in feature flags. The default install only
// writes the always-on entries (Stop + SessionStart). Optional entries
// (SessionEnd auto-extract) are gated by user choice.
export interface InstallOptions {
  /** Opt-in to SessionEnd auto-extract via agent-type hook. Blocks
   *  session close for up to 60s. Off by default. */
  sessionEndAutoExtract?: boolean;
}

// 0.4.0-snapshot.10 — Stop entry is gone. The unmerger still scrubs
// any legacy entry (matched by the script name) so projects that have
// the old Stop entry from earlier snapshots get cleaned up on uninstall.
const LEGACY_STOP_ENTRY: ManagedEntry = {
  event: "Stop",
  // build() is never called for this entry — it's only used during
  // unmerge to detect+remove the legacy hook. We provide a sentinel
  // shape so TypeScript is happy.
  build: () => ({ matcher: "", hooks: [] }),
  isOurs: (e) => nestedHasScript(e, "stele-stop.sh"),
};

const SESSION_START_ENTRY: ManagedEntry = {
  event: "SessionStart",
  build: () => ({
    matcher: "",
    hooks: [{ type: "command", command: SESSION_START_HOOK_PATH_REL }],
  }),
  isOurs: (e) => nestedHasScript(e, "stele-session-start.sh"),
};

// 0.4.0-snapshot.9 — SessionEnd as type:"agent" with inlined pointer
// prompt. The subagent Reads .claude/agents/stele-extract.md at runtime
// for the algorithm; the prompt itself is small. NO `async` (not
// supported on agent type per Claude Code 2.1.x docs) — blocks session
// close for up to `timeout` seconds. Opt-in only.
const SESSION_END_ENTRY: ManagedEntry = {
  event: "SessionEnd",
  build: () => ({
    matcher: "",
    hooks: [{
      type: "agent",
      prompt: SESSION_END_AGENT_PROMPT,
      timeout: 60,
    }],
  }),
  isOurs: (e) => nestedHasAgentMarker(e, SESSION_END_PROMPT_MARKER),
};

/**
 * The list of MANAGED_ENTRIES depends on opts. Default = always-on
 * entries only. Pass opts.sessionEndAutoExtract=true to include the
 * SessionEnd entry.
 */
function managedEntriesFor(opts: InstallOptions = {}): ManagedEntry[] {
  // 0.4.0-snapshot.10: Stop entry dropped from defaults. SessionStart
  // is the only always-on entry. SessionEnd remains opt-in.
  const list: ManagedEntry[] = [SESSION_START_ENTRY];
  if (opts.sessionEndAutoExtract) list.push(SESSION_END_ENTRY);
  return list;
}

/**
 * Detect "this is OUR agent-type SessionEnd entry" by checking the
 * inlined prompt for our marker string. Doesn't depend on prompt body
 * surviving verbatim — only the marker line needs to match.
 */
function nestedHasAgentMarker(entry: unknown, marker: string): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as StopHookEntry & StopHookCommand;
  if (typeof e.prompt === "string" && e.prompt.includes(marker)) return true;
  if (Array.isArray(e.hooks)) {
    return e.hooks.some(
      (h) =>
        h &&
        typeof h === "object" &&
        typeof h.prompt === "string" &&
        h.prompt.includes(marker),
    );
  }
  return false;
}

/**
 * The full list of entries the uninstaller / status / mergeSettings
 * walks. Includes opt-in entries AND the legacy Stop entry so:
 *   - uninstall cleans Stop from projects upgraded from earlier snapshots
 *   - mergeSettings strips Stop on `stele hooks install` (no flag) after
 *     an upgrade, even though we don't install it ourselves anymore
 *   - opt-in entries (SessionEnd) are removed when not requested this round
 */
const ALL_KNOWN_ENTRIES: ManagedEntry[] = [LEGACY_STOP_ENTRY, SESSION_START_ENTRY, SESSION_END_ENTRY];

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

function mergeSettings(projectRoot: string, opts: InstallOptions = {}): { note: string } {
  const settings = loadSettings(projectRoot);

  if (!settings.hooks || typeof settings.hooks !== "object") {
    settings.hooks = {} as SettingsShape["hooks"];
  }
  const hooks = settings.hooks as Record<string, unknown>;

  const notes: string[] = [];

  // 0.4.0-snapshot.9 — split path: always-on entries get merged in;
  // opt-out entries that are NOT enabled get REMOVED if previously
  // present (so toggling off via `--enable-...=false` actually takes
  // effect on reinstall).
  const enabled = managedEntriesFor(opts);
  const enabledEvents = new Set(enabled.map((e) => e.event));

  for (const m of enabled) {
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

  // Strip our entries for optional events that the caller did NOT
  // enable this round. Lets `stele hooks install` (no flag) toggle
  // auto-extract OFF if it was previously on.
  for (const m of ALL_KNOWN_ENTRIES) {
    if (enabledEvents.has(m.event)) continue;
    const arr = hooks[m.event];
    if (!Array.isArray(arr)) continue;
    const filtered = (arr as Array<StopHookEntry & StopHookCommand>).filter((e) => !m.isOurs(e));
    if (filtered.length !== arr.length) {
      if (filtered.length === 0) delete hooks[m.event];
      else hooks[m.event] = filtered;
      notes.push(`disabled ${m.event} entry (opt-in not requested this round)`);
    }
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
  // Walk ALL_KNOWN_ENTRIES (not just enabled), so uninstall cleans up
  // opt-in entries regardless of whether the user enabled them this
  // session.
  for (const m of ALL_KNOWN_ENTRIES) {
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
// all known events (incl. opt-ins). Used by hooksStatus().
function settingsHasAnyEntry(settings: SettingsShape): boolean {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  for (const m of ALL_KNOWN_ENTRIES) {
    const arr = hooks[m.event];
    if (Array.isArray(arr) && arr.some((e) => m.isOurs(e))) return true;
  }
  return false;
}

// 0.4.0-snapshot.9 — is the SessionEnd auto-extract opt-in currently
// active in settings.json? Used by hooksStatus + the toggle commands.
function settingsHasSessionEndAutoExtract(settings: SettingsShape): boolean {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const arr = hooks["SessionEnd"];
  if (!Array.isArray(arr)) return false;
  return arr.some((e) => SESSION_END_ENTRY.isOurs(e));
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface InstallReport {
  /** 0.4.0-snapshot.10: Stop hook is gone. This field reports what
   *  install did about it — either "removed legacy" (upgrading from
   *  pre-snapshot.10) or "not present" (fresh install). */
  legacyStopHook: string;
  sessionStartHook: string;
  /** 0.4.0-snapshot.9: opt-in SessionEnd auto-extract. Empty when
   *  not requested; describes the agent file when enabled. */
  sessionEndAutoExtract: string;
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

export function installHooks(
  projectRoot: string,
  opts: InstallOptions = {},
): InstallReport {
  const report: InstallReport = {
    legacyStopHook: "", sessionStartHook: "", sessionEndAutoExtract: "",
    skill: "", steleFeature: "", steleScan: "",
    legacyCommandsCleaned: "", settings: "",
  };

  // 1. Legacy Stop hook cleanup. 0.4.0-snapshot.10 dropped the regex-
  //    based Stop hook entirely — the agent self-governs now. If a
  //    prior snapshot installed the .sh, delete it. settings.json gets
  //    cleaned by mergeSettings below (LEGACY_STOP_ENTRY is in
  //    ALL_KNOWN_ENTRIES, so non-enabled events get their entries
  //    stripped).
  const legacyStopPath = join(projectRoot, LEGACY_STOP_HOOK_PATH_REL);
  if (existsSync(legacyStopPath)) {
    rmSync(legacyStopPath);
    report.legacyStopHook = `removed legacy ${LEGACY_STOP_HOOK_PATH_REL} (Stop hook retired in 0.4.0-snapshot.10; agent self-governs Layer 1)`;
  } else {
    report.legacyStopHook = `Stop hook retired in 0.4.0-snapshot.10 — agent self-governs Layer 1 via the stele-capture skill`;
  }

  // 1b. SessionStart hook script (0.4.0 — read-side inject of open loops
  //     via `stele resume --for-context`)
  const sessionStartPath = join(projectRoot, SESSION_START_HOOK_PATH_REL);
  ensureDir(dirname(sessionStartPath));
  writeFileSync(sessionStartPath, readTemplate("stele-session-start-hook.sh"));
  chmodSync(sessionStartPath, 0o755);
  report.sessionStartHook = `wrote ${SESSION_START_HOOK_PATH_REL} (executable)`;

  // 1c. SessionEnd auto-extract (OPT-IN). Writes the agent definition
  //     file (.claude/agents/stele-extract.md) only when enabled — the
  //     settings.json SessionEnd entry's inlined prompt tells the
  //     subagent to Read this file at runtime. When disabled, neither
  //     the file nor the settings entry exists; the subagent never
  //     spawns; Layer 3 lives in `/stele:scan` (manual).
  const extractPath = join(projectRoot, EXTRACT_AGENT_REL);
  if (opts.sessionEndAutoExtract) {
    ensureDir(dirname(extractPath));
    writeFileSync(extractPath, readTemplate("stele-extract-agent.md"));
    report.sessionEndAutoExtract =
      `wrote ${EXTRACT_AGENT_REL} (SessionEnd auto-extract ENABLED — will block session close up to 60s)`;
  } else {
    // Disabled this round — clean up any previously-installed agent
    // file so the system stays consistent with the settings.json
    // (which mergeSettings strips below).
    if (existsSync(extractPath)) rmSync(extractPath);
    report.sessionEndAutoExtract =
      `SessionEnd auto-extract not enabled — pass --enable-session-end-auto-extract to opt in (Layer 3 lives in /stele:scan otherwise)`;
  }

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

  // 5. Settings merge — pass opts so SessionEnd is included only when
  //    requested. mergeSettings ALSO strips our entries for opt-in
  //    events that weren't enabled this round (so toggling off via
  //    plain `stele hooks install` removes a previously-enabled
  //    SessionEnd entry).
  const s = mergeSettings(projectRoot, opts);
  report.settings = s.note;

  return report;
}

export function uninstallHooks(projectRoot: string): InstallReport {
  const report: InstallReport = {
    legacyStopHook: "", sessionStartHook: "", sessionEndAutoExtract: "",
    skill: "", steleFeature: "", steleScan: "",
    legacyCommandsCleaned: "", settings: "",
  };

  // Legacy Stop hook — same cleanup as install.
  const legacyStopPath = join(projectRoot, LEGACY_STOP_HOOK_PATH_REL);
  if (existsSync(legacyStopPath)) {
    rmSync(legacyStopPath);
    report.legacyStopHook = `removed legacy ${LEGACY_STOP_HOOK_PATH_REL}`;
  } else {
    report.legacyStopHook = `${LEGACY_STOP_HOOK_PATH_REL} not present`;
  }

  const sessionStartPath = join(projectRoot, SESSION_START_HOOK_PATH_REL);
  if (existsSync(sessionStartPath)) {
    rmSync(sessionStartPath);
    report.sessionStartHook = `removed ${SESSION_START_HOOK_PATH_REL}`;
  } else {
    report.sessionStartHook = `${SESSION_START_HOOK_PATH_REL} not present`;
  }

  // SessionEnd opt-in artifacts: agent file + (legacy) snapshot.8
  // wrapper script. Clean both regardless of which was last installed.
  const extractPath = join(projectRoot, EXTRACT_AGENT_REL);
  const legacyWrapperPath = join(projectRoot, ".claude/hooks/stele-session-end.sh");
  const cleaned: string[] = [];
  if (existsSync(extractPath)) { rmSync(extractPath); cleaned.push(EXTRACT_AGENT_REL); }
  if (existsSync(legacyWrapperPath)) { rmSync(legacyWrapperPath); cleaned.push(".claude/hooks/stele-session-end.sh (legacy)"); }
  report.sessionEndAutoExtract = cleaned.length > 0
    ? `removed ${cleaned.join(" + ")}`
    : `SessionEnd auto-extract artifacts not present`;

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
  /** 0.4.0-snapshot.10: TRUE if a legacy stele-stop.sh exists on disk
   *  (upgrade hint). FALSE on fresh installs. The Stop hook is gone in
   *  this release; the field is here so `stele hooks status` can
   *  surface a hint when there's leftover state. */
  legacyStopHookPresent: boolean;
  sessionStartHook: boolean;
  /** 0.4.0-snapshot.9: opt-in SessionEnd auto-extract. True only when
   *  BOTH the agent file AND the settings.json entry are present. */
  sessionEndAutoExtract: boolean;
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
  let settingsHasSessionEnd = false;
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsShape;
      settingsHasEntry = settingsHasAnyEntry(settings);
      settingsHasMinVersion = settings.requiredMinimumVersion === REQUIRED_MIN_VERSION;
      settingsHasSessionEnd = settingsHasSessionEndAutoExtract(settings);
    } catch {
      // ignore — treat as no entry
    }
  }
  const agentFileExists = existsSync(join(projectRoot, EXTRACT_AGENT_REL));
  return {
    legacyStopHookPresent: existsSync(join(projectRoot, LEGACY_STOP_HOOK_PATH_REL)),
    sessionStartHook: existsSync(join(projectRoot, SESSION_START_HOOK_PATH_REL)),
    // Auto-extract is "on" only when BOTH parts agree: settings entry
    // exists AND the agent file (which the inlined prompt Reads) is
    // on disk. Either alone is a broken/half-installed state.
    sessionEndAutoExtract: settingsHasSessionEnd && agentFileExists,
    skill: existsSync(join(projectRoot, SKILL_FILE_REL)),
    steleFeature: existsSync(join(projectRoot, STELE_FEATURE_COMMAND_REL)),
    steleScan: existsSync(join(projectRoot, STELE_SCAN_COMMAND_REL)),
    settingsHasEntry,
    settingsHasMinVersion,
  };
}

/**
 * 0.4.0-snapshot.9 — enable the SessionEnd auto-extract opt-in
 * incrementally (without re-running the full install). Writes the
 * agent file and merges the SessionEnd entry. Idempotent.
 */
export function enableSessionEndAutoExtract(projectRoot: string): InstallReport {
  return installHooks(projectRoot, { sessionEndAutoExtract: true });
}

/**
 * 0.4.0-snapshot.9 — disable the SessionEnd auto-extract opt-in
 * without touching the always-on hooks. Removes the agent file and
 * strips the SessionEnd entry from settings.json. Idempotent.
 */
export function disableSessionEndAutoExtract(projectRoot: string): InstallReport {
  return installHooks(projectRoot, { sessionEndAutoExtract: false });
}
