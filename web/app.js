// Stele · web UI — router + shell + page lazy-loader.
//
// One ES-module SPA. No build, no framework. Routes:
//
//   /                          → Projects   (multi-project overview)
//   /<slug>/                   → Project    (feature rail + timeline)
//   /<slug>/d/<mid>/<did>      → Trace      (decision provenance)
//   /<slug>/tags               → Tags       (tag library)
//   /<slug>/graph              → Decision Graph
//
// Token scope (CSS variable system) is set on <html> via a v-* class
// so each page gets the right palette + typography atomically.
//
// Pages are loaded on demand from /assets/pages/<name>.js — they
// export a render(root, ctx) function.

import { currentSlug, slugUrl, apiBase } from "./api.js";
import { renderTopbar } from "./components/topbar.js";

// Reserved first segments that AREN'T project slugs
const RESERVED_FIRST_SEG = new Set(["", "welcome", "assets", "api"]);

// -------------------------------------------------------------------
// Route resolution
// -------------------------------------------------------------------

function resolveRoute() {
  const parts = location.pathname.split("/").filter(Boolean);

  // Root → Projects overview. Per design/Stele Projects.html the page is
  // already in the in-app system, so we use v-base here (not v-landing —
  // the Landing system is reserved for /welcome and any future hero page).
  if (parts.length === 0) {
    return { page: "projects", slug: null, params: {}, scope: "v-base" };
  }

  const first = parts[0];

  // Single-project mode: /api/* and /assets/* are reserved; /welcome is the landing
  // stub. Anything else at this depth is treated as a slug (multi-tenant) OR as
  // a single-project route segment.
  if (RESERVED_FIRST_SEG.has(first)) {
    return { page: "projects", slug: null, params: {}, scope: "v-base" };
  }

  const slug = first;

  // /<slug>/ → Project page
  if (parts.length === 1) {
    return { page: "project", slug, params: {}, scope: "v-base" };
  }

  const second = parts[1];

  // /<slug>/tags
  if (second === "tags") {
    return { page: "tags", slug, params: {}, scope: "v-trace" };
  }
  // /<slug>/graph
  if (second === "graph") {
    return { page: "graph", slug, params: {}, scope: "v-graph" };
  }
  // /<slug>/d/<mid>/<did>
  if (second === "d" && parts.length >= 4) {
    return {
      page: "trace",
      slug,
      params: { mid: parts[2], did: parts.slice(3).join("/") },
      scope: "v-trace",
    };
  }

  // Legacy 0.0.7-era routes — rewrite to new equivalents
  if (second === "decisions" && parts.length >= 3) {
    const id = parts.slice(2).join("/");
    // Decision IDs use a "<milestone>/<local>" format; if encoded as
    // <slug>/decisions/<m>/<local>, parts.length === 4. If a single-token
    // id was used, route through trace anyway.
    const mid = parts[2];
    const did = parts.length >= 4 ? parts.slice(3).join("/") : "_";
    const target = `/${slug}/d/${mid}/${did}`;
    history.replaceState(null, "", target);
    return resolveRoute();
  }
  if (second === "milestones" || second === "new") {
    history.replaceState(null, "", `/${slug}/`);
    return resolveRoute();
  }

  // Unknown second segment → fall back to Project page
  return { page: "project", slug, params: {}, scope: "v-base" };
}

// -------------------------------------------------------------------
// Token scope
// -------------------------------------------------------------------

function setScope(scope) {
  const html = document.documentElement;
  ["v-landing", "v-base", "v-trace", "v-graph"].forEach((c) => html.classList.remove(c));
  html.classList.add(scope);
}

// -------------------------------------------------------------------
// Page loader (dynamic import)
// -------------------------------------------------------------------

const pageModuleCache = new Map();

async function loadPageModule(page) {
  if (pageModuleCache.has(page)) {
    return pageModuleCache.get(page);
  }
  const mod = await import(`/assets/pages/${page}.js`);
  if (typeof mod.render !== "function") {
    throw new Error(`page module "${page}" missing render(root, ctx) export`);
  }
  pageModuleCache.set(page, mod);
  return mod;
}

// -------------------------------------------------------------------
// Shell
// -------------------------------------------------------------------

function ensureShell() {
  // Topbar
  let topbar = document.querySelector("header.topbar");
  if (!topbar) {
    document.body.insertAdjacentHTML("afterbegin", renderTopbar());
  }
  // Main view container
  let main = document.getElementById("view");
  if (!main) {
    main = document.createElement("main");
    main.id = "view";
    main.className = "view";
    document.body.append(main);
  }
  return main;
}

function updateTopbarForContext(ctx) {
  const slug = ctx.slug;
  const crumbs = slug
    ? [
        { href: "/", label: "Projects" },
        { href: `/${slug}/`, label: slug },
      ]
    : [];
  const newTopbar = renderTopbar({ crumbs });
  const existing = document.querySelector("header.topbar");
  if (existing) {
    existing.outerHTML = newTopbar;
  } else {
    document.body.insertAdjacentHTML("afterbegin", newTopbar);
  }
}

// -------------------------------------------------------------------
// Navigation interception
// -------------------------------------------------------------------

function interceptNav() {
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-route]");
    if (!a) return;
    const href = a.getAttribute("href");
    if (!href) return;
    if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:")) return;
    if (a.target === "_blank") return;
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    if (href !== location.pathname + location.search) {
      history.pushState(null, "", href);
      route().catch((err) => console.error("[stele] route() failed:", err));
    }
  });
  window.addEventListener("popstate", () => {
    route().catch((err) => console.error("[stele] popstate route() failed:", err));
  });
}

// -------------------------------------------------------------------
// Top-level route handler
// -------------------------------------------------------------------

async function route() {
  const { page, slug, params, scope } = resolveRoute();
  setScope(scope);
  const root = ensureShell();
  updateTopbarForContext({ slug });
  root.innerHTML = `<div class="loading">loading…</div>`;
  try {
    const mod = await loadPageModule(page);
    await mod.render(root, { slug, params, apiBase: apiBase() });
  } catch (err) {
    console.error(`[stele] page "${page}" failed:`, err);
    root.innerHTML = `<div class="loading">page "${page}" failed to load · ${escapeHtml(String(err.message ?? err))}</div>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

// -------------------------------------------------------------------
// Boot
// -------------------------------------------------------------------

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

function boot() {
  interceptNav();
  route().catch((err) => console.error("[stele] initial route() failed:", err));
}
