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
} as const;

export type ZhKey = keyof typeof ZH;
