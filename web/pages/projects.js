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

// -------------------------------------------------------------------
// Static enums (mirror src/types.ts + the design mock's labels)
// -------------------------------------------------------------------

const STATUS_META = {
  active:   { label: "推进中", cls: "active" },
  winding:  { label: "收尾中", cls: "winding" },
  dormant:  { label: "搁置中", cls: "dormant" },
  archived: { label: "已归档", cls: "archived" },
};

const FT_STATE = {
  draft:   { label: "草稿", cls: "draft" },
  going:   { label: "进行中", cls: "going" },
  winding: { label: "收尾",   cls: "winding" },
  done:    { label: "已完成", cls: "done" },
  paused:  { label: "搁置",   cls: "paused" },
};

const OUTCOME = {
  advanced: { label: "推进", cssVar: "--teal" },
  resolved: { label: "解决", cssVar: "--green" },
  touched:  { label: "补充", cssVar: "--warm" },
};

const SORTS = [
  { id: "recent", label: "最近的对话" },
  { id: "due",    label: "待关注优先" },
  { id: "loops",  label: "未闭合最多" },
];

// -------------------------------------------------------------------
// Date helpers
// -------------------------------------------------------------------

const DAY_MS = 86_400_000;

function daysAgo(iso) {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((Date.now() - t) / DAY_MS));
}

function fmtAgo(iso) {
  if (!iso) return "—";
  const d = daysAgo(iso);
  if (d <= 0) return "今天";
  if (d === 1) return "昨天";
  if (d < 7)   return `${d} 天前`;
  if (d < 14)  return "上周";
  if (d < 30)  return `${Math.round(d / 7)} 周前`;
  return `${Math.round(d / 30)} 个月前`;
}

function fmtWhenShort(iso) {
  if (!iso) return "—";
  const dt = new Date(iso);
  if (Number.isNaN(+dt)) return "—";
  const d = daysAgo(iso);
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  if (d <= 0) return `今天 · ${hh}:${mm}`;
  if (d === 1) return `昨天 · ${hh}:${mm}`;
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
      h("div", { class: "eyebrow is-seal" }, "继续上次的对话"),
      h("div", { class: "resume-loc" },
        h("span", { class: "oc", style: { background: `var(${heroOc.cssVar})` } }),
        h("span", { class: "resume-ms" }, heroF.name),
        h("span", { class: "proj" }, `· ${hero.name}`),
        h("span", { class: "resume-meta" },
          `最近活跃 ${fmtAgo(hero.lastActivity)}`),
      ),
      h("div", { class: "resume-sum" },
        h("span", { class: "lead" }, "上次聊到"),
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
        }, "进入项目 →"),
      ),
    ),
  );
}

// -------------------------------------------------------------------
// Project card
// -------------------------------------------------------------------

function renderProjectCard(p, mostRecentSlug) {
  const meta = STATUS_META[p.status] ?? STATUS_META.active;
  const recent = p.slug === mostRecentSlug;
  const ft = p.topFeature;
  const isArchived = p.status === "archived";
  const isMissing = p.missing === true;

  const featuresDone = p.featuresByState?.done ?? 0;

  // Card body — feature preview area
  const body = isArchived
    ? h("div", { class: "pc-archnote" },
        h("span", { class: "adot" }),
        h("span", { class: "pc-archnote-t" }, isMissing ? ".stele/decisions.db 不可读" : "已归档项目"))
    : isMissing
      ? h("div", { class: "pc-archnote" },
          h("span", { class: "adot" }),
          h("span", { class: "pc-archnote-t" }, `${p.path} · .stele/ 不存在或不可读`))
      : ft
        ? h("div", { class: "pc-ms-list" },
            renderFeatureRow(ft))
        : h("div", { class: "pc-empty" }, "还没有 feature");

  return h("a", {
      class: `pcard ${meta.cls}${recent ? " recent" : ""}`,
      href: `/${encodeURIComponent(p.slug)}/`,
      "data-route": "",
    },
    recent ? h("span", { class: "pc-flag" }, "最近一次对话") : null,
    h("div", { class: "pc-top" },
      h("span", { class: "pc-path" }, p.path),
      h("span", { class: `pc-status ${meta.cls}` },
        h("span", { class: "dot" }),
        meta.label),
    ),
    h("div", { class: "pc-name" },
      p.name,
      p.code ? h("i", {}, p.code) : null),
    !isArchived && !isMissing
      ? h("div", { class: "pc-sec-lbl" }, "feature · 各自由多次对话累积",
          h("span", { class: "rule" }))
      : isArchived
        ? h("div", { class: "pc-sec-lbl" }, "归档去向", h("span", { class: "rule" }))
        : h("div", { class: "pc-sec-lbl" }, "状态", h("span", { class: "rule" })),
    body,
    h("div", { class: "pc-foot" },
      h("span", { class: `pc-stat${p.openLoops ? "" : " muted"}` },
        h("b", {}, String(p.openLoops)), " 未闭合"),
      p.dueLoops > 0
        ? h("span", { class: "pc-stat due" },
            h("b", {}, String(p.dueLoops)), " 待关注")
        : null,
      h("span", { class: "pc-stat muted" },
        h("b", {}, String(p.featureCount)), " feature · ",
        h("b", {}, String(featuresDone)), " 完成"),
      h("span", { class: "pc-go" }, "进入 →"),
    ),
  );
}

function renderFeatureRow(f) {
  const st = FT_STATE[f.state] ?? FT_STATE.going;
  const last = f.lastSession;
  const ocType = last?.outcome?.type;
  const oc = ocType ? OUTCOME[ocType] : OUTCOME.touched;
  const summary = last?.summary ?? "—";

  return h("div", { class: "pc-ms", style: { "--oc": `var(${oc.cssVar})` } },
    h("div", { class: "pc-ms-top" },
      h("span", { class: "pc-ms-dot" }),
      h("span", { class: "pc-ms-name" }, f.name),
    ),
    h("div", { class: "pc-ms-meta" },
      last ? h("span", { class: "pc-ms-sessions" }, fmtAgo(last.startedAt)) : null,
      h("span", { class: `ms-status ${st.cls}` }, st.label),
    ),
    summary !== "—"
      ? h("div", { class: "pc-ms-sum" },
          h("span", { class: "lead" }, "上次"),
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
  root.innerHTML = `<div class="loading">loading projects…</div>`;

  let projects;
  try {
    projects = await listProjects();
  } catch (err) {
    root.innerHTML = `<div class="loading">failed to load /api/projects · ${escapeHtml(err.message ?? err)}</div>`;
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
  const heroOc = heroOcType ? OUTCOME[heroOcType] : OUTCOME.touched;

  if (heroF) {
    root.append(renderResumeStrip(hero, heroF, heroOc));
  }

  const { live, tucked } = partitionAndSort(projects, state.sort);

  // Shelf head — title + sort
  const totalLive = live.length;
  const totalAll = projects.length;
  root.append(h("div", { class: "shelf-head" },
    h("div", {},
      h("h2", {}, "在记录的 project"),
      h("div", { class: "shelf-sub" },
        `${totalLive} 个在推进 · ${totalAll} 个在记录`),
    ),
    h("div", { class: "sorter" },
      ...SORTS.map((s) =>
        h("button", {
          class: state.sort === s.id ? "on" : "",
          type: "button",
          onClick: () => { state.sort = s.id; rerender(root, projects); },
        }, s.label),
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
          ? "收起搁置 / 归档"
          : ["搁置 / 归档 ", h("b", {}, String(tucked.length))]),
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
    h("span", {}, h("span", { class: "n" }, String(totalAll)), " 个 project 在记录"),
    h("span", {}, h("span", { class: "n" }, String(totalLoops)), " 个未闭合回路"),
    h("span", {}, h("span", { class: "n" }, String(totalDue)), " 项待关注"),
    h("span", { class: "tagline" }, "视图都是当场从图里查的 — 图一变,这屏就跟着变。"),
  ));
}

function renderEmptyState() {
  return h("section", { class: "placeholder" },
    h("div", { class: "eyebrow" }, "No projects"),
    h("h1", {}, "还没有项目在记录"),
    h("p", { class: "hint" },
      "在任意项目根目录跑 ",
      h("code", {}, "stele init"),
      " 把它注册到 ",
      h("code", {}, "~/.stele/registry.json"),
      "。装好的项目会出现在这里。"),
  );
}
