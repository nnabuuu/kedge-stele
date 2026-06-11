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
} as const;

export type EnKey = keyof typeof EN;
