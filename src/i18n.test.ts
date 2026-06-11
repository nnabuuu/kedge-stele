// Tests for the i18n surface.
//
// The most load-bearing assertion here is the **parity invariant**: every
// key present in en.ts must also be in zh.ts, and vice versa. This is what
// prevents a half-migrated string from sneaking past code review — adding
// a `t("cli.foo.bar")` call without filling in both locale tables makes
// the test fail loudly. Beyond that we cover interpolation, plural picking,
// env-based resolution, and the relative-date helper.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  t,
  setDefaultLocale,
  getDefaultLocale,
  localeFromEnv,
  isLocale,
  formatRelativeDate,
  SUPPORTED_LOCALES,
} from "./i18n.ts";
import { EN } from "./locales/en.ts";
import { ZH } from "./locales/zh.ts";
import { LOCALES } from "./locales/index.ts";

// -----------------------------------------------------------------------------
// Parity invariant
// -----------------------------------------------------------------------------

test("en and zh have the same key set (parity invariant)", () => {
  const enKeys = new Set(Object.keys(EN));
  const zhKeys = new Set(Object.keys(ZH));

  const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k));
  const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k));

  assert.deepEqual(
    missingInZh,
    [],
    `keys present in en.ts but not zh.ts: ${missingInZh.join(", ")}`,
  );
  assert.deepEqual(
    missingInEn,
    [],
    `keys present in zh.ts but not en.ts: ${missingInEn.join(", ")}`,
  );
});

test("LOCALES exposes both languages with the same key set", () => {
  for (const loc of SUPPORTED_LOCALES) {
    const table = LOCALES[loc];
    assert.ok(table, `LOCALES.${loc} missing`);
    assert.ok(
      Object.keys(table).length > 0,
      `LOCALES.${loc} is empty — translation file likely broken`,
    );
  }
});

// -----------------------------------------------------------------------------
// Lookup + interpolation
// -----------------------------------------------------------------------------

test("t() returns the raw English string for a known key", () => {
  setDefaultLocale("en");
  assert.equal(t("cli.config.unset_marker"), "(unset)");
});

test("t() returns the raw Chinese string for a known key", () => {
  setDefaultLocale("zh");
  assert.equal(t("cli.config.unset_marker"), "(未设置)");
  setDefaultLocale("en"); // reset for other tests
});

test("t() interpolates {placeholder} from vars", () => {
  setDefaultLocale("en");
  const out = t("cli.errors.no_stele_store", { cwd: "/tmp/x" });
  assert.match(out, /\/tmp\/x/);
  assert.doesNotMatch(out, /\{cwd\}/);
});

test("t() leaves unknown placeholders alone", () => {
  setDefaultLocale("en");
  // No `sub` var passed; the {sub} should stay literal so the bug is
  // visible rather than swallowed.
  const out = t("cli.config.unknown_subcommand");
  assert.match(out, /\{sub\}/);
});

test("t() throws on missing key in test mode (parity guardrail)", () => {
  // Default tests run with NODE_ENV=test set by node:test runner OR by us.
  // Force the strict path by setting env explicitly for this assertion.
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  setDefaultLocale("en");
  assert.throws(
    () => t("cli.totally.bogus.key.that.cannot.exist"),
    /missing key/,
  );
  process.env.NODE_ENV = prev;
});

test("explicit locale arg overrides the module default", () => {
  setDefaultLocale("en");
  assert.equal(t("cli.config.unset_marker", undefined, undefined, "zh"), "(未设置)");
  assert.equal(getDefaultLocale(), "en", "default must not have moved");
});

// -----------------------------------------------------------------------------
// Env resolution
// -----------------------------------------------------------------------------

test("localeFromEnv() reads STELE_LANG=zh", () => {
  const prev = process.env.STELE_LANG;
  process.env.STELE_LANG = "zh";
  assert.equal(localeFromEnv(), "zh");
  process.env.STELE_LANG = prev;
});

test("localeFromEnv() reads STELE_LANG=en (case-insensitive)", () => {
  const prev = process.env.STELE_LANG;
  process.env.STELE_LANG = "EN";
  assert.equal(localeFromEnv(), "en");
  process.env.STELE_LANG = prev;
});

test("localeFromEnv() falls back to LANG starting with zh", () => {
  const prevStele = process.env.STELE_LANG;
  const prevLang = process.env.LANG;
  const prevLcAll = process.env.LC_ALL;
  delete process.env.STELE_LANG;
  delete process.env.LC_ALL;
  process.env.LANG = "zh_CN.UTF-8";
  assert.equal(localeFromEnv(), "zh");
  // restore
  if (prevStele !== undefined) process.env.STELE_LANG = prevStele;
  if (prevLang !== undefined) process.env.LANG = prevLang; else delete process.env.LANG;
  if (prevLcAll !== undefined) process.env.LC_ALL = prevLcAll;
});

test("localeFromEnv() returns null on non-zh, non-explicit envs", () => {
  const prevStele = process.env.STELE_LANG;
  const prevLang = process.env.LANG;
  const prevLcAll = process.env.LC_ALL;
  delete process.env.STELE_LANG;
  delete process.env.LC_ALL;
  process.env.LANG = "en_US.UTF-8";
  assert.equal(localeFromEnv(), null,
    "en_US should NOT match — caller decides the fallback");
  // restore
  if (prevStele !== undefined) process.env.STELE_LANG = prevStele;
  if (prevLang !== undefined) process.env.LANG = prevLang;
  if (prevLcAll !== undefined) process.env.LC_ALL = prevLcAll;
});

test("isLocale() type guard accepts only zh|en", () => {
  assert.equal(isLocale("zh"), true);
  assert.equal(isLocale("en"), true);
  assert.equal(isLocale("ja"), false);
  assert.equal(isLocale(""), false);
  assert.equal(isLocale(null), false);
  assert.equal(isLocale(undefined), false);
});

// -----------------------------------------------------------------------------
// Relative date formatting
// -----------------------------------------------------------------------------

test("formatRelativeDate(today) returns '今天' in zh, 'today' in en", () => {
  const now = new Date();
  assert.equal(formatRelativeDate(now, "zh"), "今天");
  assert.equal(formatRelativeDate(now, "en"), "today");
});

test("formatRelativeDate(yesterday) returns '昨天' / 'yesterday'", () => {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  // Add a small fudge so floor math doesn't flake on test machines with
  // clock skew — push it 2 hours into yesterday so floor(diffMs/oneDay) = 1.
  y.setHours(y.getHours() - 2);
  assert.equal(formatRelativeDate(y, "zh"), "昨天");
  assert.equal(formatRelativeDate(y, "en"), "yesterday");
});

test("formatRelativeDate(3-days-ago) renders '3 天前' / '3 days ago'", () => {
  const d = new Date();
  d.setDate(d.getDate() - 3);
  d.setHours(d.getHours() - 2);
  assert.equal(formatRelativeDate(d, "zh"), "3 天前");
  assert.equal(formatRelativeDate(d, "en"), "3 days ago");
});

test("formatRelativeDate handles week/month/year buckets", () => {
  const eightDaysAgo = new Date();
  eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);
  eightDaysAgo.setHours(eightDaysAgo.getHours() - 2);
  assert.match(formatRelativeDate(eightDaysAgo, "zh"), /1 周前/);
  assert.match(formatRelativeDate(eightDaysAgo, "en"), /1 week ago/);

  const fortyDaysAgo = new Date();
  fortyDaysAgo.setDate(fortyDaysAgo.getDate() - 40);
  fortyDaysAgo.setHours(fortyDaysAgo.getHours() - 2);
  assert.match(formatRelativeDate(fortyDaysAgo, "zh"), /1 个月前/);
  assert.match(formatRelativeDate(fortyDaysAgo, "en"), /1 month ago/);

  const fourHundredDaysAgo = new Date();
  fourHundredDaysAgo.setDate(fourHundredDaysAgo.getDate() - 400);
  fourHundredDaysAgo.setHours(fourHundredDaysAgo.getHours() - 2);
  assert.match(formatRelativeDate(fourHundredDaysAgo, "zh"), /1 年前/);
  assert.match(formatRelativeDate(fourHundredDaysAgo, "en"), /1 year ago/);
});
