// English translations for stele's CLI surface.
//
// Flat-key shape — see src/i18n.ts for the design rationale. Keys are
// added in the order they're migrated; group with comment headers so
// `grep "cli.init"` finds related entries clustered.
//
// PARITY: every key added here MUST also exist in zh.ts. The i18n parity
// test (src/i18n.test.ts) enforces this; CI is the safety net.

export const EN = {
  // ---------------------------------------------------------------------------
  // cli.errors.* — error messages, validation failures, env hints
  // ---------------------------------------------------------------------------

  "cli.errors.no_stele_store":
    "no stele store found in {cwd} or any ancestor (up to $HOME).\n" +
    "run `stele init` in your project root to create one, " +
    "or set STELE_DB to point at an existing decisions.db.",
  "cli.errors.slug_generation_failed":
    "could not generate unique slug — registry too full?",

  // ---------------------------------------------------------------------------
  // cli.config.* — `stele config <list|get|set>` output
  // ---------------------------------------------------------------------------

  "cli.config.default_suffix": " (default)",
  "cli.config.unset_marker": "(unset)",
  "cli.config.get_usage": "stele config get <key>",
  "cli.config.set_usage": "stele config set <key> <value>",
  "cli.config.tag_policy_invalid":
    "tag_policy must be one of: auto, propose, locked",
  "cli.config.tag_require_reason_invalid":
    "tag_require_reason must be 'true' or 'false'",
  "cli.config.display_language_invalid":
    "display_language must be 'zh' or 'en'",
  "cli.config.unknown_subcommand":
    "unknown config subcommand: {sub} — try list / get / set",

  // ---------------------------------------------------------------------------
  // cli.daemon.* — install / uninstall / status notes
  // ---------------------------------------------------------------------------

  "cli.daemon.dry_run_plist": "dry-run: plist printed, not written",
  "cli.daemon.dry_run_unit": "dry-run: unit printed, not written",
  "cli.daemon.legacy_plists_cleaned":
    "cleaned up {count} legacy plist(s): {names}",
  "cli.daemon.legacy_units_cleaned":
    "cleaned up {count} legacy unit(s): {names}",
  "cli.daemon.legacy_registered":
    "registered {count} previously-orphaned project(s) into the global registry",
  "cli.daemon.port_bound":
    "port {port} is already bound on 127.0.0.1 — pass a different --port",
  "cli.daemon.wrote": "wrote {path}",
  "cli.daemon.removed": "removed {path}",
  "cli.daemon.not_present": "{path} not present",
  "cli.daemon.launchctl_loaded": "launchctl bootstrap succeeded — loaded",
  "cli.daemon.launchctl_failed": "launchctl bootstrap failed: {reason}",
  "cli.daemon.systemctl_enabled": "systemctl --user enable --now succeeded",
  "cli.daemon.systemctl_failed": "systemctl --user enable --now failed: {reason}",
  "cli.daemon.linger_note":
    "Note: services run only while you're logged in. For true always-on, " +
    "consider `sudo loginctl enable-linger {user}`.",
  "cli.daemon.platform_unsupported":
    "{platform} unsupported — nothing to do",
  "cli.daemon.status_loaded": "loaded",
  "cli.daemon.status_not_loaded": "not loaded",
  "cli.daemon.status_path_unsupported": "(unsupported platform)",
  "cli.daemon.status_loaded_note_unsupported": "unsupported",

  // ---------------------------------------------------------------------------
  // cli.hooks.* — `stele hooks install|uninstall|status` notes
  // ---------------------------------------------------------------------------

  "cli.hooks.legacy_stop_removed":
    "removed legacy {path} (Stop hook retired in 0.4.0-snapshot.10; agent self-governs Layer 1)",
  "cli.hooks.legacy_stop_absent":
    "Stop hook retired in 0.4.0-snapshot.10 — agent self-governs Layer 1 via the stele-capture skill",
  "cli.hooks.session_start_wrote": "wrote {path} (executable)",
  "cli.hooks.session_end_auto_enabled":
    "wrote {path} (SessionEnd auto-extract ENABLED — will block session close up to 60s)",
  "cli.hooks.session_end_auto_disabled":
    "SessionEnd auto-extract not enabled — pass --enable-session-end-auto-extract to opt in (Layer 3 lives in /stele:scan otherwise)",
  "cli.hooks.skill_wrote":
    "wrote {path}/ ({count} files: SKILL.md + gotchas + references)",
  "cli.hooks.skill_wrote.one":
    "wrote {path}/ (1 file: SKILL.md + gotchas + references)",
  "cli.hooks.skill_wrote.other":
    "wrote {path}/ ({count} files: SKILL.md + gotchas + references)",
  "cli.hooks.removed_path": "removed {path}",
  "cli.hooks.path_absent": "{path} not present",
  "cli.hooks.session_end_uninstalled": "removed {paths}",
  "cli.hooks.session_end_absent":
    "SessionEnd auto-extract artifacts not present",
  "cli.hooks.skill_removed": "removed {path}",
  "cli.hooks.command_left_in_place":
    "{path} left in place (manual delete if you want)",
  "cli.hooks.legacy_commands_untouched":
    "uninstall doesn't touch legacy 0.2.x commands",
  "cli.hooks.command_already_exists":
    "{path} already exists, left as-is",
  "cli.hooks.command_wrote": "wrote {path}",
  "cli.hooks.settings_updated_entry": "updated {event} entry",
  "cli.hooks.settings_added_entry": "added {event} entry",
  "cli.hooks.settings_disabled_entry":
    "disabled {event} entry (opt-in not requested this round)",
  "cli.hooks.settings_version_pinned_already":
    "requiredMinimumVersion already pinned at {version}",
  "cli.hooks.settings_version_pinned": "pinned requiredMinimumVersion to {version}",
  "cli.hooks.settings_no_file": "no settings.json — nothing to do",
  "cli.hooks.settings_removed": "removed {names} stele entries",
  "cli.hooks.settings_no_entries": "no stele entries were present",
  "cli.hooks.legacy_no_clean": "no legacy commands to clean",
  "cli.hooks.legacy_no_stele":
    "no stele legacy commands to clean ({count} user-level file{s} skipped — no stele fingerprint)",
  "cli.hooks.legacy_removed":
    "removed {count} legacy command{s} ({detail})",

  // ---------------------------------------------------------------------------
  // cli.init.* — `stele init` output
  // ---------------------------------------------------------------------------

  "cli.init.invalid_port": "invalid --port value: {value}",
  "cli.init.unknown_flag": "unknown init flag: {flag}",
  "cli.init.already_initialized": "stele already initialized at {path}",
  "cli.init.reset_hint":
    "(rm -rf .stele to reset — you'll lose all decisions)",
  "cli.init.gitignore_added": "added .stele/ to .gitignore",
  "cli.init.gitignore_already": ".gitignore already mentions .stele/",
  "cli.init.gitignore_written": "wrote .gitignore with .stele/",
  "cli.init.mcp_written": "wrote .mcp.json with stele entry",
  "cli.init.mcp_invalid_json":
    "existing .mcp.json is not valid JSON — refusing to overwrite",
  "cli.init.mcp_not_object":
    "existing .mcp.json is not an object — refusing to overwrite",
  "cli.init.mcp_updated": "updated stele entry in existing .mcp.json",
  "cli.init.mcp_merged": "merged stele entry into existing .mcp.json",
  "cli.init.created": "stele initialized at {path}",
  "cli.init.wrote_readme": "wrote .stele/README.md",
  "cli.init.slug_registered": "registered as slug \"{slug}\"",
  "cli.init.slug_already_registered": "already registered as slug \"{slug}\"",
  "cli.init.registry_failed":
    "⚠ registry write failed (continuing): {reason}",
  "cli.init.hooks_failed":
    "⚠ hooks install failed (continuing): {reason}",
  "cli.init.daemon_unsupported_platform":
    "ⓘ daemon not installed (unsupported platform: {platform})",
  "cli.init.daemon_installed":
    "installed {platform} daemon — http://127.0.0.1:{port} (loaded: {loaded})",
  "cli.init.daemon_failed":
    "⚠ daemon install failed (continuing): {reason}",
  "cli.init.daemon_retry_hint":
    "you can retry with: stele daemon install --port <N>",
  "cli.init.next_header": "Next:",
  "cli.init.next_restart":
    "1. Restart Claude Code in this directory (it picks up .mcp.json).",
  "cli.init.next_serve_manual":
    "2. Run `stele serve --multi` to launch the browser UI.",
  "cli.init.next_open_daemon":
    "2. Open http://127.0.0.1:{port}/{slug}/ — daemon serves it always-on.",
  "cli.init.next_ask":
    "3. Ask \"what's waiting on me?\" to see open loops.",
  "cli.init.loaded_yes": "yes",
  "cli.init.loaded_no": "no",

  // ---------------------------------------------------------------------------
  // cli.hooks_cmd.* — `stele hooks <sub>` CLI-wrapper output (the prose
  // around the already-i18n'd hooks.ts InstallReport / StatusReport fields)
  // ---------------------------------------------------------------------------

  "cli.hooks_cmd.installed_header": "hooks installed in {cwd}:",
  "cli.hooks_cmd.install_failed": "hooks install failed: {reason}",
  "cli.hooks_cmd.uninstalled_header": "hooks uninstalled from {cwd}:",
  "cli.hooks_cmd.uninstall_failed": "hooks uninstall failed: {reason}",
  "cli.hooks_cmd.unknown_feature":
    "unknown hooks feature: {feature} — try: session-end-auto-extract",
  "cli.hooks_cmd.enabled_header":
    "enabled session-end-auto-extract in {cwd}:",
  "cli.hooks_cmd.enable_failed": "enable failed: {reason}",
  "cli.hooks_cmd.enable_warn_1":
    "⚠  This hook BLOCKS session close for up to 60s while the",
  "cli.hooks_cmd.enable_warn_2":
    "   post-hoc subagent reads the transcript and captures decisions.",
  "cli.hooks_cmd.enable_warn_3":
    "   /stele:scan is the manual equivalent and never blocks.",
  "cli.hooks_cmd.disabled_header":
    "disabled session-end-auto-extract in {cwd}:",
  "cli.hooks_cmd.disable_failed": "disable failed: {reason}",
  "cli.hooks_cmd.disabled_layer3_hint":
    "Layer 3 still available manually: /stele:scan",
  "cli.hooks_cmd.status_header": "stele hooks status ({cwd}):",
  "cli.hooks_cmd.status_session_end_label":
    "SessionEnd auto-extract (opt-in, agent type, blocks close ≤60s)",
  "cli.hooks_cmd.status_settings_label":
    "stele entries in .claude/settings.json",
  "cli.hooks_cmd.status_min_version_label":
    "requiredMinimumVersion pinned in .claude/settings.json",
  "cli.hooks_cmd.legacy_warn_1":
    "⚠  Legacy .claude/hooks/stele-stop.sh found. The Stop hook was retired",
  "cli.hooks_cmd.legacy_warn_2":
    "   in 0.4.0-snapshot.10 (the agent self-governs Layer 1 capture now via",
  "cli.hooks_cmd.legacy_warn_3":
    "   the stele-capture skill). Run `stele hooks install` to clean it up.",
  "cli.hooks_cmd.enable_hint":
    "Enable SessionEnd auto-extract with: stele hooks enable session-end-auto-extract",
  "cli.hooks_cmd.unknown_subcommand":
    "unknown hooks subcommand: {sub} — try install / uninstall / enable <feature> / disable <feature> / status",

  // ---------------------------------------------------------------------------
  // cli.daemon_cmd.* — `stele daemon <sub>` CLI-wrapper output
  // ---------------------------------------------------------------------------

  "cli.daemon_cmd.unknown_flag": "unknown daemon flag: {flag}",
  "cli.daemon_cmd.installed_header":
    "stele daemon installed ({platform}, multi-tenant):",
  "cli.daemon_cmd.imported_legacy":
    "· imported projects from legacy daemons:",
  "cli.daemon_cmd.install_failed": "daemon install failed: {reason}",
  "cli.daemon_cmd.uninstalled_header": "stele daemon uninstalled:",
  "cli.daemon_cmd.status_header": "stele daemon status:",
  "cli.daemon_cmd.status_registered_projects": "registered projects: {count}",
  "cli.daemon_cmd.unknown_subcommand":
    "unknown daemon subcommand: {sub} — try install / uninstall / status",

  // ---------------------------------------------------------------------------
  // cli.projects.* — `stele projects <list|remove>`
  // ---------------------------------------------------------------------------

  "cli.projects.none_registered":
    "no projects registered. Run `stele init` in a project root.",
  "cli.projects.registered_count": "{count} registered project(s):",
  "cli.projects.remove_usage": "stele projects remove <slug-or-path>",
  "cli.projects.removed": "removed {target} from registry",
  "cli.projects.not_found": "no project matched \"{target}\"",
  "cli.projects.unknown_subcommand":
    "unknown projects subcommand: {sub} — try list / remove",

  // ---------------------------------------------------------------------------
  // cli.serve.* — `stele serve`
  // ---------------------------------------------------------------------------

  "cli.serve.host_requires_value": "--host requires a value",
  "cli.serve.unknown_flag": "unknown serve flag: {flag}",

  // ---------------------------------------------------------------------------
  // cli.project.* — `stele project <show|set-status>`
  // ---------------------------------------------------------------------------

  "cli.project.none": "no project row — run `stele init`",
  "cli.project.rollup":
    "{features} feature(s) · {decisions} decision(s) · {open} open loop(s) ({due} due)",
  "cli.project.unknown_subcommand":
    "unknown project subcommand: {sub} — try show / set-status",

  // ---------------------------------------------------------------------------
  // cli.features.* — `stele features <list|open|show|set-state|report>`
  // (the parser strings; the subcommand strings live in cli.features_cmd.*)
  // ---------------------------------------------------------------------------

  "cli.features.invalid_state":
    "invalid state: {value} (expected draft|going|winding|done|paused)",

  // ---------------------------------------------------------------------------
  // cli.tags.* — `stele tags ...` parser strings (subcommand strings in
  // cli.tags_cmd.*)
  // ---------------------------------------------------------------------------

  "cli.tags.target_required":
    "expected target in form <kind>:<id> — e.g. decision:D-42 or feature:M-03",
  "cli.tags.target_bad_format":
    "bad target \"{spec}\" — expected <kind>:<id>",
  "cli.tags.target_bad_kind":
    "target kind must be 'decision' or 'feature', got \"{kind}\"",

  // ---------------------------------------------------------------------------
  // cli.features_cmd.* — `stele features <list|open|show|set-state|report>`
  // ---------------------------------------------------------------------------

  "cli.features_cmd.unknown_flag": "unknown flag: {flag}",
  "cli.features_cmd.no_features": "no features",
  "cli.features_cmd.session_label.one": "1 session",
  "cli.features_cmd.session_label.other": "{count} sessions",
  "cli.features_cmd.open_loop_suffix.one": " · 1 open loop",
  "cli.features_cmd.open_loop_suffix.other": " · {count} open loops",
  "cli.features_cmd.open_usage":
    "stele features open <name> [--about \"...\"]",
  "cli.features_cmd.no_project": "no project — run `stele init`",
  "cli.features_cmd.opened": "opened {id} \"{name}\" (state=draft)",
  "cli.features_cmd.set_state_usage":
    "stele features set-state <id> <draft|going|winding|done|paused>",
  "cli.features_cmd.not_found": "no such feature: {id}",
  "cli.features_cmd.report_usage": "stele features report <id>",
  "cli.features_cmd.report_header":
    "feature-report draft for {id} \"{name}\":",
  "cli.features_cmd.report_open_loops": "open loops: {count}",
  "cli.features_cmd.report_next_1":
    "Next: agent drafts {summary, resumeEdge, pauseReason},",
  "cli.features_cmd.report_next_2":
    "      user confirms via `stele sessions end <session-id> ...`.",
  "cli.features_cmd.show_usage": "stele features show <id>",
  "cli.features_cmd.decision_label.one": "1 decision",
  "cli.features_cmd.decision_label.other": "{count} decisions",
  "cli.features_cmd.unknown_subcommand":
    "unknown features subcommand: {sub} — try list / open / report / show / set-state",
} as const;

export type EnKey = keyof typeof EN;
