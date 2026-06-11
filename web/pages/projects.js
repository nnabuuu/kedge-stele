// Projects page — multi-project overview at /.
//
// Renders against the extended GET /api/projects response (which now
// includes name, status, openLoops, dueLoops, featureCount, featuresByState,
// lastActivity, topFeature). Matches the structure of
// design/Stele Projects.html: global resume strip + sortable project grid +
// collapsible dormant/archived chip.
//
// Layout (within main#view):
//   .resume                — global resume strip (topFeature of the
//                            most-recently-touched live project)
//   .shelf-head            — h2 + sort controls
//   .grid.live             — active + winding cards
//   .tuck                  — collapsible chip
//   .grid.tucked           — dormant + archived (when expanded)
//
// 0.3.0: the umbrella Feature collapsed into the (formerly) Milestone
// layer. Where this file used to read p.topMilestone / .milestonesByState
// it now reads p.topFeature / .featuresByState. The on-card label
// "milestone" became "feature".

import { listProjects, ensureCss } from "../api.js";
import { renderResumeLauncher } from "../components/resume-launcher.js";
import { h, escapeHtml } from "../dom.js";
import { t } from "../i18n.js";

// -------------------------------------------------------------------
// Static enums (cls stays static — label / cssVar come from t() or
// a constant at render time so the locale toggle re-renders pick up
// new strings)
// -------------------------------------------------------------------

const STATUS_KEYS = ["active", "winding", "dormant", "archived"];
function statusCls(s) {
  return STATUS_KEYS.includes(s) ? s : "active";
}
function statusLabel(s) {
  return t(`ui.projects.status.${statusCls(s)}`);
}

const FT_STATE_KEYS = ["draft", "going", "winding", "done", "paused"];
function ftStateCls(s) {
  return FT_STATE_KEYS.includes(s) ? s : "going";
}
function ftStateLabel(s) {
  return t(`ui.projects.ft.${ftStateCls(s)}`);
}

const OUTCOME_VAR = {
  advanced: "--teal",
  resolved: "--green",
  touched: "--warm",
};
function outcomeMeta(type) {
  const k = OUTCOME_VAR[type] ? type : "touched";
  return { cssVar: OUTCOME_VAR[k] };
}

const SORTS = [
  { id: "recent", labelKey: "ui.projects.sort.recent" },
  { id: "due", labelKey: "ui.projects.sort.due" },
  { id: "loops", labelKey: "ui.projects.sort.loops" },
];

// -------------------------------------------------------------------
// Date helpers
// -------------------------------------------------------------------

const DAY_MS = 86_400_000;

function daysAgo(iso) {
  if (!iso) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((Date.now() - parsed) / DAY_MS));
}

function fmtAgo(iso) {
  if (!iso) return t("ui.projects.date.unknown");
  const d = daysAgo(iso);
  if (d <= 0) return t("ui.projects.date.today");
  if (d === 1) return t("ui.projects.date.yesterday");
  if (d < 7)   return t("ui.projects.date.days_ago", { count: d });
  if (d < 14)  return t("ui.projects.date.last_week");
  if (d < 30)  return t("ui.projects.date.weeks_ago", { count: Math.round(d / 7) });
  return t("ui.projects.date.months_ago", { count: Math.round(d / 30) });
}

function fmtWhenShort(iso) {
  if (!iso) return t("ui.projects.date.unknown");
  const dt = new Date(iso);
  if (Number.isNaN(+dt)) return t("ui.projects.date.unknown");
  const d = daysAgo(iso);
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  if (d <= 0) return `${t("ui.projects.date.today")} · ${hh}:${mm}`;
  if (d === 1) return `${t("ui.projects.date.yesterday")} · ${hh}:${mm}`;
  return `${dt.getMonth() + 1}/${String(dt.getDate()).padStart(2, "0")} · ${hh}:${mm}`;
}

function fmtDuration(startedAt, endedAt) {
  if (!startedAt || !endedAt) return null;
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h${m > 0 ? String(m).padStart(2, "0") + "m" : ""}`;
}

// -------------------------------------------------------------------
// Tiny DOM helper
// -------------------------------------------------------------------

// h() + escapeHtml now live in ../dom.js (imported above).

// -------------------------------------------------------------------
// Resume strip (global) — top of page, focal feature of most-recent project
// -------------------------------------------------------------------

function renderResumeStrip(hero, heroF, heroOc) {
  const last = heroF.lastSession;
  const when = fmtWhenShort(last?.startedAt);
  const dur = fmtDuration(last?.startedAt, last?.endedAt);
  const summary = last?.summary ?? heroF.name;

  return h("section", { class: "resume" },
    h("div", { class: "resume-rail" }),
    h("div", { class: "resume-body" },
      h("div", { class: "eyebrow is-seal" }, t("ui.projects.resume.eyebrow")),
      h("div", { class: "resume-loc" },
        h("span", { class: "oc", style: { background: `var(${heroOc.cssVar})` } }),
        h("span", { class: "resume-ms" }, heroF.name),
        h("span", { class: "proj" }, `· ${hero.name}`),
        h("span", { class: "resume-meta" },
          t("ui.projects.resume.last_active", { when: fmtAgo(hero.lastActivity) })),
      ),
      h("div", { class: "resume-sum" },
        h("span", { class: "lead" }, t("ui.projects.resume.lead")),
        summary),
      last
        ? h("div", { class: "resume-when" },
            `${when}${dur ? ` · ${dur}` : ""}`)
        : null,
      h("div", { class: "resume-actions" },
        last?.id ? renderResumeLauncher({ sessionId: last.id, slug: hero.slug }) : null,
        h("a", {
          class: "resume-2nd",
          href: `/${encodeURIComponent(hero.slug)}/`,
          "data-route": "",
        }, t("ui.projects.resume.open_project")),
      ),
    ),
  );
}

// -------------------------------------------------------------------
// Project card
// -------------------------------------------------------------------

function renderProjectCard(p, mostRecentSlug) {
  const cls = statusCls(p.status);
  const recent = p.slug === mostRecentSlug;
  const ft = p.topFeature;
  const isArchived = p.status === "archived";
  const isMissing = p.missing === true;

  const featuresDone = p.featuresByState?.done ?? 0;

  // Card body — feature preview area
  const body = isArchived
    ? h("div", { class: "pc-archnote" },
        h("span", { class: "adot" }),
        h("span", { class: "pc-archnote-t" },
          isMissing ? t("ui.projects.card.missing_db") : t("ui.projects.card.archived")))
    : isMissing
      ? h("div", { class: "pc-archnote" },
          h("span", { class: "adot" }),
          h("span", { class: "pc-archnote-t" }, t("ui.projects.card.missing_path", { path: p.path })))
      : ft
        ? h("div", { class: "pc-ms-list" },
            renderFeatureRow(ft))
        : h("div", { class: "pc-empty" }, t("ui.projects.card.no_feature"));

  return h("a", {
      class: `pcard ${cls}${recent ? " recent" : ""}`,
      href: `/${encodeURIComponent(p.slug)}/`,
      "data-route": "",
    },
    recent ? h("span", { class: "pc-flag" }, t("ui.projects.card.flag_recent")) : null,
    h("div", { class: "pc-top" },
      h("span", { class: "pc-path" }, p.path),
      h("span", { class: `pc-status ${cls}` },
        h("span", { class: "dot" }),
        statusLabel(p.status)),
    ),
    h("div", { class: "pc-name" },
      p.name,
      p.code ? h("i", {}, p.code) : null),
    !isArchived && !isMissing
      ? h("div", { class: "pc-sec-lbl" }, t("ui.projects.card.section_features"),
          h("span", { class: "rule" }))
      : isArchived
        ? h("div", { class: "pc-sec-lbl" }, t("ui.projects.card.section_archived"), h("span", { class: "rule" }))
        : h("div", { class: "pc-sec-lbl" }, t("ui.projects.card.section_status"), h("span", { class: "rule" })),
    body,
    h("div", { class: "pc-foot" },
      h("span", { class: `pc-stat${p.openLoops ? "" : " muted"}` },
        h("b", {}, String(p.openLoops)), " ", t("ui.projects.card.foot_open")),
      p.dueLoops > 0
        ? h("span", { class: "pc-stat due" },
            h("b", {}, String(p.dueLoops)), " ", t("ui.projects.card.foot_due"))
        : null,
      h("span", { class: "pc-stat muted" },
        h("b", {}, String(p.featureCount)), " ", t("ui.projects.card.foot_features"), " · ",
        h("b", {}, String(featuresDone)), " ", t("ui.projects.card.foot_done")),
      h("span", { class: "pc-go" }, t("ui.projects.card.cta")),
    ),
  );
}

function renderFeatureRow(f) {
  const cls = ftStateCls(f.state);
  const last = f.lastSession;
  const ocType = last?.outcome?.type;
  const oc = outcomeMeta(ocType);
  const summary = last?.summary ?? t("ui.projects.date.unknown");

  return h("div", { class: "pc-ms", style: { "--oc": `var(${oc.cssVar})` } },
    h("div", { class: "pc-ms-top" },
      h("span", { class: "pc-ms-dot" }),
      h("span", { class: "pc-ms-name" }, f.name),
    ),
    h("div", { class: "pc-ms-meta" },
      last ? h("span", { class: "pc-ms-sessions" }, fmtAgo(last.startedAt)) : null,
      h("span", { class: `ms-status ${cls}` }, ftStateLabel(f.state)),
    ),
    summary !== t("ui.projects.date.unknown")
      ? h("div", { class: "pc-ms-sum" },
          h("span", { class: "lead" }, t("ui.projects.feature_row.last_label")),
          h("span", {}, summary))
      : null,
  );
}

// -------------------------------------------------------------------
// Sort + filter
// -------------------------------------------------------------------

const SORT_FN = {
  recent: (a, b) => daysAgo(a.lastActivity) - daysAgo(b.lastActivity),
  due:    (a, b) => (b.dueLoops - a.dueLoops) || (daysAgo(a.lastActivity) - daysAgo(b.lastActivity)),
  loops:  (a, b) => (b.openLoops - a.openLoops) || (b.dueLoops - a.dueLoops),
};

function partitionAndSort(projects, sortId) {
  const live = projects.filter((p) => p.status === "active" || p.status === "winding" || p.status == null);
  const tucked = projects.filter((p) => p.status === "dormant" || p.status === "archived");
  live.sort(SORT_FN[sortId] ?? SORT_FN.recent);
  tucked.sort((a, b) =>
    a.status === b.status
      ? daysAgo(a.lastActivity) - daysAgo(b.lastActivity)
      : (a.status === "dormant" ? -1 : 1));
  return { live, tucked };
}

function mostRecentSlug(projects) {
  const live = projects.filter((p) => p.status !== "archived" && p.lastActivity != null);
  if (live.length === 0) return null;
  live.sort((a, b) => daysAgo(a.lastActivity) - daysAgo(b.lastActivity));
  return live[0].slug;
}

// -------------------------------------------------------------------
// Main render
// -------------------------------------------------------------------

let state = {
  sort: "recent",
  showTucked: false,
};

export async function render(root, _ctx) {
  ensureCss("/assets/styles/pages/projects.css");
  root.innerHTML = `<div class="loading">${escapeHtml(t("ui.projects.loading"))}</div>`;

  let projects;
  try {
    projects = await listProjects();
  } catch (err) {
    root.innerHTML = `<div class="loading">${escapeHtml(t("ui.projects.load_failed", { reason: String(err.message ?? err) }))}</div>`;
    return;
  }

  if (!Array.isArray(projects) || projects.length === 0) {
    root.innerHTML = "";
    root.append(renderEmptyState());
    return;
  }

  rerender(root, projects);
}

function rerender(root, projects) {
  root.innerHTML = "";

  const recentSlug = mostRecentSlug(projects);
  const hero = projects.find((p) => p.slug === recentSlug) ?? projects[0];
  const heroF = hero?.topFeature;
  const heroOcType = heroF?.lastSession?.outcome?.type;
  const heroOc = outcomeMeta(heroOcType);

  if (heroF) {
    root.append(renderResumeStrip(hero, heroF, heroOc));
  }

  const { live, tucked } = partitionAndSort(projects, state.sort);

  // Shelf head — title + sort
  const totalLive = live.length;
  const totalAll = projects.length;
  root.append(h("div", { class: "shelf-head" },
    h("div", {},
      h("h2", {}, t("ui.projects.shelf.heading")),
      h("div", { class: "shelf-sub" },
        t("ui.projects.shelf.sub", { live: totalLive, total: totalAll })),
    ),
    h("div", { class: "sorter" },
      ...SORTS.map((s) =>
        h("button", {
          class: state.sort === s.id ? "on" : "",
          type: "button",
          onClick: () => { state.sort = s.id; rerender(root, projects); },
        }, t(s.labelKey)),
      ),
    ),
  ));

  // Live grid
  root.append(h("div", { class: "grid live" },
    ...live.map((p) => renderProjectCard(p, recentSlug)),
  ));

  // Tucked chip + grid
  if (tucked.length > 0) {
    root.append(h("div", { class: "tuck" },
      h("button", {
        class: `tuck-chip${state.showTucked ? " on" : ""}`,
        type: "button",
        onClick: () => { state.showTucked = !state.showTucked; rerender(root, projects); },
      },
        state.showTucked
          ? t("ui.projects.tuck.collapse")
          : [t("ui.projects.tuck.expand"), h("b", {}, String(tucked.length))]),
      h("span", { class: "tuck-rule" }),
    ));
    if (state.showTucked) {
      root.append(h("div", { class: "grid tucked" },
        ...tucked.map((p) => renderProjectCard(p, recentSlug)),
      ));
    }
  }

  // Footer stats
  const totalLoops = projects.reduce((s, p) => s + (p.openLoops ?? 0), 0);
  const totalDue   = projects.reduce((s, p) => s + (p.dueLoops ?? 0), 0);
  root.append(h("div", { class: "shelf-foot" },
    h("span", {}, h("span", { class: "n" }, String(totalAll)), " ", t("ui.projects.shelf_foot.projects")),
    h("span", {}, h("span", { class: "n" }, String(totalLoops)), " ", t("ui.projects.shelf_foot.loops")),
    h("span", {}, h("span", { class: "n" }, String(totalDue)), " ", t("ui.projects.shelf_foot.due")),
    h("span", { class: "tagline" }, t("ui.projects.shelf_foot.tagline")),
  ));
}

function renderEmptyState() {
  return h("section", { class: "placeholder" },
    h("div", { class: "eyebrow" }, t("ui.projects.empty.eyebrow")),
    h("h1", {}, t("ui.projects.empty.heading")),
    h("p", { class: "hint" },
      t("ui.projects.empty.hint_p1"),
      h("code", {}, "stele init"),
      t("ui.projects.empty.hint_p2"),
      h("code", {}, "~/.stele/registry.json"),
      t("ui.projects.empty.hint_p3")),
  );
}
