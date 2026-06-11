// Project page — single-project view at /<slug>/.
//
// Layout matches design/Stele Project.html: sticky topbar with breadcrumbs ·
// left feature rail (sorted by state) · main panel (feature header + resume
// strip + session timeline with decision chips).
//
// 0.3.0 collapsed the umbrella Feature → Milestone hierarchy into a single
// Feature layer. The rail is now a flat list of Features (sorted by state
// rank); the main panel renders the selected Feature's sessions +
// per-session decisions exactly as before, just one level shallower.
//
// API:
//   GET /<slug>/api/project                       project + rollup
//   GET /<slug>/api/features                      flat feature list (was feature-rail)
//   GET /<slug>/api/features/<id>                 selected-feature detail with
//                                                 sessions + per-session decisions

import { apiGet, ensureCss, slugUrl } from "../api.js";
import { renderResumeLauncher } from "../components/resume-launcher.js";
import { h, escapeHtml } from "../dom.js";

// -------------------------------------------------------------------
// Static enums (mirror src/types.ts)
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

// The decision chip colors/labels by derived nodeState, not raw type — a
// resolved deferred (the central provenance act) must read 已解决/green, not
// 推迟/amber. cls matches the .dchip-g.<cls> / .dchip-st.<cls> CSS.
const NODE_STATE_CHIP = {
  decision:   { label: "已决",     cls: "decision" },
  deferred:   { label: "推迟",     cls: "deferred" },
  open:       { label: "悬而未决", cls: "open" },
  resolved:   { label: "已解决",   cls: "resolved" },
  superseded: { label: "已取代",   cls: "superseded" },
};
function nodeStateOf(d) {
  if (d.supersededBy) return "superseded";
  if (d.status === "resolved") return "resolved";
  return d.type; // "decision" | "deferred" | "open"
}

// 0.4.0 — capture provenance pill (rendered in the decision chip footer).
// "manual" gets no pill — the absence IS the marker for human-authored.
const SOURCE_META = {
  "agent-live":      { label: "agent · live",   cls: "agent-live" },
  "session-extract": { label: "agent · post-hoc", cls: "session-extract" },
};

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
  if (d < 7) return `${d} 天前`;
  if (d < 14) return "上周";
  if (d < 30) return `${Math.round(d / 7)} 周前`;
  return `${Math.round(d / 30)} 个月前`;
}

function fmtMD(iso) {
  if (!iso) return "—";
  const dt = new Date(iso);
  if (Number.isNaN(+dt)) return "—";
  return `${dt.getMonth() + 1}/${String(dt.getDate()).padStart(2, "0")}`;
}

function fmtHM(iso) {
  if (!iso) return "—";
  const dt = new Date(iso);
  if (Number.isNaN(+dt)) return "—";
  return `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
}

function fmtWhenShort(iso) {
  if (!iso) return "—";
  const d = daysAgo(iso);
  if (d <= 0) return `今天 · ${fmtHM(iso)}`;
  if (d === 1) return `昨天 · ${fmtHM(iso)}`;
  return `${fmtMD(iso)} · ${fmtHM(iso)}`;
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

// Inline SVG glyph for the timeline node (mock <Icon>, design Stele Trace.html).
// Minimal local copy — the shared icon module is a deferred consolidation.
const SVG_NS = "http://www.w3.org/2000/svg";
const GLYPHS = {
  check: [["polyline", { points: "5 12.5 10 17.5 19 7" }]],
  spark: [["path", { d: "M12 3v4M12 17v4M3 12h4M17 12h4" }], ["circle", { cx: 12, cy: 12, r: 3 }]],
};
function glyph(name, size) {
  const defs = GLYPHS[name];
  if (!defs) return null;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const [tag, attrs] of defs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.append(el);
  }
  return svg;
}

// -------------------------------------------------------------------
// Selection / URL state — `?f=<featureId>` carries the rail selection.
// (0.2.x used `?m=` for the milestone id; we keep `?m=` as a one-release
// legacy alias so deep links from prior dashboards still resolve.)
// -------------------------------------------------------------------

function getSelectedFeatureId() {
  const params = new URLSearchParams(location.search);
  return params.get("f") || params.get("m") || null;
}

function setSelectedFeatureId(id) {
  const url = new URL(location.href);
  if (id) url.searchParams.set("f", id);
  else url.searchParams.delete("f");
  url.searchParams.delete("m"); // strip the legacy alias once we've migrated
  history.replaceState(null, "", url.toString());
}

// 0.4.0 — `?src=` filter for batch review of machine-extracted captures.
// Valid values: 'agent-live' / 'session-extract' / 'manual' / null (no filter).
// Filters the decision chips inside the session timeline; the rail stays
// unchanged so the user can still navigate features.
function getSourceFilter() {
  const v = new URLSearchParams(location.search).get("src");
  if (v === "agent-live" || v === "session-extract" || v === "manual") return v;
  return null;
}

function setSourceFilter(v) {
  const url = new URL(location.href);
  if (v) url.searchParams.set("src", v);
  else url.searchParams.delete("src");
  history.replaceState(null, "", url.toString());
}

function pickDefaultFeature(rail) {
  // First going/winding feature wins; fall back to first one overall.
  for (const f of rail) {
    if (f.state === "going" || f.state === "winding") return f.id;
  }
  return rail[0]?.id ?? null;
}

function findFeatureInRail(rail, fid) {
  return rail.find((f) => f.id === fid) ?? null;
}

// -------------------------------------------------------------------
// Rail
// -------------------------------------------------------------------

// Rail tag-filter state — persists across re-renders (module-level, like the
// 0.4.0 ?src= filter persists in the URL). activeTagFilter is an OR set: a
// feature shows if it carries ANY active tag (empty set ⇒ all features).
let activeTagFilter = [];
let railShowMore = false;

function railTags(rail) {
  const m = new Map();
  for (const f of rail) for (const t of f.tags ?? []) if (!m.has(t.name)) m.set(t.name, t);
  return [...m.values()];
}

function renderRail(rail, selectedFid, onSelect, onToggleTag, onClearTags) {
  const allTags = railTags(rail);
  const active = activeTagFilter;
  const filtered = active.length === 0
    ? rail
    : rail.filter((f) => (f.tags ?? []).some((t) => active.includes(t.name)));

  return h("aside", { class: "rail" },
    h("div", { class: "rail-h" },
      h("h2", {}, "feature"),
      h("div", { class: "rail-h-r" },
        h("span", {}, `${filtered.length} 个`),
      ),
    ),
    allTags.length > 0 ? renderRtools(allTags, active, onToggleTag, onClearTags) : null,
    ...filtered.map((f) =>
      renderFeatureRow(f, selectedFid === f.id, onSelect),
    ),
    filtered.length === 0
      ? h("div", { class: "filt-empty" },
          active.length ? "没有匹配这些标签的 feature" : "没有 feature — 试试在这个项目里跑 /stele:feature")
      : null,
  );
}

function renderRtools(allTags, active, onToggleTag, onClearTags) {
  const DEFAULT_N = 3;
  const shown = allTags.slice(0, DEFAULT_N);
  const extra = allTags.slice(DEFAULT_N);
  return h("div", { class: "rtools" },
    h("div", { class: "rtools-row" },
      h("span", { class: "rtools-lbl" }, "按标签筛选"),
      active.length
        ? h("button", { class: "rtools-clear", type: "button", onClick: onClearTags }, "清除")
        : null,
    ),
    h("div", { class: "rtools-chips" },
      ...shown.map((t) => renderTagChip(t, active.includes(t.name), onToggleTag)),
      extra.length
        ? h("button", {
            class: "tagmore",
            type: "button",
            onClick: () => { railShowMore = !railShowMore; onToggleTag(null); },
          }, railShowMore ? "收起" : `更多 ${extra.length}`)
        : null,
    ),
    railShowMore && extra.length
      ? h("div", { class: "rtools-chips rtools-extra" },
          ...extra.map((t) => renderTagChip(t, active.includes(t.name), onToggleTag)))
      : null,
  );
}

function renderTagChip(t, on, onToggleTag) {
  return h("button", {
      class: `tagchip tog${on ? " on" : ""}`,
      type: "button",
      style: { "--tc": t.color ?? "#9c9a92" },
      onClick: () => onToggleTag(t.name),
    }, t.name);
}

function renderFeatureRow(f, isSelected, onSelect) {
  const st = FT_STATE[f.state] ?? FT_STATE.going;
  return h("button", {
      class: `mrow ${f.state}${isSelected ? " on" : ""}`,
      type: "button",
      onClick: () => onSelect(f.id),
    },
    h("div", { class: "mrow-top" },
      h("span", { class: "mrow-dot" }),
      h("span", { class: "mrow-name" }, f.name),
    ),
    h("div", { class: "mrow-meta" },
      h("span", { class: "mrow-ses" }, `${f.sessionCount} 次对话`),
      f.lastActivity
        ? h("span", {}, `· 最近 ${fmtAgo(f.lastActivity)}`)
        : null,
      h("span", { class: "mrow-state" }, st.label),
    ),
    f.tags.length > 0
      ? h("div", { class: "mrow-tags" },
          ...f.tags.map((t) =>
            h("span", { class: "td", style: { "--tc": t.color }, title: t.name }),
          ),
        )
      : null,
  );
}

// -------------------------------------------------------------------
// Main (selected feature)
// -------------------------------------------------------------------

function renderMain(featureDetail, onSourceFilter, railItem) {
  if (!featureDetail) {
    return h("main", { class: "main" },
      h("div", { class: "main-in" },
        h("section", { class: "placeholder" },
          h("h1", {}, "没有选中 feature"),
          h("p", { class: "hint" }, "在左边选一个,或者跑 /stele:feature 创建。"),
        ),
      ),
    );
  }

  const f = featureDetail.feature;
  const st = FT_STATE[f.state] ?? FT_STATE.going;
  const allSessions = featureDetail.sessions; // [{session, decisions}]

  // 0.4.0 — apply the ?src= filter. Filter decisions inside each session,
  // not the sessions themselves: a session that had a live capture AND a
  // post-hoc capture stays visible under either filter, just narrowed
  // to its matching decisions.
  const srcFilter = getSourceFilter();
  const sessions = srcFilter
    ? allSessions.map((b) => ({
        ...b,
        decisions: b.decisions.filter((d) => {
          // 'manual' filter matches both explicit 'manual' and undefined
          // (legacy rows had no source field at all).
          if (srcFilter === "manual") {
            return !d.source || d.source === "manual";
          }
          return d.source === srcFilter;
        }),
      }))
    : allSessions;

  const decCount = sessions.reduce((n, s) => n + s.decisions.length, 0);
  const totalDecCount = allSessions.reduce((n, s) => n + s.decisions.length, 0);

  // Latest session for resume strip — always from the unfiltered list so
  // the resume strip is stable as the filter toggles.
  const latest = allSessions[allSessions.length - 1] ?? null;

  // Sessions ordered desc (newest first) for the timeline
  const orderedSessions = [...sessions].reverse();

  return h("main", { class: "main" },
    h("div", { class: "main-in", "data-fid": f.id },

      // Feature header
      h("div", { class: "ms-head" },
        h("div", { class: "ms-titlerow" },
          h("h1", { class: "ms-title" }, f.name),
          h("span", { class: `fe-state-pill ${f.state}` },
            h("span", { class: "dot" }),
            st.label,
          ),
        ),
        f.about
          ? h("p", { class: "ms-about" }, f.about)
          : null,
        f.summary
          ? h("p", { class: "ms-summary" },
              h("span", { class: "lead" }, "rolling summary"),
              f.summary)
          : null,
        railItem?.tags?.length
          ? h("div", { class: "ms-tags" },
              ...railItem.tags.map((t) =>
                h("span", { class: "ms-tag", style: { "--tc": t.color ?? "#9c9a92" } },
                  h("span", { class: "td" }),
                  t.name)))
          : null,
        h("div", { class: "ms-stats" },
          h("span", { class: "ms-stat" },
            h("b", {}, String(allSessions.length)),
            " 次对话累积"),
          h("span", { class: "ms-stat" },
            h("b", {}, srcFilter ? `${decCount} / ${totalDecCount}` : String(decCount)),
            " 个决定"),
          latest?.session?.startedAt
            ? h("span", { class: "ms-stat" },
                `最近 ${fmtAgo(latest.session.startedAt)}`)
            : null,
        ),
      ),

      // 0.4.0 — source filter strip. Hidden when no filter is active.
      renderSourceFilterStrip(srcFilter, onSourceFilter),

      // Resume strip
      latest ? renderResumeStrip(latest, allSessions.length) : null,

      // Timeline
      h("div", { class: "tl-head" },
        h("span", { class: "eyebrow" }, "对话时间线"),
        h("span", { class: "tl-hint" },
          `· 这个 feature 由 ${sessions.length} 次对话累积而成`),
      ),
      h("p", { class: "tl-sub" },
        "每一次对话推进一点,沉淀出下面的决定。点决定可进溯源图看它的来历。"),
      sessions.length === 0
        ? h("div", { class: "placeholder" },
            h("p", { class: "hint" }, "还没有 session — 在这个 feature 下跑 /stele:feature 开始。"))
        : h("div", { class: "tl" },
            ...orderedSessions.map((s, idx) =>
              renderSessionCard(s, sessions.length - idx, s === latest),
            ),
          ),
    ),
  );
}

/**
 * 0.4.0 — source filter strip. Only visible when ?src= is active. Click
 * "清除筛选" to drop the filter and re-render.
 */
function renderSourceFilterStrip(srcFilter, onSourceFilter) {
  if (!srcFilter) return null;
  const labelMap = {
    "agent-live": "agent · live",
    "session-extract": "agent · post-hoc",
    "manual": "manual",
  };
  const label = labelMap[srcFilter] ?? srcFilter;
  return h("div", { class: "src-filter-strip" },
    h("span", { class: "src-filter-lbl" }, "正在按来源筛选: "),
    h("span", { class: `src-filter-pill src-${srcFilter}` }, label),
    h("button", {
        class: "src-filter-clear",
        type: "button",
        onClick: () => onSourceFilter(null),
      }, "清除筛选 ✕"),
  );
}

function renderResumeStrip(latestBucket, totalSessions) {
  const s = latestBucket.session;
  const summary = s.outcome?.summary ?? s.summary ?? "—";
  const when = fmtWhenShort(s.startedAt);
  const ago = fmtAgo(s.startedAt);

  return h("div", { class: "resume" },
    h("div", { class: "resume-rail" }),
    h("div", { class: "resume-body" },
      h("div", { class: "resume-top" },
        h("span", { class: "eyebrow is-seal" }, "继续上次的对话"),
        h("span", { class: "resume-when" },
          `第 ${totalSessions} 次 · ${when} · ${ago}`),
      ),
      h("div", { class: "resume-sum" },
        h("span", { class: "lead" }, "上次聊到"),
        summary),
      h("div", { class: "resume-foot" },
        s.id ? renderResumeLauncher({ sessionId: s.id }) : null,
        h("span", { class: "resume-ccid" },
          s.sourceSessionId
            ? `cc · ${s.sourceSessionId.slice(0, 8)}…`
            : "no source session id"),
      ),
    ),
  );
}

function renderSessionCard(bucket, sessionNum, isLatest) {
  const s = bucket.session;
  const oc = s.outcome ? (OUTCOME[s.outcome.type] ?? OUTCOME.touched) : OUTCOME.touched;
  const dur = fmtDuration(s.startedAt, s.endedAt);
  const summary = s.outcome?.summary ?? s.summary ?? "—";

  return h("div", {
      class: `tl-row${isLatest ? " latest" : ""}`,
      style: { "--oc": `var(${oc.cssVar})` },
    },
    h("div", { class: "tl-gut" },
      h("div", { class: "tl-date" }, fmtMD(s.startedAt)),
      h("div", { class: "tl-time" }, fmtHM(s.startedAt)),
      (() => {
        const octype = s.outcome?.type ?? "touched";
        return h("div", { class: `tl-dot ${octype}` },
          glyph(octype === "resolved" ? "check" : "spark", octype === "resolved" ? 10 : 9));
      })(),
      h("div", { class: "tl-line" }),
    ),
    h("div", { class: "tl-card" },
      h("div", { class: "tl-ctop" },
        h("span", { class: "tl-n" }, `第 ${sessionNum} 次`),
        h("span", { class: "tl-oc" },
          h("span", { class: "d" }),
          oc.label,
        ),
        h("span", { class: "tl-dur" },
          fmtHM(s.startedAt),
          dur ? ` · ${dur}` : "",
        ),
        isLatest ? h("span", { class: "tl-latest-badge" }, "最近") : null,
      ),
      h("div", { class: "tl-sum" }, summary),
      bucket.decisions.length > 0
        ? renderDecisionsSection(bucket.decisions)
        : null,
      h("div", { class: "tl-foot" },
        h("span", { class: "tl-ccid" },
          s.sourceSessionId
            ? `cc · ${s.sourceSessionId.slice(0, 8)}…`
            : "—"),
      ),
    ),
  );
}

function renderDecisionsSection(decisions) {
  return h("div", { class: "tl-dec" },
    h("div", { class: "tl-dec-lbl" }, `这次对话产出的决定 · ${decisions.length}`),
    h("div", { class: "tl-dec-list" },
      ...decisions.map(renderDecisionChip),
    ),
  );
}

function renderDecisionChip(d) {
  const ns = NODE_STATE_CHIP[nodeStateOf(d)] ?? NODE_STATE_CHIP.decision;
  const title = d.detail?.title ?? d.title ?? d.id;
  // Decision id is "<featureId>/<localId>"; Trace route is /<slug>/d/<f>/<id>
  const parts = d.id.split("/");
  const fid = parts[0];
  const localId = parts.slice(1).join("/");
  const href = slugUrl(`/d/${encodeURIComponent(fid)}/${encodeURIComponent(localId)}`);

  // 0.4.0 — source pill. Only render when source is one of the machine
  // values; 'manual' (or absent) → no pill, the absence IS the marker.
  const sm = d.source ? SOURCE_META[d.source] : null;
  const conf = (d.confidence != null && Number.isFinite(d.confidence))
    ? ` · ${d.confidence.toFixed(2)}`
    : "";

  return h("a", {
      class: `dchip${sm ? ` src-${sm.cls}` : ""}`,
      href,
      "data-route": "",
      onClick: (e) => e.stopPropagation(),
    },
    h("span", { class: `dchip-g ${ns.cls}` }, localId || d.id),
    h("span", { class: "dchip-t" }, title),
    d.tags?.[0]
      ? h("span", { class: "dchip-tag", style: { "--tc": d.tags[0].color ?? "#9c9a92" } },
          h("span", { class: "td" }),
          d.tags[0].name)
      : null,
    sm ? h("span", { class: `dchip-src ${sm.cls}`, title: `源: ${sm.label}${conf ? `, 置信度${conf}` : ""}` },
      sm.label + conf) : null,
    h("span", { class: `dchip-st ${ns.cls}` }, ns.label),
  );
}

// -------------------------------------------------------------------
// Page render
// -------------------------------------------------------------------

export async function render(root, ctx) {
  ensureCss("/assets/styles/pages/project.css");
  root.innerHTML = `<div class="loading">loading project…</div>`;
  // Reset the module-level rail filter on each (re)entry — the page module is
  // cached and cross-project nav is pushState + re-render (no reload), so a
  // stale activeTagFilter would otherwise carry project A's tags into B and
  // blank/mis-filter B's rail.
  activeTagFilter = [];
  railShowMore = false;
  detailCache.clear();

  let rail, projectInfo;
  try {
    [rail, projectInfo] = await Promise.all([
      apiGet("/features"),
      apiGet("/project").catch(() => null),
    ]);
  } catch (err) {
    root.innerHTML = `<div class="loading">failed to load project · ${escapeHtml(err.message ?? err)}</div>`;
    return;
  }

  if (!Array.isArray(rail) || rail.length === 0) {
    renderEmpty(root, ctx, projectInfo);
    return;
  }

  // Pick selection from URL or default
  let selected = getSelectedFeatureId();
  if (!selected || !findFeatureInRail(rail, selected)) {
    selected = pickDefaultFeature(rail);
    if (selected) setSelectedFeatureId(selected);
  }

  await renderShell(root, ctx, projectInfo, rail, selected);
}

// Feature detail cached per feature for the current page visit (cleared in
// render()) so pure rail-filter / source-filter re-renders don't blank the
// page and round-trip the API. renderGen guards against a slow fetch from a
// superseded render winning a race.
let detailCache = new Map();
let renderGen = 0;

async function renderShell(root, ctx, projectInfo, rail, selectedFid) {
  const gen = ++renderGen;

  let detail = selectedFid ? (detailCache.get(selectedFid) ?? null) : null;
  if (selectedFid && !detail) {
    try {
      detail = await apiGet(`/features/${encodeURIComponent(selectedFid)}`);
      detailCache.set(selectedFid, detail);
    } catch (err) {
      // Treat as no selection; rail still renders
      console.error(`[stele] feature fetch failed:`, err);
    }
    if (gen !== renderGen) return; // a newer render superseded this one
  }

  const onSelect = (fid) => {
    if (fid === selectedFid) return;
    setSelectedFeatureId(fid);
    renderShell(root, ctx, projectInfo, rail, fid);
  };

  // 0.4.0 — onSourceFilter clears or updates the ?src= query param and
  // re-renders. URL state is the source of truth; renderMain reads
  // getSourceFilter() on each render.
  const onSourceFilter = (v) => {
    setSourceFilter(v);
    renderShell(root, ctx, projectInfo, rail, selectedFid);
  };

  // Rail tag-filter handlers. onToggleTag(null) is a bare re-render (used by
  // the "更多/收起" expander); a name toggles that tag in the OR set.
  const onToggleTag = (name) => {
    if (name != null) {
      const i = activeTagFilter.indexOf(name);
      if (i >= 0) activeTagFilter.splice(i, 1);
      else activeTagFilter.push(name);
    }
    renderShell(root, ctx, projectInfo, rail, selectedFid);
  };
  const onClearTags = () => {
    activeTagFilter = [];
    renderShell(root, ctx, projectInfo, rail, selectedFid);
  };

  // Build then swap atomically — no blank-during-await, no double-append race.
  const frag = document.createDocumentFragment();
  const project = projectInfo?.project;
  if (project) frag.append(renderProjectSubhead(project));
  frag.append(
    h("div", { class: "body" },
      renderRail(rail, selectedFid, onSelect, onToggleTag, onClearTags),
      renderMain(detail, onSourceFilter, findFeatureInRail(rail, selectedFid)),
    ),
  );
  root.replaceChildren(frag);
}

function renderProjectSubhead(project) {
  const meta = STATUS_META[project.status] ?? STATUS_META.active;
  return h("div", { class: "proj-sub" },
    h("div", { class: "proj-sub-l" },
      h("span", { class: "proj-name" },
        project.name,
        project.code ? h("i", {}, project.code) : null,
      ),
    ),
    h("div", { class: "proj-sub-r" },
      h("span", { class: "proj-path" }, project.path),
      h("span", { class: `proj-status ${meta.cls}` },
        h("span", { class: "dot" }),
        meta.label,
      ),
    ),
  );
}

function renderEmpty(root, ctx, projectInfo) {
  root.innerHTML = "";
  if (projectInfo?.project) {
    root.append(renderProjectSubhead(projectInfo.project));
  }
  root.append(h("section", { class: "placeholder" },
    h("div", { class: "eyebrow" }, "No features yet"),
    h("h1", {}, "这个项目还没有 feature"),
    h("p", { class: "hint" },
      "在项目根目录跑 ",
      h("code", {}, "stele init"),
      " 装好钩子,然后用 ",
      h("code", {}, "/stele:feature"),
      " 起草第一个决策 — feature 会自动出现。"),
  ));
}
