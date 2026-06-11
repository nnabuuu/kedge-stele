// stele i18n — bilingual surface (zh / en) for CLI output, error messages,
// help text, and the resume digest's prose.
//
// Design choices (per § Localization in CLAUDE.md):
//
// - **Two locales only.** This is intentional. `zh` and `en`. We don't gold-
//   plate for a third — when one shows up, add a locale file; the machinery
//   supports it but the codebase doesn't enumerate beyond what's needed.
// - **Flat keys.** Dotted strings like `cli.init.created_stele_dir`, NOT
//   nested objects. Less typing, easier grep, no `obj?.cli?.init?.foo`
//   navigation. The "namespace" is just a key prefix.
// - **Tiny interpolator.** `{placeholder}` substitution, no ICU. The codebase
//   is two-deps; we're not adding a third for translation.
// - **Plural picker.** Optional `count` argument picks `.one` vs `.other`.
//   Chinese has no plurals so both keys point at the same string in zh.ts;
//   English has the inflection.
// - **Parity invariant.** `src/i18n.test.ts` asserts `Object.keys(EN) ===
//   Object.keys(ZH)` (as sets). Missing translations fail the test loudly,
//   so a partial migration can't sneak through.
//
// Resolution order — owned by the CLI entry point (`cli.ts main()`):
//   1. If cwd is in a `.stele/` project AND that store has `display_language`
//      set → use it.
//   2. Else `process.env.STELE_LANG` (case-insensitive, `zh|en`).
//   3. Else `process.env.LANG` / `process.env.LC_ALL` startsWith `zh` → `zh`.
//   4. Else `en`.
//
// `i18n.ts` itself stays a leaf module — knows nothing about `store.ts`.
// `cli.ts` does the store check and calls `setDefaultLocale()`. All other
// CLI files just call `t(key)` which consults the module-level default.

import { LOCALES, type LocaleKey } from "./locales/index.ts";

export type Locale = "zh" | "en";

export const SUPPORTED_LOCALES: readonly Locale[] = ["zh", "en"] as const;

export function isLocale(s: string | null | undefined): s is Locale {
  return s === "zh" || s === "en";
}

// -----------------------------------------------------------------------------
// Env-only resolution helpers (the leaf-module-safe portion)
// -----------------------------------------------------------------------------

/**
 * Read STELE_LANG, then LC_ALL/LANG, then return null (caller decides
 * fallback). Exported so cli.ts can chain it after a store check.
 */
export function localeFromEnv(): Locale | null {
  const explicit = process.env.STELE_LANG?.trim().toLowerCase();
  if (explicit === "zh" || explicit === "en") return explicit;
  const lcAll = process.env.LC_ALL?.trim().toLowerCase() ?? "";
  const lang = process.env.LANG?.trim().toLowerCase() ?? "";
  if (lcAll.startsWith("zh") || lang.startsWith("zh")) return "zh";
  return null;
}

// -----------------------------------------------------------------------------
// Translation lookup + interpolation
// -----------------------------------------------------------------------------

const PLACEHOLDER = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

function interpolate(
  template: string,
  vars?: Record<string, string | number>,
): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (match, name) => {
    const v = vars[name];
    return v === undefined ? match : String(v);
  });
}

function pickKey(key: string, count?: number): string {
  if (count === undefined) return key;
  // Chinese collapses to a single form; English uses one/other. Locale files
  // populate `<key>.one` and `<key>.other` accordingly. If a caller passes
  // count but only the base key exists, fall back to base (handles strings
  // that don't actually inflect — see `t()` below).
  return count === 1 ? `${key}.one` : `${key}.other`;
}

function lookup(locale: Locale, key: string): string | undefined {
  return (LOCALES[locale] as Record<string, string>)[key];
}

// Cached default — most calls don't need to override per-call. Set via
// `setDefaultLocale()` once at startup.
let DEFAULT_LOCALE: Locale = "en";

export function setDefaultLocale(locale: Locale): void {
  DEFAULT_LOCALE = locale;
}

export function getDefaultLocale(): Locale {
  return DEFAULT_LOCALE;
}

/**
 * Look up a translated string for `key`.
 *
 * - `vars`: optional `{placeholder}` substitutions.
 * - `count`: optional plural count; picks `<key>.one` or `<key>.other`.
 * - `locale`: explicit override; otherwise the module-level default.
 *
 * Missing key behaviour:
 * - In `NODE_ENV === "test"`: throw. Tests fail loudly so we catch partial
 *   migration during development.
 * - Otherwise: log to stderr (one line), fall back to the EN string for the
 *   key. If EN is also missing, fall back to the bare key itself so something
 *   readable still shows up.
 */
export function t(
  key: string,
  vars?: Record<string, string | number>,
  count?: number,
  locale?: Locale,
): string {
  const loc = locale ?? DEFAULT_LOCALE;
  const lookupKey = pickKey(key, count);

  const direct = lookup(loc, lookupKey);
  if (direct !== undefined) return interpolate(direct, vars);

  // Plural picker missed but base might exist (string doesn't inflect).
  if (count !== undefined) {
    const base = lookup(loc, key);
    if (base !== undefined) return interpolate(base, vars);
  }

  // Strict mode for tests — surface missing translations.
  if (process.env.NODE_ENV === "test") {
    throw new Error(`i18n: missing key "${lookupKey}" for locale "${loc}"`);
  }

  // Fall back to EN if we were on ZH.
  if (loc !== "en") {
    const fallback =
      lookup("en", lookupKey) ??
      (count !== undefined ? lookup("en", key) : undefined);
    if (fallback !== undefined) {
      process.stderr.write(
        `i18n: missing key "${lookupKey}" for locale "${loc}" — falling back to en\n`,
      );
      return interpolate(fallback, vars);
    }
  }

  process.stderr.write(`i18n: missing key "${lookupKey}" — using bare key\n`);
  return lookupKey;
}

// -----------------------------------------------------------------------------
// Date formatting
// -----------------------------------------------------------------------------

/**
 * Format `date` as a human-readable relative-time string in `locale`.
 *
 * Currently used by the resume digest to render "提出于 3 天前" / "raised
 * 3 days ago" lines. Keep this dumb — the resume digest doesn't need
 * sophisticated intl handling, just consistent CN / EN phrasing.
 */
export function formatRelativeDate(date: Date, locale?: Locale): string {
  const loc = locale ?? DEFAULT_LOCALE;
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const oneDay = 24 * 60 * 60 * 1000;
  const days = Math.floor(diffMs / oneDay);

  if (loc === "zh") {
    if (days <= 0) return "今天";
    if (days === 1) return "昨天";
    if (days < 7) return `${days} 天前`;
    if (days < 30) return `${Math.floor(days / 7)} 周前`;
    if (days < 365) return `${Math.floor(days / 30)} 个月前`;
    return `${Math.floor(days / 365)} 年前`;
  }
  // en
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const w = Math.floor(days / 7);
    return w === 1 ? "1 week ago" : `${w} weeks ago`;
  }
  if (days < 365) {
    const m = Math.floor(days / 30);
    return m === 1 ? "1 month ago" : `${m} months ago`;
  }
  const y = Math.floor(days / 365);
  return y === 1 ? "1 year ago" : `${y} years ago`;
}

export type { LocaleKey };
