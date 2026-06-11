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

  // ---------------------------------------------------------------------------
  // cli.init.* — `stele init` 输出
  // ---------------------------------------------------------------------------

  "cli.init.invalid_port": "--port 值无效: {value}",
  "cli.init.unknown_flag": "init 不认识的 flag: {flag}",
  "cli.init.already_initialized": "{path} 里已经有 stele 仓库了",
  "cli.init.reset_hint":
    "(想重来的话 rm -rf .stele —— 所有 decision 会一起消失)",
  "cli.init.gitignore_added": "把 .stele/ 添加到了 .gitignore",
  "cli.init.gitignore_already": ".gitignore 里已经有 .stele/",
  "cli.init.gitignore_written": "写入 .gitignore,包含 .stele/",
  "cli.init.mcp_written": "写入 .mcp.json,带 stele 条目",
  "cli.init.mcp_invalid_json":
    "现有的 .mcp.json 不是合法 JSON —— 拒绝覆盖",
  "cli.init.mcp_not_object":
    "现有的 .mcp.json 不是 object —— 拒绝覆盖",
  "cli.init.mcp_updated": "更新了现有 .mcp.json 里的 stele 条目",
  "cli.init.mcp_merged": "把 stele 条目合并进了现有的 .mcp.json",
  "cli.init.created": "stele 已在 {path} 初始化",
  "cli.init.wrote_readme": "写入 .stele/README.md",
  "cli.init.slug_registered": "注册为 slug \"{slug}\"",
  "cli.init.slug_already_registered": "已经注册过了,slug 是 \"{slug}\"",
  "cli.init.registry_failed":
    "⚠ 写入 registry 失败 (继续): {reason}",
  "cli.init.hooks_failed":
    "⚠ 安装 hooks 失败 (继续): {reason}",
  "cli.init.daemon_unsupported_platform":
    "ⓘ daemon 未安装 (当前平台不支持: {platform})",
  "cli.init.daemon_installed":
    "已安装 {platform} 上的 daemon —— http://127.0.0.1:{port} (loaded: {loaded})",
  "cli.init.daemon_failed":
    "⚠ 安装 daemon 失败 (继续): {reason}",
  "cli.init.daemon_retry_hint":
    "你可以稍后重试: stele daemon install --port <N>",
  "cli.init.next_header": "接下来:",
  "cli.init.next_restart":
    "1. 在这个目录重启 Claude Code (它会读到 .mcp.json)。",
  "cli.init.next_serve_manual":
    "2. 跑 `stele serve --multi` 启动浏览器 UI。",
  "cli.init.next_open_daemon":
    "2. 打开 http://127.0.0.1:{port}/{slug}/ —— daemon 已经在常驻服务。",
  "cli.init.next_ask":
    "3. 问 \"什么在等我?\" 看待办循环。",
  "cli.init.loaded_yes": "是",
  "cli.init.loaded_no": "否",

  // ---------------------------------------------------------------------------
  // cli.hooks_cmd.* — `stele hooks <sub>` 包装层输出
  // ---------------------------------------------------------------------------

  "cli.hooks_cmd.installed_header": "{cwd} 中已安装 hooks:",
  "cli.hooks_cmd.install_failed": "hooks 安装失败: {reason}",
  "cli.hooks_cmd.uninstalled_header": "已从 {cwd} 卸载 hooks:",
  "cli.hooks_cmd.uninstall_failed": "hooks 卸载失败: {reason}",
  "cli.hooks_cmd.unknown_feature":
    "不认识的 hooks feature: {feature} —— 试试: session-end-auto-extract",
  "cli.hooks_cmd.enabled_header":
    "已在 {cwd} 启用 session-end-auto-extract:",
  "cli.hooks_cmd.enable_failed": "启用失败: {reason}",
  "cli.hooks_cmd.enable_warn_1":
    "⚠  这个 hook 会在关 session 时堵塞最多 60 秒,期间",
  "cli.hooks_cmd.enable_warn_2":
    "   post-hoc 子 agent 会读 transcript 并 capture decision。",
  "cli.hooks_cmd.enable_warn_3":
    "   /stele:scan 是同等手动版本,不会堵塞。",
  "cli.hooks_cmd.disabled_header":
    "已在 {cwd} 停用 session-end-auto-extract:",
  "cli.hooks_cmd.disable_failed": "停用失败: {reason}",
  "cli.hooks_cmd.disabled_layer3_hint":
    "Layer 3 仍可手动触发: /stele:scan",
  "cli.hooks_cmd.status_header": "stele hooks 状态 ({cwd}):",
  "cli.hooks_cmd.status_session_end_label":
    "SessionEnd auto-extract (opt-in, agent type, 关闭最多堵塞 60 秒)",
  "cli.hooks_cmd.status_settings_label":
    ".claude/settings.json 中含有 stele 条目",
  "cli.hooks_cmd.status_min_version_label":
    ".claude/settings.json 已钉 requiredMinimumVersion",
  "cli.hooks_cmd.legacy_warn_1":
    "⚠  发现残留的 .claude/hooks/stele-stop.sh。Stop hook 在 0.4.0-snapshot.10",
  "cli.hooks_cmd.legacy_warn_2":
    "   已下线 (Layer 1 由 stele-capture skill 中的 agent 自治)。",
  "cli.hooks_cmd.legacy_warn_3":
    "   跑一下 `stele hooks install` 把它清掉。",
  "cli.hooks_cmd.enable_hint":
    "启用 SessionEnd auto-extract: stele hooks enable session-end-auto-extract",
  "cli.hooks_cmd.unknown_subcommand":
    "hooks 没有 {sub} 子命令 —— 试试 install / uninstall / enable <feature> / disable <feature> / status",

  // ---------------------------------------------------------------------------
  // cli.daemon_cmd.* — `stele daemon <sub>` 包装层输出
  // ---------------------------------------------------------------------------

  "cli.daemon_cmd.unknown_flag": "daemon 不认识的 flag: {flag}",
  "cli.daemon_cmd.installed_header":
    "stele daemon 已安装 ({platform}, multi-tenant):",
  "cli.daemon_cmd.imported_legacy":
    "· 从老 daemon 中导入了以下项目:",
  "cli.daemon_cmd.install_failed": "daemon 安装失败: {reason}",
  "cli.daemon_cmd.uninstalled_header": "stele daemon 已卸载:",
  "cli.daemon_cmd.status_header": "stele daemon 状态:",
  "cli.daemon_cmd.status_registered_projects": "已注册项目数: {count}",
  "cli.daemon_cmd.unknown_subcommand":
    "daemon 没有 {sub} 子命令 —— 试试 install / uninstall / status",

  // ---------------------------------------------------------------------------
  // cli.projects.* — `stele projects <list|remove>`
  // ---------------------------------------------------------------------------

  "cli.projects.none_registered":
    "没有注册的项目。在项目根目录跑 `stele init`。",
  "cli.projects.registered_count": "已注册 {count} 个项目:",
  "cli.projects.remove_usage": "stele projects remove <slug-or-path>",
  "cli.projects.removed": "已从 registry 删除 {target}",
  "cli.projects.not_found": "找不到匹配 \"{target}\" 的项目",
  "cli.projects.unknown_subcommand":
    "projects 没有 {sub} 子命令 —— 试试 list / remove",

  // ---------------------------------------------------------------------------
  // cli.serve.* — `stele serve`
  // ---------------------------------------------------------------------------

  "cli.serve.host_requires_value": "--host 必须带一个值",
  "cli.serve.unknown_flag": "serve 不认识的 flag: {flag}",

  // ---------------------------------------------------------------------------
  // cli.project.* — `stele project <show|set-status>`
  // ---------------------------------------------------------------------------

  "cli.project.none": "没有 project 记录 —— 跑一下 `stele init`",
  "cli.project.rollup":
    "{features} 个 feature · {decisions} 个 decision · {open} 个待办循环 (其中 {due} 个该复审)",
  "cli.project.unknown_subcommand":
    "project 没有 {sub} 子命令 —— 试试 show / set-status",

  // ---------------------------------------------------------------------------
  // cli.features.* — `stele features ...` 解析器
  // ---------------------------------------------------------------------------

  "cli.features.invalid_state":
    "state 值无效: {value} (应该是 draft|going|winding|done|paused 之一)",

  // ---------------------------------------------------------------------------
  // cli.tags.* — `stele tags ...` 解析器
  // ---------------------------------------------------------------------------

  "cli.tags.target_required":
    "target 必须是 <kind>:<id> 格式 —— 比如 decision:D-42 或 feature:M-03",
  "cli.tags.target_bad_format":
    "target 格式错误 \"{spec}\" —— 应该是 <kind>:<id>",
  "cli.tags.target_bad_kind":
    "target kind 必须是 'decision' 或 'feature',传的是 \"{kind}\"",

  // ---------------------------------------------------------------------------
  // cli.features_cmd.* — `stele features <list|open|show|set-state|report>`
  // ---------------------------------------------------------------------------

  "cli.features_cmd.unknown_flag": "不认识的 flag: {flag}",
  "cli.features_cmd.no_features": "没有 feature",
  "cli.features_cmd.session_label.one": "1 个 session",
  "cli.features_cmd.session_label.other": "{count} 个 session",
  "cli.features_cmd.open_loop_suffix.one": " · 1 个待办循环",
  "cli.features_cmd.open_loop_suffix.other": " · {count} 个待办循环",
  "cli.features_cmd.open_usage":
    "stele features open <name> [--about \"...\"]",
  "cli.features_cmd.no_project": "没有 project —— 跑一下 `stele init`",
  "cli.features_cmd.opened": "已打开 {id} \"{name}\" (state=draft)",
  "cli.features_cmd.set_state_usage":
    "stele features set-state <id> <draft|going|winding|done|paused>",
  "cli.features_cmd.not_found": "找不到 feature: {id}",
  "cli.features_cmd.report_usage": "stele features report <id>",
  "cli.features_cmd.report_header":
    "{id} \"{name}\" 的 feature-report 草稿:",
  "cli.features_cmd.report_open_loops": "待办循环: {count}",
  "cli.features_cmd.report_next_1":
    "接下来: agent 起草 {summary, resumeEdge, pauseReason},",
  "cli.features_cmd.report_next_2":
    "        用户用 `stele sessions end <session-id> ...` 确认。",
  "cli.features_cmd.show_usage": "stele features show <id>",
  "cli.features_cmd.decision_label.one": "1 个 decision",
  "cli.features_cmd.decision_label.other": "{count} 个 decision",
  "cli.features_cmd.unknown_subcommand":
    "features 没有 {sub} 子命令 —— 试试 list / open / report / show / set-state",

  // ---------------------------------------------------------------------------
  // cli.sessions.* — `stele sessions <list|start|end|resume|continue>`
  // ---------------------------------------------------------------------------

  "cli.sessions.feature_requires_value": "--feature 必须带一个值",
  "cli.sessions.none_yet": "还没有 session",
  "cli.sessions.latest_line":
    "最近一个 session: {id} (feature {feature})",
  "cli.sessions.start_usage":
    "stele sessions start 需要从 stdin 读 JSON: { featureId, sourceSession, provenance? }",
  "cli.sessions.opened":
    "已打开 session {id} (feature {feature})",
  "cli.sessions.end_usage_id":
    "stele sessions end <session-id> < outcome+pause-reason JSON on stdin",
  "cli.sessions.end_usage_body":
    "stele sessions end 需要从 stdin 读 JSON: { outcome, pauseReason? }",
  "cli.sessions.closed":
    "已关闭 session {id}  outcome={outcome}{pause}",
  "cli.sessions.resume_usage": "stele sessions resume <session-id>",
  "cli.sessions.not_found": "找不到 session: {id}",
  "cli.sessions.continue_last":
    "上一个 session: {id} (feature {feature} \"{name}\")",
  "cli.sessions.resume_header": "Resume (mode={mode}):",
  "cli.sessions.unknown_subcommand":
    "sessions 没有 {sub} 子命令 —— 试试 list / start / end / resume / continue",

  // ---------------------------------------------------------------------------
  // cli.project_status.* — parseProjectStatus
  // ---------------------------------------------------------------------------

  "cli.project_status.invalid":
    "status 值无效: {value} (应该是 active|winding|dormant|archived 之一)",

  // ---------------------------------------------------------------------------
  // cli.tags_cmd.* — `stele tags <list|propose|apply|...>`
  // ---------------------------------------------------------------------------

  "cli.tags_cmd.unknown_flag": "不认识的 flag: {flag}",
  "cli.tags_cmd.no_tags_active": "没有活跃的 tag",
  "cli.tags_cmd.no_tags_archived": "没有归档的 tag",
  "cli.tags_cmd.no_tags_all": "没有 tag",
  "cli.tags_cmd.target_count.one": "1 个 target",
  "cli.tags_cmd.target_count.other": "{count} 个 target",
  "cli.tags_cmd.no_proposals_filtered": "没有 {outcome} 状态的提案",
  "cli.tags_cmd.no_proposals_all": "没有提案",
  "cli.tags_cmd.proposal_reason": "理由: {reason}",
  "cli.tags_cmd.propose_usage":
    "stele tags propose <name> [--reason \"...\"] [--color #RRGGBB] [--target kind:id ...]",
  "cli.tags_cmd.propose_target_required":
    "至少需要一个 --target",
  "cli.tags_cmd.propose_applied":
    "复用已有 tag {id} ({name})",
  "cli.tags_cmd.propose_pending":
    "已提案 {id} ({name}) —— 用 `stele tags confirm {id}` 确认",
  "cli.tags_cmd.propose_blocked":
    "被 tag_policy=locked 阻止 —— 已记 {id}",
  "cli.tags_cmd.error": "出错: {reason}",
  "cli.tags_cmd.apply_usage": "stele tags apply <tagId> <kind:id>",
  "cli.tags_cmd.not_found": "找不到 tag: {id}",
  "cli.tags_cmd.archived_must_restore":
    "tag {id} 已归档,需要先 restore",
  "cli.tags_cmd.confirm_usage":
    "stele tags confirm <proposalId> [--rename name] [--color #RRGGBB]",
  "cli.tags_cmd.confirmed.one":
    "已确认 {id} ({name});新挂了 1 条 tagging",
  "cli.tags_cmd.confirmed.other":
    "已确认 {id} ({name});新挂了 {count} 条 tagging",
  "cli.tags_cmd.reject_usage": "stele tags reject <proposalId>",
  "cli.tags_cmd.proposal_not_found": "找不到提案: {id}",
  "cli.tags_cmd.rejected": "已拒绝 {id}",
  "cli.tags_cmd.recolor_usage": "stele tags recolor <tagId> <#RRGGBB>",
  "cli.tags_cmd.rename_usage": "stele tags rename <tagId> <newname>",
  "cli.tags_cmd.rename_collision":
    "名字 \"{name}\" 已经被 {id} 占用",
  "cli.tags_cmd.renamed": "{id} 已改名 → {name}",
  "cli.tags_cmd.archive_usage": "stele tags archive <tagId>",
  "cli.tags_cmd.archived": "{id} 已归档",
  "cli.tags_cmd.restore_usage": "stele tags restore <tagId>",
  "cli.tags_cmd.restored": "{id} 已恢复",
  "cli.tags_cmd.unknown_subcommand":
    "tags 没有 {sub} 子命令 —— 试试 list / proposals / propose / apply / confirm / reject / recolor / rename / archive / restore",

  // ---------------------------------------------------------------------------
  // cli.version.* — `stele --version`
  // ---------------------------------------------------------------------------

  "cli.version.unknown":
    "stele-mcp (版本未知 —— 找不到 package.json)",

  // ---------------------------------------------------------------------------
  // cli.resume_context.* — `stele resume --for-context` 格式化器
  // ---------------------------------------------------------------------------

  "cli.resume_context.header.one": "以下 1 个决策仍悬而未决:",
  "cli.resume_context.header.other": "以下 {count} 个决策仍悬而未决:",
  "cli.resume_context.age_today": "今天",
  "cli.resume_context.age_one_day": "1 天前",
  "cli.resume_context.age_days": "{count} 天前",
  "cli.resume_context.age_months": "{count} 个月前",
  "cli.resume_context.deferred_at": "推迟于 {age}",
  "cli.resume_context.raised_at": "提出于 {age}",
  "cli.resume_context.review_when": "复审条件: {trigger}",
  "cli.resume_context.needs_check":
    "触发条件可能已经到了,值得回看一眼",
  "cli.resume_context.disclaimer":
    "这些只是状态摘要,不是行动指令。继续手头的工作,有线索时再回头处理。",

  // ---------------------------------------------------------------------------
  // cli.top.* — 顶层 / 共享信息
  // ---------------------------------------------------------------------------

  "cli.top.unknown_command":
    "不认识的命令: {cmd}\n\n{usage}",
} as const;

export type ZhKey = keyof typeof ZH;
