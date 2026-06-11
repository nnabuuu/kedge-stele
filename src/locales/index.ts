// Locale registry — exports the per-locale string tables under one roof so
// src/i18n.ts can look up by `LOCALES[locale][key]` without an `if/else`.
//
// The structural type `LocaleKey` derives from the English table, which is
// the editorial source of truth — every key MUST exist in en.ts first, then
// gets mirrored to zh.ts. The parity test in src/i18n.test.ts asserts the
// key sets match at runtime; the type below catches missing-key references
// at compile time.

import { EN, type EnKey } from "./en.ts";
import { ZH } from "./zh.ts";

import type { Locale } from "../i18n.ts";

export const LOCALES: Record<Locale, Record<string, string>> = {
  en: EN,
  zh: ZH,
};

export type LocaleKey = EnKey;
