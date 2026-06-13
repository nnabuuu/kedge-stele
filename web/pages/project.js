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

import { apiGet, apiPost, ensureCss, slugUrl } from "../api.js";
import { renderResumeLauncher } from "../components/resume-launcher.js";
import { h, escapeHtml, richText } from "../dom.js";
import { mapDetail, renderDecisionDetail } from "../decision-detail.js";
import { icon } from "../icons.js";
import { t, getLocale } from "../i18n.js";

// -------------------------------------------------------------------
// Static enums (cls stays static; labels come from t() at render time
// so the locale toggle re-renders pick up new strings)
// -------------------------------------------------------------------

const STATUS_KEYS = ["active", "winding", "dormant", "archived"];
function statusCls(s) { return STATUS_KEYS.includes(s) ? s : "active"; }
function statusLabel(s) { return t(`ui.projects.status.${statusCls(s)}`); }

const FT_STATE_KEYS = ["draft", "going", "winding", "done", "paused"];
function ftStateCls(s) { return FT_STATE_KEYS.includes(s) ? s : "going"; }
function ftStateLabel(s) { return t(`ui.projects.ft.${ftStateCls(s)}`); }

// A feature whose decisions are all settled (≥1 decision, zero open/deferred
// loops) reads as completed — derive the DISPLAYED state as "done" while the
// stored state stays going/winding (the user keeps manual control via the
// dashboard). Pure display; nothing is mutated. Needs the openLoops /
// decisionCount the featuresList projection already provides per feature.
function displayFtState(f) {
  if ((f.state === "going" || f.state === "winding") &&
      (f.decisionCount ?? 0) > 0 && (f.openLoops ?? 0) === 0) {
    return "done";
  }
  return f.state;
}

const OUTCOME_VAR = {
  advanced: "--teal",
  resolved: "--green",
  touched:  "--warm",
};
function outcomeMeta(type) {
  const key = OUTCOME_VAR[type] ? type : "touched";
  return { cssVar: OUTCOME_VAR[key], label: t(`ui.projects.outcome.${key}`) };
}

// The decision card's status label reads from derived nodeState, not raw
// type — a resolved deferred (the central provenance act) must read 已解决/
// green, not 推迟/amber. (The .fdec-st CSS class comes from effMockType.)
const NODE_STATE_KEYS = ["decision", "deferred", "open", "resolved", "superseded"];
function nodeStateCls(ns) { return NODE_STATE_KEYS.includes(ns) ? ns : "decision"; }
function nodeStateLabel(ns) { return t(`ui.project.node_state.${nodeStateCls(ns)}`); }
function nodeStateOf(d) {
  if (d.supersededBy) return "superseded";
  if (d.status === "resolved") return "resolved";
  return d.type; // "decision" | "deferred" | "open"
}

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
  if (d < 7) return t("ui.projects.date.days_ago", { count: d });
  if (d < 14) return t("ui.projects.date.last_week");
  if (d < 30) return t("ui.projects.date.weeks_ago", { count: Math.round(d / 7) });
  return t("ui.projects.date.months_ago", { count: Math.round(d / 30) });
}

function fmtMD(iso) {
  if (!iso) return t("ui.projects.date.unknown");
  const dt = new Date(iso);
  if (Number.isNaN(+dt)) return t("ui.projects.date.unknown");
  return `${dt.getMonth() + 1}/${String(dt.getDate()).padStart(2, "0")}`;
}

function fmtHM(iso) {
  if (!iso) return t("ui.projects.date.unknown");
  const dt = new Date(iso);
  if (Number.isNaN(+dt)) return t("ui.projects.date.unknown");
  return `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
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

// Timeline-node glyphs (check / spark) come from the shared icon() in
// ../icons.js (imported above).

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
  for (const f of rail) for (const tag of f.tags ?? []) if (!m.has(tag.name)) m.set(tag.name, tag);
  return [...m.values()];
}

function renderRail(rail, selectedFid, onSelect, onToggleTag, onClearTags) {
  const allTags = railTags(rail);
  const active = activeTagFilter;
  const filtered = active.length === 0
    ? rail
    : rail.filter((f) => (f.tags ?? []).some((tag) => active.includes(tag.name)));

  return h("aside", { class: "rail" },
    h("div", { class: "rail-h" },
      h("h2", {}, t("ui.project.rail.heading")),
      h("div", { class: "rail-h-r" },
        h("span", {}, t("ui.project.rail.count", { count: filtered.length })),
      ),
    ),
    allTags.length > 0 ? renderRtools(allTags, active, onToggleTag, onClearTags) : null,
    ...filtered.map((f) =>
      renderFeatureRow(f, selectedFid === f.id, onSelect),
    ),
    filtered.length === 0
      ? h("div", { class: "filt-empty" },
          active.length ? t("ui.project.rail.empty_filtered") : t("ui.project.rail.empty_unfiltered"))
      : null,
  );
}

function renderRtools(allTags, active, onToggleTag, onClearTags) {
  const DEFAULT_N = 3;
  const shown = allTags.slice(0, DEFAULT_N);
  const extra = allTags.slice(DEFAULT_N);
  return h("div", { class: "rtools" },
    h("div", { class: "rtools-row" },
      h("span", { class: "rtools-lbl" }, t("ui.project.rail.tag_filter_label")),
      active.length
        ? h("button", { class: "rtools-clear", type: "button", onClick: onClearTags }, t("ui.project.rail.tag_filter_clear"))
        : null,
    ),
    h("div", { class: "rtools-chips" },
      ...shown.map((tag) => renderTagChip(tag, active.includes(tag.name), onToggleTag)),
      extra.length
        ? h("button", {
            class: "tagmore",
            type: "button",
            onClick: () => { railShowMore = !railShowMore; onToggleTag(null); },
          }, railShowMore ? t("ui.project.rail.tag_collapse") : t("ui.project.rail.tag_more", { count: extra.length }))
        : null,
    ),
    railShowMore && extra.length
      ? h("div", { class: "rtools-chips rtools-extra" },
          ...extra.map((tag) => renderTagChip(tag, active.includes(tag.name), onToggleTag)))
      : null,
  );
}

function renderTagChip(tag, on, onToggleTag) {
  return h("button", {
      class: `tagchip tog${on ? " on" : ""}`,
      type: "button",
      style: { "--tc": tag.color ?? "#9c9a92" },
      onClick: () => onToggleTag(tag.name),
    },
    h("span", { class: "td" }),
    tag.name);
}

function renderFeatureRow(f, isSelected, onSelect) {
  const ds = displayFtState(f);
  return h("button", {
      class: `mrow ${ds}${isSelected ? " on" : ""}`,
      type: "button",
      onClick: () => onSelect(f.id),
    },
    h("div", { class: "mrow-top" },
      h("span", { class: "mrow-dot" }),
      h("span", { class: "mrow-name" }, f.name),
    ),
    h("div", { class: "mrow-meta" },
      h("span", { class: "mrow-ses" },
        icon("msg", 11),
        t("ui.project.rail.feature_sessions", { count: f.sessionCount })),
      f.lastActivity
        ? h("span", {}, t("ui.project.rail.feature_last_activity", { when: fmtAgo(f.lastActivity) }))
        : null,
      h("span", { class: "mrow-state" }, ftStateLabel(ds)),
    ),
    (f.tags ?? []).length > 0
      ? h("div", { class: "mrow-tags" },
          ...(f.tags ?? []).map((tag) =>
            h("span", { class: "td", style: { "--tc": tag.color }, title: tag.name }),
          ),
        )
      : null,
  );
}

// -------------------------------------------------------------------
// Main (selected feature)
// -------------------------------------------------------------------

function renderMain(featureDetail, onSourceFilter, railItem, onComplete, onReopen) {
  if (!featureDetail) {
    return h("main", { class: "main" },
      h("div", { class: "main-in" },
        h("section", { class: "placeholder" },
          h("h1", {}, t("ui.project.main.no_selection_heading")),
          h("p", { class: "hint" }, t("ui.project.main.no_selection_hint")),
        ),
      ),
    );
  }

  const f = featureDetail.feature;
  const allSessions = featureDetail.sessions; // [{session, decisions}] oldest→newest

  // 0.4.0 — apply the ?src= filter inside each session (not on the sessions
  // themselves): a session that had a live AND a post-hoc capture stays
  // visible under either filter, narrowed to its matching decisions.
  const srcFilter = getSourceFilter();
  const sessions = srcFilter
    ? allSessions.map((b) => ({
        ...b,
        decisions: b.decisions.filter((d) =>
          srcFilter === "manual"
            ? !d.source || d.source === "manual"
            : d.source === srcFilter),
      }))
    : allSessions;

  const decCount = sessions.reduce((n, s) => n + s.decisions.length, 0);
  const totalDecCount = allSessions.reduce((n, s) => n + s.decisions.length, 0);
  const latest = allSessions[allSessions.length - 1] ?? null;
  const lastIdx = sessions.length - 1;
  // Derived "done" display when all loops are settled — uses the rail item's
  // openLoops/decisionCount (the full-feature counts, unaffected by ?src=).
  const headState = railItem ? displayFtState(railItem) : f.state;

  // Mark-complete data (full feature, unaffected by ?src=): the open loops a
  // seal would hand-close, and how many were already closed manually.
  const allDecisions = allSessions.flatMap((b) => b.decisions);
  const openLoopDecisions = allDecisions.filter((d) => {
    const ns = nodeStateOf(d);
    return ns === "open" || ns === "deferred";
  });
  const closedCount = allDecisions.filter((d) => d.closedManually).length;

  return h("main", { class: "main" },
    h("div", { class: "main-in", "data-fid": f.id },

      // Feature header
      h("div", { class: "ms-head" },
        h("div", { class: "ms-titlerow" },
          h("h1", { class: "ms-title" }, f.name),
          h("span", { class: `ms-state-pill ${ftStateCls(headState)}` },
            h("span", { class: "dot" }),
            ftStateLabel(headState),
          ),
        ),
        f.about ? h("p", { class: "ms-about" }, richText(f.about)) : null,
        f.summary
          ? h("p", { class: "ms-summary" },
              h("span", { class: "lead" }, t("ui.project.main.rolling_summary_lead")),
              richText(f.summary))
          : null,
        railItem?.tags?.length
          ? h("div", { class: "ms-tags" },
              ...railItem.tags.map((tag) =>
                h("span", { class: "ms-tag tagchip", style: { "--tc": tag.color ?? "#9c9a92" } },
                  h("span", { class: "td" }),
                  tag.name)))
          : null,
        h("div", { class: "ms-stats" },
          h("span", { class: "ms-stat" }, icon("msg", 14),
            h("b", {}, String(allSessions.length)),
            " ", t("ui.project.main.stat_sessions")),
          h("span", { class: "ms-stat" }, icon("layers", 14),
            h("b", {}, srcFilter ? `${decCount} / ${totalDecCount}` : String(decCount)),
            " ", t("ui.project.main.stat_decisions")),
          latest?.session?.startedAt
            ? h("span", { class: "ms-stat" }, icon("bell", 14),
                t("ui.project.main.stat_last", { when: fmtAgo(latest.session.startedAt) }))
            : null,
        ),
        renderMsComplete(f, openLoopDecisions, closedCount, onComplete, onReopen),
      ),

      // 0.4.0 — source filter strip. Hidden when no filter is active.
      renderSourceFilterStrip(srcFilter, onSourceFilter),

      // Conversation ledger — oldest→newest; each session's head + core pin
      // to the top while its decisions scroll (pure CSS sticky).
      sessions.length === 0
        ? h("div", { class: "placeholder" },
            h("p", { class: "hint" }, t("ui.project.timeline.empty")))
        : h("div", { class: "ledger" },
            ...sessions.flatMap((s, idx) => {
              const block = renderSessionBlock(s, idx + 1, idx === lastIdx);
              return idx > 0
                ? [h("div", { class: "sess-div" }, h("span", { class: "dot" })), block]
                : [block];
            })),
    ),
  );
}

// ── 封碑 / mark complete (design §ms-complete) ───────────────────
// Driven by the STORED state: a sealed feature (state==='done') shows the
// "线索已完成" note + an undo; an active one (going/winding/paused) shows the
// seal button. Hidden for drafts.
function renderMsComplete(f, openLoopDecisions, closedCount, onComplete, onReopen) {
  if (f.state === "draft") return null;
  if (f.state === "done") {
    return h("div", { class: "ms-complete done" },
      h("span", { class: "msc-note" },
        icon("check", 14),
        t("ui.project.complete.done_note"),
        closedCount > 0 ? t("ui.project.complete.done_closed_suffix", { count: closedCount }) : ""),
      h("button", { class: "msc-undo", type: "button", onClick: () => onReopen(f.id) },
        t("ui.project.complete.undo")),
    );
  }
  return h("div", { class: "ms-complete" },
    h("button", { class: "msc-btn", type: "button",
        onClick: () => openCompleteModal(f, openLoopDecisions, onComplete) },
      icon("check", 14), t("ui.project.complete.button")),
    openLoopDecisions.length > 0
      ? h("span", { class: "msc-hint" }, t("ui.project.complete.hint", { count: openLoopDecisions.length }))
      : null,
  );
}

// The confirmation sheet: lists the open loops that will be hand-closed, then
// commits on confirm. Mounted on <body>; ESC / backdrop / cancel dismiss it.
function openCompleteModal(f, openLoopDecisions, onComplete) {
  // Singleton: a rapid double-click would otherwise mount a second sheet +
  // a second document keydown listener (backdrop-click then closes only one).
  if (document.querySelector(".msc-modal")) return;
  const modal = h("div", { class: "msc-modal" });
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const close = () => { modal.remove(); document.removeEventListener("keydown", onKey); };

  const list = openLoopDecisions.length > 0
    ? h("ul", { class: "msc-list" },
        ...openLoopDecisions.map((d) => {
          const ns = nodeStateOf(d);
          const localId = d.id.split("/").slice(1).join("/") || d.id;
          return h("li", {},
            h("span", { class: `dchip-g ${ns}` }, localId),
            h("span", { class: "lt" }, d.detail?.title ?? d.title ?? d.id),
            h("span", { class: `dchip-st ${ns}` }, nodeStateLabel(ns)),
          );
        }))
    : null;

  const sheet = h("div", { class: "msc-sheet", role: "dialog", "aria-modal": "true" },
    h("div", { class: "msc-eb" }, t("ui.project.complete.modal_eyebrow")),
    h("h3", { class: "msc-title" }, t("ui.project.complete.modal_title", { name: f.name })),
    h("p", { class: "msc-lede" }, richText(t("ui.project.complete.modal_lede", { count: openLoopDecisions.length }))),
    list,
    h("div", { class: "msc-act" },
      h("button", { class: "msc-cancel", type: "button", onClick: close }, t("ui.project.complete.modal_cancel")),
      h("button", { class: "msc-confirm", type: "button",
          onClick: () => { close(); onComplete(f.id); } },
        icon("check", 14), t("ui.project.complete.modal_confirm")),
    ),
  );
  sheet.addEventListener("click", (e) => e.stopPropagation());
  modal.addEventListener("click", close); // backdrop click
  modal.append(h("div", { class: "msc-back" }), sheet);
  document.addEventListener("keydown", onKey);
  document.body.append(modal);
}

/**
 * 0.4.0 — source filter strip. Only visible when ?src= is active.
 */
function renderSourceFilterStrip(srcFilter, onSourceFilter) {
  if (!srcFilter) return null;
  const SOURCE_LABEL_KEY = {
    "agent-live": "ui.project.source.agent_live",
    "session-extract": "ui.project.source.session_extract",
    "manual": "ui.project.source.manual",
  };
  const labelKey = SOURCE_LABEL_KEY[srcFilter];
  const label = labelKey ? t(labelKey) : srcFilter;
  return h("div", { class: "src-filter-strip" },
    h("span", { class: "src-filter-lbl" }, t("ui.project.source_filter.label")),
    h("span", { class: `src-filter-pill src-${srcFilter}` }, label),
    h("button", {
        class: "src-filter-clear",
        type: "button",
        onClick: () => onSourceFilter(null),
      }, t("ui.project.source_filter.clear")),
  );
}

// ── SessionBlock + 3-bucket grouping (spec §6.5) ─────────────────
// Each session: a sticky head + core anchor, then its decisions split into
// three buckets (Decisions / Deferred / Open questions). Empty buckets skip.
const SESS_BUCKETS = [
  { key: "dec", bc: "var(--teal)",   en: "Decisions",      labelKey: "ui.project.bucket.dec" },
  { key: "def", bc: "var(--amber)",  en: "Deferred",       labelKey: "ui.project.bucket.def" },
  { key: "oq",  bc: "var(--purple)", en: "Open questions", labelKey: "ui.project.bucket.oq" },
];

// Map the backend Decision shape onto the mock's effective type. The mock
// uses "decided" (not "decision") and treats a resolved deferred/open as its
// own "resolved" type (which buckets with Decisions and renders dimmed).
function effMockType(d) {
  if (d.supersededBy) return "superseded"; // class must match the label (nodeStateOf)
  if (d.status === "resolved") return "resolved";
  if (d.type === "decision") return "decided";
  return d.type; // deferred | open
}
function bucketKeyOf(d) {
  const e = effMockType(d);
  if (e === "deferred") return "def";
  if (e === "open") return "oq";
  return "dec"; // decided | resolved
}
// Overridden cards (resolved or superseded) collapse to a dimmed one-liner.
function isOverridden(d) {
  return effMockType(d) === "resolved" || !!d.supersededBy;
}

const SCOPE_CLASSES = ["runtime", "backend", "design", "security"];
function scopeClassOf(scope) {
  if (!scope) return "";
  const s = String(scope).toLowerCase();
  return SCOPE_CLASSES.find((c) => s.includes(c)) ?? "";
}

function traceHref(d) {
  const parts = d.id.split("/");
  return slugUrl(`/d/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts.slice(1).join("/"))}`);
}
function renderTraceLink(d, short) {
  return h("a", { class: "dchip-trace", href: traceHref(d), "data-route": "" },
    icon("branch", 12),
    short ? t("ui.project.dd.trace_link_short") : t("ui.project.dd.trace_link"),
    icon("ext", 12));
}

function renderSessionBlock(bucket, n, isLatest) {
  const s = bucket.session;
  const oc = outcomeMeta(s.outcome?.type);
  const dur = fmtDuration(s.startedAt, s.endedAt);
  const core = s.outcome?.summary ?? s.summary ?? "";

  return h("section", {
      class: `sess${isLatest ? " latest" : ""}`,
      style: { "--oc": `var(${oc.cssVar})` },
    },
    h("div", { class: "sess-stick" },
      h("div", { class: "sess-head" },
        h("span", { class: "sess-n" }, t("ui.project.session.block_label", { n })),
        isLatest ? h("span", { class: "sess-latest-tag" }, t("ui.project.session.latest_tag")) : null,
        h("span", { class: "sess-date" }, fmtMD(s.startedAt)),
        h("span", { class: "sess-oc" }, h("span", { class: "d" }), oc.label),
        h("span", { class: "sess-time" }, fmtHM(s.startedAt), dur ? ` · ${dur}` : ""),
        bucket.decisions.length
          ? h("span", { class: "sess-deccount" },
              t("ui.project.session.dec_count", { n: bucket.decisions.length }, bucket.decisions.length))
          : null,
        h("span", { class: "sess-head-r" },
          s.id ? renderResumeLauncher({ sessionId: s.id }) : null),
      ),
      h("div", { class: "sess-core" },
        h("div", { class: "sess-core-lbl" },
          icon("spark", 11),
          isLatest ? t("ui.project.session.core_latest") : t("ui.project.session.core_label")),
        h("p", { class: "sess-core-t" },
          core ? richText(core) : t("ui.projects.date.unknown")),
      ),
    ),
    renderSessGroups(bucket.decisions),
  );
}

function renderSessGroups(decisions) {
  const groups = SESS_BUCKETS
    .map((b) => ({ b, items: decisions.filter((d) => bucketKeyOf(d) === b.key) }))
    .filter((g) => g.items.length > 0);
  if (groups.length === 0) return null;
  // A single-bucket session needs no "决定/Decisions" header — the repeated
  // header was the "multiple Decisions sections" noise. The card's left-border
  // color still signals the type and the count lives on the session head. Show
  // headers only when a session actually mixes decision types.
  const showHeaders = groups.length > 1;
  const showEn = getLocale() !== "en"; // the Latin subtitle is a flourish; drop it on en
  return h("div", { class: "sess-groups" },
    ...groups.map(({ b, items }) =>
      h("div", { class: "grp", style: { "--bc": b.bc } },
        showHeaders
          ? h("div", { class: "grp-h" },
              h("span", { class: "grp-dot" }),
              h("span", { class: "grp-lbl" }, t(b.labelKey)),
              showEn ? h("span", { class: "grp-en" }, b.en) : null,
              h("span", { class: "grp-n" }, String(items.length)),
            )
          : null,
        h("div", { class: "grp-cards" },
          ...items.map((d) => renderFlatDecision(d, b.key)),
        ),
      )),
  );
}

function renderFlatDecision(d, groupKey) {
  const manualClosed = !!d.closedManually; // hand-closed when its feature was sealed
  const over = isOverridden(d); // already true for manualClosed (status==='resolved')
  const detail = mapDetail(d);
  const scope = d.scope ?? d.detail?.scope ?? null;
  const localId = d.id.split("/").slice(1).join("/") || d.id;
  const traceShort = renderTraceLink(d, true);

  let body;
  if (manualClosed) {
    body = [h("div", { class: "fdec-over-note closed" },
      richText(t("ui.project.dd.manually_closed")), traceShort)];
  } else if (over) {
    body = [h("div", { class: "fdec-over-note" }, t("ui.project.dd.overridden"), traceShort)];
  } else if (detail) {
    body = [renderDecisionDetail(detail), h("div", { class: "fdec-foot" }, traceShort)];
  } else {
    body = [h("div", { class: "fdec-over-note" }, t("ui.project.dd.unarchived"), traceShort)];
  }

  return h("div", {
      class: `fdec g-${groupKey}${over ? " over" : ""}`,
      style: { "--tc": d.tags?.[0]?.color ?? "var(--teal)" },
    },
    h("div", { class: "fdec-head" },
      h("span", { class: "fdec-num" }, localId),
      h("span", { class: "fdec-title" }, d.detail?.title ?? d.title ?? d.id),
      scope ? h("span", { class: `d-scope ${scopeClassOf(scope)}` }, scope) : null,
      manualClosed
        ? h("span", { class: "fdec-st closed" }, t("ui.project.node_state.closed"))
        : h("span", { class: `fdec-st ${effMockType(d)}` }, nodeStateLabel(nodeStateOf(d))),
    ),
    ...body,
  );
}

// -------------------------------------------------------------------
// Page render
// -------------------------------------------------------------------

export async function render(root, ctx) {
  ensureCss("/assets/styles/pages/project.css");
  root.innerHTML = `<div class="loading">${escapeHtml(t("ui.project.loading"))}</div>`;
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
    root.innerHTML = `<div class="loading">${escapeHtml(t("ui.project.load_failed", { reason: String(err.message ?? err) }))}</div>`;
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

  // After a 封碑/撤销 mutation the rail (openLoops + state) and the selected
  // feature's decisions are both stale — re-fetch the rail and drop the cached
  // detail so renderShell re-pulls it, then recurse into the same render path.
  // `gen` is the renderGen this handler belongs to; any newer renderShell
  // (navigation, tag/source filter) advances renderGen, so if the user moved
  // on during an await we bail instead of clobbering their current view with
  // this handler's stale selectedFid.
  const refresh = async (gen) => {
    let newRail = rail;
    try {
      newRail = await apiGet("/features");
    } catch (err) {
      console.error(`[stele] rail refresh failed:`, err);
    }
    if (gen !== renderGen) return; // user navigated during the fetch
    detailCache.delete(selectedFid);
    await renderShell(root, ctx, projectInfo, newRail, selectedFid);
  };
  const onComplete = async (fid) => {
    const gen = renderGen;
    try {
      await apiPost(`/features/${encodeURIComponent(fid)}/complete`, {});
    } catch (err) {
      console.error(`[stele] feature complete failed:`, err);
      return;
    }
    if (gen !== renderGen) return; // user navigated during the POST
    await refresh(gen);
  };
  const onReopen = async (fid) => {
    const gen = renderGen;
    try {
      await apiPost(`/features/${encodeURIComponent(fid)}/reopen`, {});
    } catch (err) {
      console.error(`[stele] feature reopen failed:`, err);
      return;
    }
    if (gen !== renderGen) return; // user navigated during the POST
    await refresh(gen);
  };

  // Build then swap atomically — no blank-during-await, no double-append race.
  const frag = document.createDocumentFragment();
  const project = projectInfo?.project;
  if (project) frag.append(renderProjectSubhead(project));
  frag.append(
    h("div", { class: "body" },
      renderRail(rail, selectedFid, onSelect, onToggleTag, onClearTags),
      renderMain(detail, onSourceFilter, findFeatureInRail(rail, selectedFid), onComplete, onReopen),
    ),
  );
  root.replaceChildren(frag);
}

function renderProjectSubhead(project) {
  const cls = statusCls(project.status);
  return h("div", { class: "proj-sub" },
    h("div", { class: "proj-sub-l" },
      h("span", { class: "proj-name" },
        project.name,
        project.code ? h("i", {}, project.code) : null,
      ),
    ),
    h("div", { class: "proj-sub-r" },
      h("span", { class: "proj-path" }, project.path),
      h("span", { class: `proj-status ${cls}` },
        h("span", { class: "dot" }),
        statusLabel(project.status),
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
    h("div", { class: "eyebrow" }, t("ui.project.empty.eyebrow")),
    h("h1", {}, t("ui.project.empty.heading")),
    h("p", { class: "hint" },
      t("ui.project.empty.hint_p1"),
      h("code", {}, "stele init"),
      t("ui.project.empty.hint_p2"),
      h("code", {}, "/stele:feature"),
      t("ui.project.empty.hint_p3")),
  ));
}
