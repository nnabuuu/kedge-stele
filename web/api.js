// Slug-aware fetch helpers + project context.
//
// In multi-tenant mode (the daemon's default), the API lives at
// /<slug>/api/*. In single-project mode (ad-hoc `stele serve`), it
// lives at /api/*. The current slug is derived from the URL — first
// path segment, unless it's a reserved word.

import { getLocale } from "./i18n.js";

const RESERVED_FIRST_SEG = new Set([
  "",         // root
  "welcome",  // landing stub
  "assets",   // static assets
  "api",      // single-project API
]);

export function currentSlug() {
  const seg = location.pathname.split("/").filter(Boolean)[0];
  if (!seg || RESERVED_FIRST_SEG.has(seg)) return null;
  return seg;
}

export function apiBase() {
  const slug = currentSlug();
  return slug ? `/${slug}/api` : "/api";
}

// Append `?lang=` to the URL so server-rendered prose (Trace.statusLine,
// resumeDigest's trigger field) comes back in the current locale. This is
// independent of the SPA's t() calls — those use the client-side locale
// directly — but server-rendered strings have to be requested with the
// correct locale or they fall through to the daemon's process default.
function withLang(path) {
  const lang = getLocale();
  if (!lang) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}lang=${encodeURIComponent(lang)}`;
}

export async function apiGet(path) {
  const r = await fetch(`${apiBase()}${withLang(path)}`, {
    headers: { accept: "application/json" },
  });
  if (!r.ok) {
    throw new Error(`GET ${path}: HTTP ${r.status}`);
  }
  return r.json();
}

export async function apiPost(path, body) {
  const r = await fetch(`${apiBase()}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) {
    throw new Error(`POST ${path}: HTTP ${r.status}`);
  }
  return r.json();
}

export async function apiDelete(path) {
  const r = await fetch(`${apiBase()}${path}`, {
    method: "DELETE",
    headers: { accept: "application/json" },
  });
  if (!r.ok) {
    throw new Error(`DELETE ${path}: HTTP ${r.status}`);
  }
  return r.json();
}

// Global (non-slug-prefixed) routes — only the projects list right now.
export async function listProjects() {
  const r = await fetch(`/api/projects`, {
    headers: { accept: "application/json" },
  });
  if (!r.ok) {
    throw new Error(`GET /api/projects: HTTP ${r.status}`);
  }
  return r.json();
}

// Build a slug-aware URL for a relative path. Useful for href construction.
export function slugUrl(path) {
  const slug = currentSlug();
  if (!slug) return path;
  if (path.startsWith("/")) return `/${slug}${path}`;
  return `/${slug}/${path}`;
}

// Lazy-load a stylesheet exactly once. Page modules call this on render()
// so per-page CSS doesn't all ship at first paint.
const _loadedCss = new Set();
export function ensureCss(href) {
  if (_loadedCss.has(href)) return;
  _loadedCss.add(href);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}
