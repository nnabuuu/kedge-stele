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
import { escapeHtml } from "./dom.js";
import { loadLocale, setLocale, t } from "./i18n.js";

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
  // /<slug>/d/<fid>/<did>
  // URL.pathname keeps percent-encoded segments encoded; decode once here
  // so page modules can do a single encodeURIComponent() when building API
  // calls (otherwise non-ASCII feature names get double-encoded and the
  // server's decode peels off only one layer, missing the real id).
  if (second === "d" && parts.length >= 4) {
    return {
      page: "trace",
      slug,
      params: {
        fid: decodeURIComponent(parts[2]),
        did: decodeURIComponent(parts.slice(3).join("/")),
      },
      scope: "v-trace",
    };
  }

  // Legacy 0.0.7-era routes — rewrite to new equivalents
  if (second === "decisions" && parts.length >= 3) {
    // Decision IDs use a "<feature>/<local>" format; if encoded as
    // <slug>/decisions/<f>/<local>, parts.length === 4. If a single-token
    // id was used, route through trace anyway.
    const fid = parts[2];
    const did = parts.length >= 4 ? parts.slice(3).join("/") : "_";
    const target = `/${slug}/d/${fid}/${did}`;
    history.replaceState(null, "", target);
    return resolveRoute();
  }
  // 0.2.x legacy: /<slug>/milestones and /<slug>/features-as-umbrella
  // both collapse to the bare project view in 0.3.0.
  if (second === "milestones" || second === "features" || second === "new") {
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
        { href: "/", label: t("ui.topbar.projects_link") },
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

// Toggle handler bound by topbar click delegation. Lives here (not in
// the topbar itself) so the route() reference is in scope without an
// import cycle.
function bindLangToggle() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-lang]");
    if (!btn) return;
    e.preventDefault();
    const target = btn.getAttribute("data-lang");
    setLocale(target, { onChange: route }).catch((err) =>
      console.error("[stele] setLocale failed:", err),
    );
  });
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
  root.innerHTML = `<div class="loading">${escapeHtml(t("ui.common.loading"))}</div>`;
  try {
    const mod = await loadPageModule(page);
    await mod.render(root, { slug, params, apiBase: apiBase() });
  } catch (err) {
    console.error(`[stele] page "${page}" failed:`, err);
    root.innerHTML = `<div class="loading">${escapeHtml(t("ui.common.page_failed", { page, reason: String(err.message ?? err) }))}</div>`;
  }
}

// escapeHtml now lives in ./dom.js (imported above).

// -------------------------------------------------------------------
// Boot
// -------------------------------------------------------------------

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

async function boot() {
  // Locale BEFORE anything renders — pages call t() at render-time.
  try {
    await loadLocale();
  } catch (err) {
    console.error("[stele] loadLocale() failed (defaulting to en):", err);
  }
  bindLangToggle();
  interceptNav();
  route().catch((err) => console.error("[stele] initial route() failed:", err));
}
