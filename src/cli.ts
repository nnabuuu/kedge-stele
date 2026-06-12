#!/usr/bin/env -S node --no-warnings
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Store } from "./store.ts";
import { proposeEdges } from "./consolidate.ts";
import {
  continueLast,
  featureDetail,
  featureSummary,
  nodeState,
  projectRollup,
  resumeDigest,
  trace,
  traceEntity,
  type WaitingItem,
} from "./projections.ts";
import {
  recordSessionEnd,
  recordSessionStart,
} from "./capture.ts";
import { renderResume } from "./render.ts";
import { stubResolver } from "./resolver.ts";
import { resolveDbPath, SteleNotInitializedError } from "./paths.ts";
import { startServerForeground } from "./serve.ts";
import { installHooks, uninstallHooks, hooksStatus } from "./hooks.ts";
import { installDaemon, uninstallDaemon, daemonStatus } from "./daemon.ts";
import {
  t,
  setDefaultLocale,
  localeFromEnv,
  isLocale,
  SUPPORTED_LOCALES,
} from "./i18n.ts";
import {
  allProjects,
  register as registerProject,
  unregister as unregisterProject,
} from "./registry.ts";
import { createHash } from "node:crypto";
import {
  applyCaptureTags,
  confirmProposal,
  ensureTag,
  getTagPolicy,
  getTagRequireReason,
  rejectProposal,
} from "./tags.ts";
import type {
  CapturePayload,
  CaptureSourceSession,
  EdgeRelation,
  EntityRef,
  Feature,
  FeatureState,
  PauseReason,
  Project,
  ProjectStatus,
  SessionOutcome,
  SessionProvenance,
  TaggingTargetKind,
} from "./types.ts";

function readStdin(): string {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

/**
 * Print the package version from package.json. Walks up from this script's
 * directory (works for both `dist/cli.js` and `src/cli.ts` layouts) to find
 * the nearest package.json with `"name": "stele-mcp"`.
 */
function printVersion(): void {
  // import.meta.url → file:// URL of this script; convert to a dir path
  // then walk up.
  const here = dirname(new URL(import.meta.url).pathname);
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as
          { name?: string; version?: string };
        if (pkg.name === "stele-mcp" && pkg.version) {
          console.log(`stele-mcp ${pkg.version}`);
          return;
        }
      } catch {
        // fall through to parent
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  console.log(t("cli.version.unknown"));
}

// =============================================================================
// `stele resume --for-context` formatter (0.4.0)
//
// Declarative prose for the SessionStart hook stdout. The doc's prompt-
// injection warning is the load-bearing constraint here: Claude Code's
// defense flags imperative system text and surfaces it raw to the user,
// instead of treating it as context. So we write in 陈述句 + close with an
// explicit "this is state, not a directive" line.
//
// Empty list → empty string (the hook contributes no context). The hook
// script also handles the no-stele / no-project case.
// =============================================================================
function ageLabel(days: number): string {
  if (days === 0) return t("cli.resume_context.age_today");
  if (days === 1) return t("cli.resume_context.age_one_day");
  if (days < 30) return t("cli.resume_context.age_days", { count: days });
  return t("cli.resume_context.age_months", { count: Math.round(days / 30) });
}

export function formatResumeForContext(items: WaitingItem[]): string {
  if (items.length === 0) return "";
  const lines: string[] = [];
  lines.push(t("cli.resume_context.header", { count: items.length }, items.length));
  lines.push("");
  for (const i of items) {
    const age = ageLabel(i.ageDays);
    const verbed = i.bucket === "deferred"
      ? t("cli.resume_context.deferred_at", { age })
      : t("cli.resume_context.raised_at", { age });
    const review = i.trigger
      ? t("cli.resume_context.review_when", { trigger: i.trigger })
      : (i.needsCheck ? t("cli.resume_context.needs_check") : "");
    const tail = review ? `。${review}` : "。";
    lines.push(`  ${i.id}「${i.title}」 — ${verbed}${tail}`);
  }
  lines.push("");
  lines.push(t("cli.resume_context.disclaimer"));
  return lines.join("\n") + "\n";
}

// -----------------------------------------------------------------------------
// stele init — bootstrap a project: .stele/ + .stele/README.md + .gitignore
// entry + .mcp.json with the stele server registered.
// -----------------------------------------------------------------------------

const STELE_README = `# .stele/ — decision store for this project

This directory was created by \`stele init\`. It holds **decisions.db**, a
SQLite store of decision provenance for this project: every decision made
about the codebase — what was chosen, what was deferred, what's still
open — lives here as a node in a graph.

## Daily use

Open Claude Code in this project. When a decision crystallizes in the
conversation, type \`/decision\` — the agent drafts the full record and
asks you to confirm.

To see what's waiting on you, ask: *"what's waiting on me?"* The agent
calls \`decision_resume\` and surfaces every open + un-resolved deferred
node, with the most-likely-due ones first.

## Cross-project view

If you organize multiple projects under one parent directory, run
\`stele init\` in the parent too. Decisions captured from any
subdirectory roll up into the parent's \`.stele/\`, giving you a global
view across all the projects under it.

## Backup

\`decisions.db\` is a regular SQLite file. Copy it while no MCP server
is connected. For a hot backup:

    sqlite3 decisions.db ".backup target.db"

## Sharing with a team

By default \`stele init\` adds \`.stele/\` to your project's \`.gitignore\`.
To share decisions with collaborators via git, remove that entry — the
DB file is small and version-friendly for small teams.

---

*Auto-generated by \`stele init\`. Safe to edit or delete. The tool
itself was installed via \`npm install -g stele-mcp\`.*
`;

async function initCommand(args: string[]): Promise<void> {
  let skipDaemon = false;
  let skipHooks = false;
  // 0.4.0-snapshot.9: opt-in flag for SessionEnd auto-extract. Off
  // by default — Layer 3 lives in /stele:scan otherwise.
  let enableSessionEndAutoExtract = false;
  let port = 3939;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--skip-daemon") skipDaemon = true;
    else if (a === "--skip-hooks") skipHooks = true;
    else if (a === "--enable-session-end-auto-extract") enableSessionEndAutoExtract = true;
    else if (a === "--port") {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        console.error(t("cli.init.invalid_port", { value: args[i] }));
        process.exit(1);
      }
      port = n;
    } else {
      console.error(t("cli.init.unknown_flag", { flag: a }));
      process.exit(1);
    }
  }

  const cwd = process.cwd();
  const steleDir = join(cwd, ".stele");

  if (existsSync(steleDir)) {
    console.error(t("cli.init.already_initialized", { path: steleDir }));
    console.error(t("cli.init.reset_hint"));
    process.exit(1);
  }

  mkdirSync(steleDir, { recursive: true });
  writeFileSync(join(steleDir, "README.md"), STELE_README);

  // 0.1.0 — bootstrap the Project DB row + unscoped Feature so the
  // capture flow has a real Feature → Feature → Session → Decision chain
  // to bind to from the very first decision.
  {
    const store = new Store(join(steleDir, "decisions.db"));
    if (!store.theProject()) {
      const id = store.nextProjectId();
      const projectName = basename(cwd) || "project";
      const code = projectName.toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 24);
      const p: Project = {
        id, name: projectName, code, path: cwd,
        status: "active", createdAt: new Date().toISOString(),
      };
      store.putProject(p);
      store.ensureUnscopedFeature(p.id);
    }
  }

  const gitignorePath = join(cwd, ".gitignore");
  let gitignoreNote = "";
  if (existsSync(gitignorePath)) {
    const current = readFileSync(gitignorePath, "utf8");
    if (!/^\.stele\/?$/m.test(current)) {
      const sep = current.endsWith("\n") || current.length === 0 ? "" : "\n";
      writeFileSync(gitignorePath, current + sep + ".stele/\n");
      gitignoreNote = t("cli.init.gitignore_added");
    } else {
      gitignoreNote = t("cli.init.gitignore_already");
    }
  } else {
    writeFileSync(gitignorePath, ".stele/\n");
    gitignoreNote = t("cli.init.gitignore_written");
  }

  const mcpPath = join(cwd, ".mcp.json");
  let mcpConfig: { mcpServers?: Record<string, unknown> } = { mcpServers: {} };
  let mcpNote = t("cli.init.mcp_written");
  if (existsSync(mcpPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(mcpPath, "utf8"));
    } catch {
      console.error(t("cli.init.mcp_invalid_json"));
      process.exit(1);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.error(t("cli.init.mcp_not_object"));
      process.exit(1);
    }
    mcpConfig = parsed as typeof mcpConfig;
    if (!mcpConfig.mcpServers || typeof mcpConfig.mcpServers !== "object") {
      mcpConfig.mcpServers = {};
    }
    mcpNote = mcpConfig.mcpServers!.stele
      ? t("cli.init.mcp_updated")
      : t("cli.init.mcp_merged");
  }
  mcpConfig.mcpServers!.stele = { command: "stele-mcp" };
  writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n");

  console.log(t("cli.init.created", { path: steleDir }));
  console.log(``);
  console.log(`  ${t("cli.init.wrote_readme")}`);
  console.log(`  ${mcpNote}`);
  console.log(`  ${gitignoreNote}`);

  // Register this project in the global registry so the multi-tenant daemon
  // can route /<slug>/ to it.
  let projectSlug: string;
  try {
    const reg = registerProject(cwd);
    projectSlug = reg.slug;
    console.log(`  ${t(reg.isNew ? "cli.init.slug_registered" : "cli.init.slug_already_registered", { slug: reg.slug })}`);
  } catch (e) {
    projectSlug = "<this-project>";
    console.error(`  ${t("cli.init.registry_failed", { reason: (e as Error).message })}`);
  }

  // Default-install hooks (Stop + SessionStart + stele-capture skill +
  // /stele:feature + /stele:scan slash commands). SessionEnd auto-
  // extract is opt-in via --enable-session-end-auto-extract.
  // — opt-out everything with --skip-hooks
  if (!skipHooks) {
    try {
      const r = installHooks(cwd, { sessionEndAutoExtract: enableSessionEndAutoExtract });
      console.log(`  ${r.legacyStopHook}`);
      console.log(`  ${r.sessionStartHook}`);
      console.log(`  ${r.sessionEndAutoExtract}`);
      console.log(`  ${r.skill}`);
      console.log(`  ${r.steleFeature}`);
      console.log(`  ${r.steleScan}`);
      console.log(`  ${r.legacyCommandsCleaned}`);
      console.log(`  ${r.settings}`);
    } catch (e) {
      console.error(`  ${t("cli.init.hooks_failed", { reason: (e as Error).message })}`);
    }
  }

  // Default-install daemon (launchd / systemd) — opt-out with --skip-daemon.
  // Install is idempotent: if already installed, nothing happens but legacy
  // per-project plists/units (from pre-0.0.3) get swept and their projects
  // get registered into the global registry.
  if (!skipDaemon) {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      console.log(`  ${t("cli.init.daemon_unsupported_platform", { platform: process.platform })}`);
    } else {
      try {
        const r = await installDaemon({ port });
        console.log(`  ${t("cli.init.daemon_installed", { platform: r.platform, port: r.port, loaded: t(r.loaded ? "cli.init.loaded_yes" : "cli.init.loaded_no") })}`);
        for (const n of r.notes) console.log(`    · ${n}`);
      } catch (e) {
        console.error(`  ${t("cli.init.daemon_failed", { reason: (e as Error).message })}`);
        console.error(`    ${t("cli.init.daemon_retry_hint")}`);
      }
    }
  }

  console.log(``);
  console.log(t("cli.init.next_header"));
  console.log(`  ${t("cli.init.next_restart")}`);
  if (skipDaemon) {
    console.log(`  ${t("cli.init.next_serve_manual")}`);
  } else {
    console.log(`  ${t("cli.init.next_open_daemon", { port, slug: projectSlug })}`);
  }
  console.log(`  ${t("cli.init.next_ask")}`);
}

// -----------------------------------------------------------------------------

function hooksCommand(args: string[]): void {
  const sub = args[0];
  const cwd = process.cwd();
  if (sub === "install") {
    // 0.4.0-snapshot.9: accept --enable-session-end-auto-extract here
    // too so re-runs on an existing project can flip the opt-in on.
    const enableSessionEndAutoExtract = args.includes("--enable-session-end-auto-extract");
    try {
      const r = installHooks(cwd, { sessionEndAutoExtract: enableSessionEndAutoExtract });
      console.log(t("cli.hooks_cmd.installed_header", { cwd }));
      console.log(`  ${r.legacyStopHook}`);
      console.log(`  ${r.sessionStartHook}`);
      console.log(`  ${r.sessionEndAutoExtract}`);
      console.log(`  ${r.skill}`);
      console.log(`  ${r.steleFeature}`);
      console.log(`  ${r.steleScan}`);
      console.log(`  ${r.legacyCommandsCleaned}`);
      console.log(`  ${r.settings}`);
    } catch (e) {
      console.error(t("cli.hooks_cmd.install_failed", { reason: (e as Error).message }));
      process.exit(1);
    }
  } else if (sub === "uninstall") {
    try {
      const r = uninstallHooks(cwd);
      console.log(t("cli.hooks_cmd.uninstalled_header", { cwd }));
      console.log(`  ${r.legacyStopHook}`);
      console.log(`  ${r.sessionStartHook}`);
      console.log(`  ${r.sessionEndAutoExtract}`);
      console.log(`  ${r.skill}`);
      console.log(`  ${r.steleFeature}`);
      console.log(`  ${r.steleScan}`);
      console.log(`  ${r.legacyCommandsCleaned}`);
      console.log(`  ${r.settings}`);
    } catch (e) {
      console.error(t("cli.hooks_cmd.uninstall_failed", { reason: (e as Error).message }));
      process.exit(1);
    }
  } else if (sub === "enable") {
    // 0.4.0-snapshot.9: stele hooks enable <feature>
    const feature = args[1];
    if (feature !== "session-end-auto-extract") {
      console.error(t("cli.hooks_cmd.unknown_feature", { feature: feature ?? "(none)" }));
      process.exit(1);
    }
    try {
      const r = installHooks(cwd, { sessionEndAutoExtract: true });
      console.log(t("cli.hooks_cmd.enabled_header", { cwd }));
      console.log(`  ${r.sessionEndAutoExtract}`);
      console.log(`  ${r.settings}`);
      console.log("");
      console.log(t("cli.hooks_cmd.enable_warn_1"));
      console.log(t("cli.hooks_cmd.enable_warn_2"));
      console.log(t("cli.hooks_cmd.enable_warn_3"));
    } catch (e) {
      console.error(t("cli.hooks_cmd.enable_failed", { reason: (e as Error).message }));
      process.exit(1);
    }
  } else if (sub === "disable") {
    const feature = args[1];
    if (feature !== "session-end-auto-extract") {
      console.error(t("cli.hooks_cmd.unknown_feature", { feature: feature ?? "(none)" }));
      process.exit(1);
    }
    try {
      const r = installHooks(cwd, { sessionEndAutoExtract: false });
      console.log(t("cli.hooks_cmd.disabled_header", { cwd }));
      console.log(`  ${r.sessionEndAutoExtract}`);
      console.log(`  ${r.settings}`);
      console.log("");
      console.log(t("cli.hooks_cmd.disabled_layer3_hint"));
    } catch (e) {
      console.error(t("cli.hooks_cmd.disable_failed", { reason: (e as Error).message }));
      process.exit(1);
    }
  } else if (sub === "status" || sub === undefined) {
    const s = hooksStatus(cwd);
    const mark = (b: boolean) => (b ? "✓" : "✗");
    console.log(t("cli.hooks_cmd.status_header", { cwd }));
    console.log(`  ${mark(s.sessionStartHook)}  .claude/hooks/stele-session-start.sh`);
    console.log(`  ${mark(s.sessionEndAutoExtract)}  ${t("cli.hooks_cmd.status_session_end_label")}`);
    console.log(`  ${mark(s.skill)}  .claude/skills/stele-capture/SKILL.md`);
    console.log(`  ${mark(s.steleFeature)}  .claude/commands/stele/feature.md`);
    console.log(`  ${mark(s.steleScan)}  .claude/commands/stele/scan.md`);
    console.log(`  ${mark(s.settingsHasEntry)}  ${t("cli.hooks_cmd.status_settings_label")}`);
    console.log(`  ${mark(s.settingsHasMinVersion)}  ${t("cli.hooks_cmd.status_min_version_label")}`);
    if (s.legacyStopHookPresent) {
      console.log("");
      console.log(t("cli.hooks_cmd.legacy_warn_1"));
      console.log(t("cli.hooks_cmd.legacy_warn_2"));
      console.log(t("cli.hooks_cmd.legacy_warn_3"));
    }
    if (!s.sessionEndAutoExtract) {
      console.log("");
      console.log(t("cli.hooks_cmd.enable_hint"));
    }
  } else {
    console.error(t("cli.hooks_cmd.unknown_subcommand", { sub: sub ?? "" }));
    process.exit(1);
  }
}

async function daemonCommand(args: string[]): Promise<void> {
  const sub = args[0];

  // Parse flags from args[1..]
  let port = 3939;
  let printUnit = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--port") {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        console.error(t("cli.init.invalid_port", { value: args[i] }));
        process.exit(1);
      }
      port = n;
    } else if (a === "--print-unit") {
      printUnit = true;
    } else {
      console.error(t("cli.daemon_cmd.unknown_flag", { flag: a }));
      process.exit(1);
    }
  }

  if (sub === "install") {
    try {
      const r = await installDaemon({ port, printUnit });
      if (printUnit) return; // unit printed to stdout already
      console.log(t("cli.daemon_cmd.installed_header", { platform: r.platform }));
      console.log(`  unit:       ${r.unitPath}`);
      console.log(`  invocation: ${r.invocation}`);
      console.log(`  port:       ${r.port}`);
      console.log(`  loaded:     ${t(r.loaded ? "cli.init.loaded_yes" : "cli.init.loaded_no")}`);
      for (const n of r.notes) console.log(`  · ${n}`);
      if (r.legacy.registered.length > 0) {
        console.log(`  ${t("cli.daemon_cmd.imported_legacy")}`);
        for (const p of r.legacy.registered) console.log(`      ${p}`);
      }
      if (r.loaded) console.log(`\n  → http://127.0.0.1:${r.port}/`);
    } catch (e) {
      console.error(t("cli.daemon_cmd.install_failed", { reason: (e as Error).message }));
      process.exit(1);
    }
  } else if (sub === "uninstall") {
    const r = uninstallDaemon();
    console.log(t("cli.daemon_cmd.uninstalled_header"));
    for (const n of r.notes) console.log(`  · ${n}`);
  } else if (sub === "status" || sub === undefined) {
    const s = daemonStatus();
    const n = allProjects().length;
    console.log(t("cli.daemon_cmd.status_header"));
    console.log(`  platform:           ${s.platform}`);
    console.log(`  unit file:          ${s.unitPresent ? "✓" : "✗"} ${s.unitPath}`);
    console.log(`  loaded:             ${s.loaded ? "✓" : "✗"} (${s.loadedNote})`);
    console.log(`  ${t("cli.daemon_cmd.status_registered_projects", { count: n })}`);
  } else {
    console.error(t("cli.daemon_cmd.unknown_subcommand", { sub: sub ?? "" }));
    process.exit(1);
  }
}

function projectsCommand(args: string[]): void {
  const sub = args[0];
  if (sub === undefined || sub === "list") {
    const projects = allProjects();
    if (projects.length === 0) {
      console.log(t("cli.projects.none_registered"));
      return;
    }
    console.log(t("cli.projects.registered_count", { count: projects.length }));
    const w = Math.max(...projects.map((p) => p.slug.length));
    for (const p of projects) {
      console.log(`  ${p.slug.padEnd(w)}  ${p.path}`);
    }
  } else if (sub === "remove") {
    const target = args[1];
    if (!target) {
      console.error(t("cli.projects.remove_usage"));
      process.exit(1);
    }
    const removed = unregisterProject(target);
    if (removed) console.log(t("cli.projects.removed", { target }));
    else {
      console.error(t("cli.projects.not_found", { target }));
      process.exit(1);
    }
  } else {
    console.error(t("cli.projects.unknown_subcommand", { sub: sub ?? "" }));
    process.exit(1);
  }
}

async function serveCommand(args: string[]): Promise<void> {
  let port = 3939;
  let host = "127.0.0.1";
  let open = false;
  let multi = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port") {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        console.error(t("cli.init.invalid_port", { value: args[i] }));
        process.exit(1);
      }
      port = n;
    } else if (a === "--host") {
      host = args[++i];
      if (!host) {
        console.error(t("cli.serve.host_requires_value"));
        process.exit(1);
      }
    } else if (a === "--open") {
      open = true;
    } else if (a === "--multi") {
      multi = true;
    } else {
      console.error(t("cli.serve.unknown_flag", { flag: a }));
      process.exit(1);
    }
  }
  if (multi) {
    await startServerForeground({ multi: true, port, host, open });
    return;
  }
  // Single-project mode: resolve a store from cwd
  let store: Store;
  try {
    store = new Store(resolveDbPath());
  } catch (e) {
    if (e instanceof SteleNotInitializedError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  await startServerForeground({ store, port, host, open });
}

// -----------------------------------------------------------------------------
// 0.1.0 — stele features {list, open, report, show, set-state}
// (close retired — state advances via the /feature-report flow)
// -----------------------------------------------------------------------------

function parseFeatureState(v: string | undefined): FeatureState {
  if (v === "draft" || v === "going" || v === "winding" || v === "done" || v === "paused") return v;
  console.error(t("cli.features.invalid_state", { value: v ?? "" }));
  process.exit(1);
}

function featuresCommand(store: Store, args: string[]): void {
  const sub = args[0];

  if (sub === undefined || sub === "list") {
    let json = false;
    let state: FeatureState | undefined;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === "--json") json = true;
      else if (a === "--state") state = parseFeatureState(args[++i]);
      else {
        console.error(t("cli.features_cmd.unknown_flag", { flag: a }));
        process.exit(1);
      }
    }
    const summary = featureSummary(store);
    const filtered = state ? summary.filter((m) => m.feature.state === state) : summary;
    if (json) {
      process.stdout.write(JSON.stringify(filtered, null, 2) + "\n");
      return;
    }
    if (filtered.length === 0) {
      console.log(t("cli.features_cmd.no_features"));
      return;
    }
    for (const m of filtered) {
      const lo = m.openLoops > 0
        ? t("cli.features_cmd.open_loop_suffix", { count: m.openLoops }, m.openLoops)
        : "";
      const sessionLabel = t("cli.features_cmd.session_label", { count: m.sessionCount }, m.sessionCount);
      console.log(
        `  ${m.feature.id}  [${m.feature.state.padEnd(7)}]  ${m.feature.name}  (${sessionLabel}${lo})`,
      );
    }
    return;
  }

  if (sub === "open") {
    const name = args[1];
    if (!name) {
      console.error(t("cli.features_cmd.open_usage"));
      process.exit(1);
    }
    let about: string | undefined;
    for (let i = 2; i < args.length; i++) {
      const a = args[i];
      if (a === "--about") about = args[++i];
      else {
        console.error(t("cli.features_cmd.unknown_flag", { flag: a }));
        process.exit(1);
      }
    }
    const project = store.theProject();
    if (!project) {
      console.error(t("cli.features_cmd.no_project"));
      process.exit(1);
    }
    const id = store.nextFeatureId();
    const m: Feature = {
      id, projectId: project.id, name, state: "draft", about,
      startedAt: new Date().toISOString(),
    };
    store.putFeature(m);
    console.log(t("cli.features_cmd.opened", { id, name }));
    return;
  }

  if (sub === "set-state") {
    const id = args[1];
    const state = parseFeatureState(args[2]);
    if (!id) {
      console.error(t("cli.features_cmd.set_state_usage"));
      process.exit(1);
    }
    if (!store.getFeature(id)) {
      console.error(t("cli.features_cmd.not_found", { id }));
      process.exit(1);
    }
    store.setFeatureState(id, state);
    console.log(`${id} → ${state}`);
    return;
  }

  if (sub === "complete") {
    const id = args[1];
    if (!id) {
      console.error(t("cli.features_cmd.complete_usage"));
      process.exit(1);
    }
    if (!store.getFeature(id)) {
      console.error(t("cli.features_cmd.not_found", { id }));
      process.exit(1);
    }
    const ri = args.indexOf("--reason");
    const reason = ri >= 0 ? args[ri + 1] : undefined;
    const { closed } = store.markFeatureComplete(id, { by: "cli", reason });
    console.log(`${id} → done · closed ${closed.length} loop${closed.length === 1 ? "" : "s"}`);
    return;
  }

  if (sub === "report") {
    const id = args[1];
    if (!id) {
      console.error(t("cli.features_cmd.report_usage"));
      process.exit(1);
    }
    const m = store.getFeature(id);
    if (!m) {
      console.error(t("cli.features_cmd.not_found", { id }));
      process.exit(1);
    }
    const openLoops = store
      .decisionsInFeature(id)
      .filter((d) => {
        const ns = nodeState(d);
        return ns === "open" || ns === "deferred";
      });
    console.log(t("cli.features_cmd.report_header", { id, name: m.name }));
    console.log(`  state: ${m.state}`);
    console.log(`  ${t("cli.features_cmd.report_open_loops", { count: openLoops.length })}`);
    for (const d of openLoops) console.log(`    ${d.id}  [${d.type}]  ${d.title}`);
    console.log(``);
    console.log(t("cli.features_cmd.report_next_1"));
    console.log(t("cli.features_cmd.report_next_2"));
    return;
  }

  if (sub === "show") {
    const id = args[1];
    if (!id) {
      console.error(t("cli.features_cmd.show_usage"));
      process.exit(1);
    }
    const detail = featureDetail(store, id);
    if (!detail) {
      console.error(t("cli.features_cmd.not_found", { id }));
      process.exit(1);
    }
    console.log(`${detail.feature.id}  ${detail.feature.name}  [${detail.feature.state}]`);
    if (detail.feature.about) console.log(`  about: ${detail.feature.about}`);
    console.log(`  started: ${detail.feature.startedAt}`);
    if (detail.feature.completedAt) console.log(`  completed: ${detail.feature.completedAt}`);
    console.log();
    for (const { session, decisions } of detail.sessions) {
      const decisionLabel = t("cli.features_cmd.decision_label", { count: decisions.length }, decisions.length);
      console.log(`  ${session.id}  (${session.source}${session.sourceSessionId ? `, ${session.sourceSessionId.slice(0, 8)}` : ""})  ${decisionLabel}`);
      for (const d of decisions) {
        console.log(`    ${d.id.padEnd(20)} ${nodeState(d).padEnd(11)} ${d.title}`);
      }
    }
    return;
  }

  console.error(t("cli.features_cmd.unknown_subcommand", { sub: sub ?? "" }));
  process.exit(1);
}

// -----------------------------------------------------------------------------
// 0.1.0 — stele sessions {list, start, end, resume, continue}
// -----------------------------------------------------------------------------

function sessionsCommand(store: Store, args: string[]): void {
  const sub = args[0] ?? "list";

  if (sub === "list") {
    const featureFlag = args.indexOf("--feature");
    if (featureFlag >= 0) {
      const mid = args[featureFlag + 1];
      if (!mid) {
        console.error(t("cli.sessions.feature_requires_value"));
        process.exit(1);
      }
      const sessions = store.sessionsInFeature(mid);
      for (const s of sessions) {
        console.log(`  ${s.id}  ${s.source}  started=${s.startedAt}${s.endedAt ? `  ended=${s.endedAt}` : ""}`);
      }
      return;
    }
    // Fallback: list latest session per feature via latestSession()
    const latest = store.latestSession();
    if (!latest) {
      console.log(t("cli.sessions.none_yet"));
      return;
    }
    console.log(t("cli.sessions.latest_line", { id: latest.id, feature: latest.featureId }));
    if (latest.outcome) console.log(`  outcome: ${latest.outcome.type}  ${latest.outcome.summary ?? ""}`);
    if (latest.pauseReason) console.log(`  paused:  ${latest.pauseReason.kind}  ${latest.pauseReason.note ?? ""}`);
    return;
  }

  if (sub === "start") {
    // Stdin JSON for the full body
    const raw = readStdin();
    if (!raw) {
      console.error(t("cli.sessions.start_usage"));
      process.exit(1);
    }
    const body = JSON.parse(raw) as {
      featureId: string;
      sourceSession: CaptureSourceSession;
      provenance?: SessionProvenance;
    };
    const s = recordSessionStart(store, body.featureId, body.sourceSession, body.provenance);
    console.log(t("cli.sessions.opened", { id: s.id, feature: s.featureId }));
    return;
  }

  if (sub === "end") {
    const sid = args[1];
    if (!sid) {
      console.error(t("cli.sessions.end_usage_id"));
      process.exit(1);
    }
    const raw = readStdin();
    if (!raw) {
      console.error(t("cli.sessions.end_usage_body"));
      process.exit(1);
    }
    const body = JSON.parse(raw) as { outcome: SessionOutcome; pauseReason?: PauseReason };
    const s = recordSessionEnd(store, sid, body.outcome, body.pauseReason);
    console.log(t("cli.sessions.closed", { id: s.id, outcome: s.outcome?.type ?? "", pause: s.pauseReason ? `  pause=${s.pauseReason.kind}` : "" }));
    return;
  }

  if (sub === "resume") {
    const sid = args[1];
    if (!sid) {
      console.error(t("cli.sessions.resume_usage"));
      process.exit(1);
    }
    const s = store.getSession(sid);
    if (!s) {
      console.error(t("cli.sessions.not_found", { id: sid }));
      process.exit(1);
    }
    const layoutAlive = s.provenance?.layoutAlive ?? false;
    const cwd = s.provenance?.cwd ?? process.cwd();
    const ccSid = s.sourceSessionId ?? "<no-session-id>";
    const mode = layoutAlive ? "jump" : "rebuild";
    console.log(`mode: ${mode}`);
    console.log(`cd ${cwd} && claude --resume ${ccSid}`);
    return;
  }

  if (sub === "continue") {
    const r = continueLast(store);
    if (!r) {
      console.log(t("cli.sessions.none_yet"));
      return;
    }
    console.log(t("cli.sessions.continue_last", { id: r.session.id, feature: r.feature.id, name: r.feature.name }));
    if (r.lastOutcome) console.log(`  outcome: ${r.lastOutcome.type}  ${r.lastOutcome.summary ?? ""}`);
    if (r.lastPauseReason) console.log(`  paused:  ${r.lastPauseReason.kind}  ${r.lastPauseReason.note ?? ""}`);
    const layoutAlive = r.session.provenance?.layoutAlive ?? false;
    const cwd = r.session.provenance?.cwd ?? process.cwd();
    const ccSid = r.session.sourceSessionId ?? "<no-session-id>";
    const mode = layoutAlive ? "jump" : "rebuild";
    console.log(``);
    console.log(t("cli.sessions.resume_header", { mode }));
    console.log(`  cd ${cwd} && claude --resume ${ccSid}`);
    return;
  }

  console.error(t("cli.sessions.unknown_subcommand", { sub: sub ?? "" }));
  process.exit(1);
}

// -----------------------------------------------------------------------------
// 0.1.0 — stele project (singular: the current project's DB row)
// -----------------------------------------------------------------------------

function parseProjectStatus(v: string | undefined): ProjectStatus {
  if (v === "active" || v === "winding" || v === "dormant" || v === "archived") return v;
  console.error(t("cli.project_status.invalid", { value: v ?? "" }));
  process.exit(1);
}

function projectCommand(store: Store, args: string[]): void {
  const sub = args[0] ?? "show";

  if (sub === "show") {
    const project = store.theProject();
    if (!project) {
      console.error(t("cli.project.none"));
      process.exit(1);
    }
    const r = projectRollup(store, project.id);
    console.log(`${project.id}  ${project.name}  [${project.status}]`);
    if (project.code) console.log(`  code:    ${project.code}`);
    console.log(`  path:    ${project.path}`);
    console.log(`  created: ${project.createdAt}`);
    if (r) {
      console.log(`  ${t("cli.project.rollup", { features: r.featureCount, decisions: r.decisionCount, open: r.openLoops, due: r.dueLoops })}`);
      const states = Object.entries(r.featuresByState).filter(([, n]) => n > 0).map(([s, n]) => `${s}=${n}`).join(", ");
      if (states) console.log(`  states: ${states}`);
    }
    return;
  }

  if (sub === "set-status") {
    const project = store.theProject();
    if (!project) {
      console.error(t("cli.project.none"));
      process.exit(1);
    }
    const next = parseProjectStatus(args[1]);
    const updated: Project = { ...project, status: next };
    store.putProject(updated);
    console.log(`${project.id}: ${project.status} → ${next}`);
    return;
  }

  console.error(t("cli.project.unknown_subcommand", { sub }));
  process.exit(1);
}

// -----------------------------------------------------------------------------
// 0.0.7 — stele tags <list|propose|apply|confirm|reject|recolor|rename|archive|restore|proposals>
// -----------------------------------------------------------------------------

function parseTarget(spec: string | undefined): { kind: TaggingTargetKind; id: string } {
  if (!spec) {
    console.error(t("cli.tags.target_required"));
    process.exit(1);
  }
  const idx = spec.indexOf(":");
  if (idx <= 0) {
    console.error(t("cli.tags.target_bad_format", { spec }));
    process.exit(1);
  }
  const kind = spec.slice(0, idx);
  const id = spec.slice(idx + 1);
  if (kind !== "decision" && kind !== "feature") {
    console.error(t("cli.tags.target_bad_kind", { kind }));
    process.exit(1);
  }
  return { kind, id };
}

function tagsCommand(store: Store, args: string[]): void {
  const sub = args[0] ?? "list";

  if (sub === "list") {
    let status: "active" | "archived" | "all" = "active";
    let json = false;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--all") status = "all";
      else if (args[i] === "--archived") status = "archived";
      else if (args[i] === "--active") status = "active";
      else if (args[i] === "--json") json = true;
      else {
        console.error(t("cli.tags_cmd.unknown_flag", { flag: args[i] }));
        process.exit(1);
      }
    }
    const list = status === "all" ? store.allTags() : store.allTags(status);
    if (json) {
      const enriched = list.map((tag) => ({ ...tag, targetCount: store.targetsForTag(tag.id).length }));
      process.stdout.write(JSON.stringify(enriched, null, 2) + "\n");
      return;
    }
    if (list.length === 0) {
      const noKey = status === "active" ? "cli.tags_cmd.no_tags_active"
        : status === "archived" ? "cli.tags_cmd.no_tags_archived"
        : "cli.tags_cmd.no_tags_all";
      console.log(t(noKey));
      return;
    }
    for (const tag of list) {
      const targets = store.targetsForTag(tag.id);
      const targetLabel = t("cli.tags_cmd.target_count", { count: targets.length }, targets.length);
      console.log(
        `  ${tag.id.padEnd(14)} ${tag.color}  ${tag.status.padEnd(8)} ${tag.origin.padEnd(5)}  ${tag.name}  (${targetLabel})`,
      );
    }
    return;
  }

  if (sub === "proposals") {
    let outcome: "pending" | "blocked" | "auto_adopted" | undefined = "pending";
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--all") outcome = undefined;
      else if (args[i] === "--pending") outcome = "pending";
      else if (args[i] === "--blocked") outcome = "blocked";
      else if (args[i] === "--adopted") outcome = "auto_adopted";
      else {
        console.error(t("cli.tags_cmd.unknown_flag", { flag: args[i] }));
        process.exit(1);
      }
    }
    const list = store.allTagProposals(outcome);
    if (list.length === 0) {
      console.log(outcome
        ? t("cli.tags_cmd.no_proposals_filtered", { outcome })
        : t("cli.tags_cmd.no_proposals_all"));
      return;
    }
    for (const p of list) {
      const targetLabel = t("cli.tags_cmd.target_count", { count: p.targets.length }, p.targets.length);
      console.log(`  ${p.id.padEnd(12)} [${p.outcome.padEnd(12)}] ${p.name}  → ${targetLabel}`);
      if (p.reason) console.log(`        ${t("cli.tags_cmd.proposal_reason", { reason: p.reason })}`);
    }
    return;
  }

  if (sub === "propose") {
    const name = args[1];
    if (!name) {
      console.error(t("cli.tags_cmd.propose_usage"));
      process.exit(1);
    }
    let reason: string | undefined;
    let suggestedColor: string | undefined;
    const targets: { kind: TaggingTargetKind; id: string }[] = [];
    for (let i = 2; i < args.length; i++) {
      const a = args[i];
      if (a === "--reason") reason = args[++i];
      else if (a === "--color") suggestedColor = args[++i];
      else if (a === "--target") targets.push(parseTarget(args[++i]));
      else {
        console.error(t("cli.tags_cmd.unknown_flag", { flag: a }));
        process.exit(1);
      }
    }
    if (targets.length === 0) {
      console.error(t("cli.tags_cmd.propose_target_required"));
      process.exit(1);
    }
    try {
      const r = ensureTag(store, name, { reason, suggestedColor, targets });
      if (r.kind === "active") console.log(t("cli.tags_cmd.propose_applied", { id: r.tag.id, name: r.tag.name }));
      else if (r.kind === "pending") console.log(t("cli.tags_cmd.propose_pending", { id: r.proposal.id, name: r.proposal.name }));
      else console.log(t("cli.tags_cmd.propose_blocked", { id: r.proposal.id }));
    } catch (e) {
      console.error(t("cli.tags_cmd.error", { reason: (e as Error).message }));
      process.exit(1);
    }
    return;
  }

  if (sub === "apply") {
    const tagId = args[1];
    const targetSpec = args[2];
    if (!tagId || !targetSpec) {
      console.error(t("cli.tags_cmd.apply_usage"));
      process.exit(1);
    }
    const tag = store.getTag(tagId);
    if (!tag) {
      console.error(t("cli.tags_cmd.not_found", { id: tagId }));
      process.exit(1);
    }
    if (tag.status !== "active") {
      console.error(t("cli.tags_cmd.archived_must_restore", { id: tagId }));
      process.exit(1);
    }
    const target = parseTarget(targetSpec);
    store.upsertTagging({ tagId, targetKind: target.kind, targetId: target.id });
    console.log(`${tag.name} → ${target.kind}:${target.id}`);
    return;
  }

  if (sub === "confirm") {
    const proposalId = args[1];
    if (!proposalId) {
      console.error(t("cli.tags_cmd.confirm_usage"));
      process.exit(1);
    }
    let rename: string | undefined;
    let color: string | undefined;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--rename") rename = args[++i];
      else if (args[i] === "--color") color = args[++i];
      else {
        console.error(t("cli.tags_cmd.unknown_flag", { flag: args[i] }));
        process.exit(1);
      }
    }
    try {
      const r = confirmProposal(store, proposalId, { rename, color });
      console.log(t("cli.tags_cmd.confirmed", { id: r.tag.id, name: r.tag.name, count: r.taggingsAdded }, r.taggingsAdded));
    } catch (e) {
      console.error(t("cli.tags_cmd.error", { reason: (e as Error).message }));
      process.exit(1);
    }
    return;
  }

  if (sub === "reject") {
    const proposalId = args[1];
    if (!proposalId) {
      console.error(t("cli.tags_cmd.reject_usage"));
      process.exit(1);
    }
    const ok = rejectProposal(store, proposalId);
    if (!ok) {
      console.error(t("cli.tags_cmd.proposal_not_found", { id: proposalId }));
      process.exit(1);
    }
    console.log(t("cli.tags_cmd.rejected", { id: proposalId }));
    return;
  }

  if (sub === "recolor") {
    const tagId = args[1];
    const color = args[2];
    if (!tagId || !color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
      console.error(t("cli.tags_cmd.recolor_usage"));
      process.exit(1);
    }
    if (!store.getTag(tagId)) {
      console.error(t("cli.tags_cmd.not_found", { id: tagId }));
      process.exit(1);
    }
    store.recolorTag(tagId, color);
    console.log(`${tagId} → ${color}`);
    return;
  }

  if (sub === "rename") {
    const tagId = args[1];
    const name = args[2];
    if (!tagId || !name) {
      console.error(t("cli.tags_cmd.rename_usage"));
      process.exit(1);
    }
    const existing = store.getTag(tagId);
    if (!existing) {
      console.error(t("cli.tags_cmd.not_found", { id: tagId }));
      process.exit(1);
    }
    const collision = store.findTagByName(name);
    if (collision && collision.id !== tagId) {
      console.error(t("cli.tags_cmd.rename_collision", { name, id: collision.id }));
      process.exit(1);
    }
    store.renameTag(tagId, name);
    console.log(t("cli.tags_cmd.renamed", { id: tagId, name }));
    return;
  }

  if (sub === "archive") {
    const tagId = args[1];
    if (!tagId || !store.getTag(tagId)) {
      console.error(t("cli.tags_cmd.archive_usage"));
      process.exit(1);
    }
    store.archiveTag(tagId);
    console.log(t("cli.tags_cmd.archived", { id: tagId }));
    return;
  }

  if (sub === "restore") {
    const tagId = args[1];
    if (!tagId || !store.getTag(tagId)) {
      console.error(t("cli.tags_cmd.restore_usage"));
      process.exit(1);
    }
    store.restoreTag(tagId);
    console.log(t("cli.tags_cmd.restored", { id: tagId }));
    return;
  }

  console.error(t("cli.tags_cmd.unknown_subcommand", { sub: sub ?? "" }));
  process.exit(1);
}

function configCommand(store: Store, args: string[]): void {
  const sub = args[0];
  const dflt = t("cli.config.default_suffix");
  if (sub === undefined || sub === "list") {
    const all = store.allConfig();
    const keys = Object.keys(all).sort();
    // Surface defaults inline so the user sees what's actually in effect.
    console.log(`  tag_policy         = ${all.tag_policy ?? getTagPolicy(store) + dflt}`);
    console.log(`  tag_require_reason = ${all.tag_require_reason ?? (getTagRequireReason(store) ? "true" : "false") + dflt}`);
    for (const k of keys) {
      if (k === "tag_policy" || k === "tag_require_reason") continue;
      console.log(`  ${k.padEnd(18)} = ${all[k]}`);
    }
    return;
  }
  if (sub === "get") {
    const key = args[1];
    if (!key) {
      console.error(t("cli.config.get_usage"));
      process.exit(1);
    }
    const v = store.getConfig(key);
    if (v === null) {
      if (key === "tag_policy") console.log(`${key} = ${getTagPolicy(store)}${dflt}`);
      else if (key === "tag_require_reason") console.log(`${key} = ${getTagRequireReason(store)}${dflt}`);
      else console.log(`${key} = ${t("cli.config.unset_marker")}`);
    } else {
      console.log(`${key} = ${v}`);
    }
    return;
  }
  if (sub === "set") {
    const key = args[1];
    const value = args[2];
    if (!key || value === undefined) {
      console.error(t("cli.config.set_usage"));
      process.exit(1);
    }
    if (key === "tag_policy" && !["auto", "propose", "locked"].includes(value)) {
      console.error(t("cli.config.tag_policy_invalid"));
      process.exit(1);
    }
    if (key === "tag_require_reason" && !["true", "false"].includes(value)) {
      console.error(t("cli.config.tag_require_reason_invalid"));
      process.exit(1);
    }
    // 0.5.0 — `display_language` is a strict enum. Unlike `main_language`
    // (free-text, agent-facing) this one is consumed by code branches in
    // both the CLI and the SPA, so it must be one of SUPPORTED_LOCALES.
    if (key === "display_language" && !SUPPORTED_LOCALES.includes(value as never)) {
      console.error(t("cli.config.display_language_invalid"));
      process.exit(1);
    }
    store.setConfig(key, value);
    console.log(`${key} = ${value}`);
    return;
  }
  console.error(t("cli.config.unknown_subcommand", { sub: sub ?? "" }));
  process.exit(1);
}

async function main() {
  // Locale resolution — step 1: env-only default. This covers --version,
  // init, hooks, daemon, projects, serve (storeless commands that print
  // before any store is opened). When a per-project store opens later
  // we refine from `display_language` if it's set.
  setDefaultLocale(localeFromEnv() ?? "en");

  const [cmd, ...args] = process.argv.slice(2);

  // 0.4.0 — `stele --version` / `-v` / `version` prints the package version.
  // Resolves the version by walking up from this script's dir to find a
  // package.json — works for both the npm-installed `dist/cli.js` (which
  // sits next to package.json) and the local-checkout `src/cli.ts` path.
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    return printVersion();
  }

  // Storeless commands first — they manipulate config files or registry,
  // never touch a per-project DB.
  if (cmd === "init") return initCommand(args);
  if (cmd === "hooks") return hooksCommand(args);
  if (cmd === "daemon") return daemonCommand(args);
  if (cmd === "projects") return projectsCommand(args);
  if (cmd === "serve") return serveCommand(args);

  let store: Store;
  try {
    store = new Store(resolveDbPath());
  } catch (e) {
    if (e instanceof SteleNotInitializedError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }

  // Locale resolution — step 2: refine from the per-project store. If
  // `display_language` is set on this project, it overrides the env default.
  const storeLocale = store.getConfig("display_language");
  if (isLocale(storeLocale)) setDefaultLocale(storeLocale);

  // 0.3.0 — features / tags / config / sessions / project are per-project
  // (need the store) but have nested subcommands so they don't fit the flat
  // switch pattern.
  if (cmd === "features") return featuresCommand(store, args);
  if (cmd === "tags") return tagsCommand(store, args);
  if (cmd === "config") return configCommand(store, args);
  if (cmd === "sessions") return sessionsCommand(store, args);
  if (cmd === "project") return projectCommand(store, args);

  switch (cmd) {
    // ----- /decision sink: agent drafts CapturePayload, pipes it here ---------
    case "add": {
      const payload = JSON.parse(readStdin()) as CapturePayload;
      // CLI add bypasses feature resolution — the agent must pass a fully
      // resolved Decision (with featureId + valid id). This is the manual
      // / scripted path; the MCP decision_capture tool handles resolution.
      const candidates = proposeEdges(store, payload.decision);
      store.putDecision(payload.decision);
      for (const e of payload.edges || []) store.addEdge(e);

      console.log(t("cli.add.captured", { id: payload.decision.id, title: payload.decision.title }));
      if (payload.edges?.length) console.log(t("cli.add.applied_edges", { count: payload.edges.length }, payload.edges.length));
      if (payload.tags?.length) {
        const tr = applyCaptureTags(store, payload.tags, payload.decision.id);
        if (tr.applied.length) console.log(t("cli.add.tags_applied", { names: tr.applied.map((a) => a.name).join(", ") }));
        if (tr.pending.length) console.log(t("cli.add.tags_pending", { names: tr.pending.map((p) => `${p.name}(${p.proposalId})`).join(", ") }));
        if (tr.blocked.length) console.log(t("cli.add.tags_blocked", { names: tr.blocked.map((b) => b.name).join(", ") }));
        for (const e of tr.errors) console.log(t("cli.add.tag_error", { name: e.name, message: e.message }));
      }
      if (candidates.length) {
        console.log("");
        console.log(t("cli.add.consolidate_proposes", { count: candidates.length }, candidates.length));
        for (const c of candidates.slice(0, 6))
          console.log(`  · [${(c.confidence * 100) | 0}%] ${c.reason}`);
      }
      break;
    }

    // ----- the cross-session stitch: a later decision closes an old loop ------
    case "resolve": {
      store.addEdge({ from: args[0], to: args[1], relation: "resolves", note: args[2] || "manual" });
      console.log(t("cli.edges.resolved", { to: args[1], from: args[0] }));
      break;
    }
    case "relate": {
      store.addEdge({ from: args[0], to: args[1], relation: "relates", note: args[2] || "manual" });
      console.log(t("cli.edges.related", { a: args[0], b: args[1] }));
      break;
    }
    case "depends-on": {
      store.addEdge({ from: args[0], to: args[1], relation: "depends_on", note: args[2] || "manual" });
      console.log(t("cli.edges.depends_on", { a: args[0], b: args[1] }));
      break;
    }

    // ----- projection 1: what's waiting for me --------------------------------
    case "resume": {
      const items = resumeDigest(store);
      const htmlFlag = args.indexOf("--html");
      const forContext = args.includes("--for-context");
      if (htmlFlag >= 0) {
        const out = args[htmlFlag + 1] || join(process.cwd(), "resume.html");
        writeFileSync(out, renderResume(items));
        console.log(t("cli.resume.wrote_html", { path: out, count: items.length }));
      } else if (forContext) {
        // 0.4.0 — SessionStart hook stdout. Declarative prose so Claude
        // Code's prompt-injection defense doesn't flag it as imperative
        // system text. No output at all when there's nothing waiting —
        // empty stdout means the hook contributes no context.
        const out = formatResumeForContext(items);
        if (out) process.stdout.write(out);
      } else {
        console.log("");
        console.log(t("cli.resume.header", { count: items.length }));
        console.log("");
        for (const i of items) {
          const marker = i.needsCheck ? t("cli.resume.check_marker") : "";
          console.log(`  ${i.id}  [${i.bucket}] ${i.ageDays}d${marker}  ${i.title}`);
          if (i.trigger) console.log(`        ${t("cli.resume.review_label", { trigger: i.trigger })}`);
        }
      }
      break;
    }

    // ----- projection 2: how did this come to be ------------------------------
    case "trace": {
      const tr = await trace(store, args[0], stubResolver);
      if (!tr) { console.log(t("cli.trace.not_found", { id: args[0] })); break; }
      console.log("");
      console.log(`${tr.decision.id} — ${tr.decision.title}`);
      console.log(`  ${t("cli.trace.status_label", { status: tr.statusLine })}`);
      if (tr.decision.detail?.constraint) console.log(`  ${t("cli.trace.constraint_label", { constraint: tr.decision.detail.constraint })}`);
      console.log(`  ${t("cli.trace.affects_label", { affects: tr.affects.map((a) => a.label).join(", ") })}`);
      if (tr.edges.length) {
        console.log(`  ${t("cli.trace.graph_label")}`);
        for (const e of tr.edges) {
          const arrow = e.direction === "out" ? `—${e.relation}→` : `←${e.relation}—`;
          console.log(`    ${arrow} ${e.otherId} (${e.otherTitle})`);
        }
      }
      break;
    }

    // ----- projection 2b: everything touching an entity -----------------------
    case "trace-entity": {
      const ref: EntityRef = { kind: args[0], id: args[1] };
      const traces = await traceEntity(store, ref, stubResolver);
      console.log("");
      console.log(t("cli.trace.entity_header", { kind: ref.kind, id: ref.id, count: traces.length }, traces.length));
      console.log("");
      for (const tr of traces) console.log(`  ${tr.decision.id}  ${tr.statusLine}\n        ${tr.decision.title}`);
      break;
    }

    case "list": {
      for (const d of store.allDecisions())
        console.log(`  ${d.id.padEnd(20)} ${nodeState(d).padEnd(11)} ${d.title}`);
      break;
    }

    default:
      console.log(t("cli.usage.full"));
  }
}

main();
