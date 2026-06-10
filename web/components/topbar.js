// Shared topbar component.
//
// The base shell (in app.js) renders a minimal topbar; richer pages
// (Projects, Project, Trace, etc.) compose this component to add
// breadcrumbs, project switcher, search, and resume launcher.
//
// Phases 2+ flesh this out.

import { currentSlug, slugUrl } from "../api.js";

export function renderTopbar(opts = {}) {
  const slug = currentSlug();
  const crumbs = opts.crumbs ?? [];
  const actions = opts.actions ?? "";

  const crumbHtml = crumbs.length
    ? `<span class="crumbs">${crumbs.map((c, i) => i === 0
        ? `<a href="${c.href}" data-route>${escapeHtml(c.label)}</a>`
        : `<span class="sep">/</span><a href="${c.href}" data-route>${escapeHtml(c.label)}</a>`).join("")}</span>`
    : "";

  return `
    <header class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="/" data-route>
          <span>实录</span><span class="en">Stele</span>
        </a>
        ${crumbHtml}
        <span class="grow"></span>
        <div class="topbar-actions">${actions}</div>
      </div>
    </header>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}
