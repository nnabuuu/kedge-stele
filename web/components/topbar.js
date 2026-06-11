// Shared topbar component.
//
// The base shell (in app.js) renders a minimal topbar; richer pages
// (Projects, Project, Trace, etc.) compose this component to add
// breadcrumbs, project switcher, search, and resume launcher.
//
// 0.5.0 — added the language toggle (中文 | EN) on the right. Clicks
// are handled by delegation in app.js's bindLangToggle() so this
// component stays presentation-only.

import { currentSlug, slugUrl } from "../api.js";
import { escapeHtml } from "../dom.js";
import { getLocale, t } from "../i18n.js";

function renderLangToggle() {
  const cur = getLocale();
  const label = (locale, text) => {
    const active = cur === locale ? " active" : "";
    return `<button type="button" class="lang-toggle-btn${active}" data-lang="${locale}" aria-pressed="${cur === locale}">${escapeHtml(text)}</button>`;
  };
  return `
    <div class="lang-toggle" role="group" aria-label="${escapeHtml(t("ui.topbar.lang_toggle_label"))}">
      ${label("zh", "中文")}
      ${label("en", "EN")}
    </div>
  `;
}

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
        <div class="topbar-actions">${actions}${renderLangToggle()}</div>
      </div>
    </header>
  `;
}

// escapeHtml now lives in ../dom.js (imported above).
