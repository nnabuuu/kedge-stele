// Chinese (zh-CN) translations for stele's CLI surface.
//
// Keys must mirror src/locales/en.ts exactly (the parity test in
// src/i18n.test.ts enforces this). Add new keys at the same time you add
// the English version, grouped by the same comment headers.
//
// Tone: 简练、可读、技术术语保留原样 (CLI / MCP / SQLite / hook / slug ...
// 这些都不翻译). 同 src/templates/* 里跟 agent 说话的风格一致。

export const ZH = {
  // ---------------------------------------------------------------------------
  // cli.errors.* — 错误信息、参数校验失败、环境提示
  // ---------------------------------------------------------------------------

  "cli.errors.no_stele_store":
    "在 {cwd} 及其所有祖先目录 (直到 $HOME) 都没找到 stele 仓库。\n" +
    "在项目根目录里跑 `stele init` 来创建一个,或者用 STELE_DB 指向" +
    "一个已存在的 decisions.db。",
  "cli.errors.slug_generation_failed":
    "无法生成唯一的 slug —— registry 满了?",

  // ---------------------------------------------------------------------------
  // cli.config.* — `stele config <list|get|set>` 输出
  // ---------------------------------------------------------------------------

  "cli.config.default_suffix": " (默认值)",
  "cli.config.unset_marker": "(未设置)",
  "cli.config.get_usage": "stele config get <key>",
  "cli.config.set_usage": "stele config set <key> <value>",
  "cli.config.tag_policy_invalid":
    "tag_policy 必须是 auto / propose / locked 三者之一",
  "cli.config.tag_require_reason_invalid":
    "tag_require_reason 必须是 'true' 或 'false'",
  "cli.config.display_language_invalid":
    "display_language 必须是 'zh' 或 'en'",
  "cli.config.unknown_subcommand":
    "config 没有 {sub} 子命令 —— 试试 list / get / set",

  // ---------------------------------------------------------------------------
  // cli.daemon.* — install / uninstall / status 备注
  // ---------------------------------------------------------------------------

  "cli.daemon.dry_run_plist": "dry-run: 打印了 plist,没有写入磁盘",
  "cli.daemon.dry_run_unit": "dry-run: 打印了 unit,没有写入磁盘",
  "cli.daemon.legacy_plists_cleaned":
    "清理了 {count} 个旧的 plist: {names}",
  "cli.daemon.legacy_units_cleaned":
    "清理了 {count} 个旧的 unit: {names}",
  "cli.daemon.legacy_registered":
    "把 {count} 个之前游离的项目注册进全局 registry",
  "cli.daemon.port_bound":
    "端口 {port} 已经被 127.0.0.1 上的其他进程占用 —— 用 --port 指定别的",
  "cli.daemon.wrote": "已写入 {path}",
  "cli.daemon.removed": "已删除 {path}",
  "cli.daemon.not_present": "{path} 不存在",
  "cli.daemon.launchctl_loaded": "launchctl bootstrap 成功 —— 已加载",
  "cli.daemon.launchctl_failed": "launchctl bootstrap 失败: {reason}",
  "cli.daemon.systemctl_enabled": "systemctl --user enable --now 成功",
  "cli.daemon.systemctl_failed": "systemctl --user enable --now 失败: {reason}",
  "cli.daemon.linger_note":
    "提示: user service 只在登录期间运行。想真正常驻就跑一次 " +
    "`sudo loginctl enable-linger {user}`。",
  "cli.daemon.platform_unsupported":
    "{platform} 平台不支持 —— 无事可做",
  "cli.daemon.status_loaded": "已加载",
  "cli.daemon.status_not_loaded": "未加载",
  "cli.daemon.status_path_unsupported": "(平台不支持)",
  "cli.daemon.status_loaded_note_unsupported": "不支持",

  // ---------------------------------------------------------------------------
  // cli.hooks.* — `stele hooks install|uninstall|status` 备注
  // ---------------------------------------------------------------------------

  "cli.hooks.legacy_stop_removed":
    "已删除残留的 {path} (Stop hook 在 0.4.0-snapshot.10 已下线;Layer 1 由 agent 自治)",
  "cli.hooks.legacy_stop_absent":
    "Stop hook 在 0.4.0-snapshot.10 已下线 —— Layer 1 由 stele-capture skill 中的 agent 自治",
  "cli.hooks.session_start_wrote": "已写入 {path} (可执行)",
  "cli.hooks.session_end_auto_enabled":
    "已写入 {path} (SessionEnd auto-extract 已启用 —— 关 session 时最多堵塞 60 秒)",
  "cli.hooks.session_end_auto_disabled":
    "SessionEnd auto-extract 未启用 —— 加 --enable-session-end-auto-extract 来开启 (否则 Layer 3 走 /stele:scan)",
  "cli.hooks.skill_wrote":
    "已写入 {path}/ ({count} 个文件: SKILL.md + gotchas + references)",
  "cli.hooks.skill_wrote.one":
    "已写入 {path}/ (1 个文件: SKILL.md + gotchas + references)",
  "cli.hooks.skill_wrote.other":
    "已写入 {path}/ ({count} 个文件: SKILL.md + gotchas + references)",
  "cli.hooks.removed_path": "已删除 {path}",
  "cli.hooks.path_absent": "{path} 不存在",
  "cli.hooks.session_end_uninstalled": "已删除 {paths}",
  "cli.hooks.session_end_absent":
    "SessionEnd auto-extract 的相关文件都不存在",
  "cli.hooks.skill_removed": "已删除 {path}",
  "cli.hooks.command_left_in_place":
    "{path} 保留未动 (想删需要手动)",
  "cli.hooks.legacy_commands_untouched":
    "uninstall 不会清理 0.2.x 时代的旧命令",
  "cli.hooks.command_already_exists":
    "{path} 已存在,保留不动",
  "cli.hooks.command_wrote": "已写入 {path}",
  "cli.hooks.settings_updated_entry": "更新了 {event} 条目",
  "cli.hooks.settings_added_entry": "添加了 {event} 条目",
  "cli.hooks.settings_disabled_entry":
    "停用了 {event} 条目 (本次没要求 opt-in)",
  "cli.hooks.settings_version_pinned_already":
    "requiredMinimumVersion 已经钉在 {version}",
  "cli.hooks.settings_version_pinned": "把 requiredMinimumVersion 钉到 {version}",
  "cli.hooks.settings_no_file": "没有 settings.json —— 没事可做",
  "cli.hooks.settings_removed": "删除了 {names} 这几个 stele 条目",
  "cli.hooks.settings_no_entries": "没有任何 stele 条目存在",
  "cli.hooks.legacy_no_clean": "没有需要清理的旧命令",
  "cli.hooks.legacy_no_stele":
    "没有 stele 的旧命令需要清理 (跳过了 {count} 个 user-level 文件{s} —— 没有 stele 指纹)",
  "cli.hooks.legacy_removed":
    "删除了 {count} 个旧命令{s} ({detail})",
} as const;

export type ZhKey = keyof typeof ZH;
