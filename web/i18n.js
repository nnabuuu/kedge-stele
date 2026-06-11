// stele web UI i18n — mirror of src/i18n.ts for the SPA surface.
//
// Same shape on both sides: flat keys, {placeholder} interpolation,
// .one/.other plural suffix. Two locales (zh / en); no third without
// a real ask.
//
// Resolution order (resolveLocale, called from boot()):
//   1. ?lang=zh|en in the URL (shareable links can pin a language).
//   2. The project's display_language from /api/config (cached on boot).
//   3. localStorage.getItem("stele:lang").
//   4. navigator.language startsWith "zh" → zh, else en.
//
// Toggle flow (setLocale):
//   1. Write localStorage.
//   2. POST display_language to the server (when there's a current slug).
//   3. Set <html lang=...>.
//   4. Trigger a re-render via the supplied route() callback.

import { currentSlug, apiBase } from "./api.js";
import { LOCALES_EN } from "./locales/en.js";
import { LOCALES_ZH } from "./locales/zh.js";

const TABLES = { en: LOCALES_EN, zh: LOCALES_ZH };

export const SUPPORTED_LOCALES = ["zh", "en"];

let currentLocale = "en";

export function getLocale() {
  return currentLocale;
}

function isLocale(s) {
  return s === "zh" || s === "en";
}

const PLACEHOLDER_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

function interpolate(template, vars) {
  if (!vars) return template;
  return template.replace(PLACEHOLDER_RE, (match, name) => {
    const v = vars[name];
    return v === undefined || v === null ? match : String(v);
  });
}

function pickKey(key, count) {
  if (count === undefined || count === null) return key;
  return count === 1 ? `${key}.one` : `${key}.other`;
}

function lookup(locale, key) {
  return TABLES[locale]?.[key];
}

// Translate a key. Vars get {placeholder} interpolated; count switches
// the plural picker (.one / .other suffix).
export function t(key, vars, count) {
  const lookupKey = pickKey(key, count);
  const direct = lookup(currentLocale, lookupKey);
  if (direct !== undefined) return interpolate(direct, vars);

  if (count !== undefined && count !== null) {
    const base = lookup(currentLocale, key);
    if (base !== undefined) return interpolate(base, vars);
  }

  // Fallback to en if we were on zh.
  if (currentLocale !== "en") {
    const fallback = lookup("en", lookupKey)
      ?? (count !== undefined && count !== null ? lookup("en", key) : undefined);
    if (fallback !== undefined) {
      console.warn(`[i18n] missing "${lookupKey}" for ${currentLocale} — falling back to en`);
      return interpolate(fallback, vars);
    }
  }

  console.warn(`[i18n] missing "${lookupKey}" — using bare key`);
  return lookupKey;
}

// Resolve the locale at boot time. The serverConfig arg (from
// /api/config) is checked for `display_language` after the URL ?lang.
async function resolveLocale() {
  // 1. ?lang=
  const url = new URL(location.href);
  const fromQuery = url.searchParams.get("lang")?.toLowerCase();
  if (isLocale(fromQuery)) return fromQuery;

  // 2. server config (only when in a project — the projects landing has no slug)
  const slug = currentSlug();
  if (slug) {
    try {
      const r = await fetch(`${apiBase()}/config`, {
        headers: { accept: "application/json" },
      });
      if (r.ok) {
        const cfg = await r.json();
        const fromServer = cfg?.display_language?.toLowerCase();
        if (isLocale(fromServer)) return fromServer;
      }
    } catch {
      // network error — fall through to localStorage
    }
  }

  // 3. localStorage
  try {
    const fromStorage = localStorage.getItem("stele:lang")?.toLowerCase();
    if (isLocale(fromStorage)) return fromStorage;
  } catch {
    // private mode / disabled — fall through
  }

  // 4. browser language
  const browser = (navigator.language || "en").toLowerCase();
  return browser.startsWith("zh") ? "zh" : "en";
}

// Called once on boot (from app.js boot()).
export async function loadLocale() {
  currentLocale = await resolveLocale();
  document.documentElement.lang = currentLocale === "zh" ? "zh-CN" : "en";
}

// User-facing toggle. After setLocale resolves, call the provided
// onChange callback (typically the router's route() function) to
// re-render the current page with the new locale.
export async function setLocale(locale, { onChange } = {}) {
  if (!isLocale(locale)) return;
  currentLocale = locale;
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";

  try {
    localStorage.setItem("stele:lang", locale);
  } catch {
    // private mode — no-op
  }

  // Persist to server when in a project. Best-effort; if it fails
  // (404 in single-project mode without the route, or network down)
  // localStorage is still the source of truth client-side.
  const slug = currentSlug();
  if (slug) {
    try {
      await fetch(`${apiBase()}/config/display_language`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ value: locale }),
      });
    } catch {
      // best-effort
    }
  }

  if (typeof onChange === "function") {
    try { await onChange(); } catch (err) { console.error("[i18n] onChange threw:", err); }
  }
}

// Relative date formatter — CN / EN, mirroring src/i18n.ts's helper.
export function formatRelativeDate(input) {
  const date = input instanceof Date ? input : new Date(input);
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (currentLocale === "zh") {
    if (days <= 0) return "今天";
    if (days === 1) return "昨天";
    if (days < 7) return `${days} 天前`;
    if (days < 30) return `${Math.floor(days / 7)} 周前`;
    if (days < 365) return `${Math.floor(days / 30)} 个月前`;
    return `${Math.floor(days / 365)} 年前`;
  }
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
