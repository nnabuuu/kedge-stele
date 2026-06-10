// Slug-aware fetch helpers + project context.
//
// In multi-tenant mode (the daemon's default), the API lives at
// /<slug>/api/*. In single-project mode (ad-hoc `stele serve`), it
// lives at /api/*. The current slug is derived from the URL — first
// path segment, unless it's a reserved word.

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

export async function apiGet(path) {
  const r = await fetch(`${apiBase()}${path}`, {
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
