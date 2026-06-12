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
import { h, escapeHtml, richText } from "../dom.js";
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
    }, tag.name);
}

function renderFeatureRow(f, isSelected, onSelect) {
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
      h("span", { class: "mrow-ses" }, t("ui.project.rail.feature_sessions", { count: f.sessionCount })),
      f.lastActivity
        ? h("span", {}, t("ui.project.rail.feature_last_activity", { when: fmtAgo(f.lastActivity) }))
        : null,
      h("span", { class: "mrow-state" }, ftStateLabel(f.state)),
    ),
    f.tags.length > 0
      ? h("div", { class: "mrow-tags" },
          ...f.tags.map((tag) =>
            h("span", { class: "td", style: { "--tc": tag.color }, title: tag.name }),
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

  return h("main", { class: "main" },
    h("div", { class: "main-in", "data-fid": f.id },

      // Feature header
      h("div", { class: "ms-head" },
        h("div", { class: "ms-titlerow" },
          h("h1", { class: "ms-title" }, f.name),
          h("span", { class: `ms-state-pill ${ftStateCls(f.state)}` },
            h("span", { class: "dot" }),
            ftStateLabel(f.state),
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

// Collapse detail.artifact (+ legacy top-level artifacts[]) into {files,commit}.
function artifactOf(d) {
  const files = [];
  const a = d.detail?.artifact;
  if (a?.file) files.push({ label: null, path: a.file });
  for (const art of d.artifacts ?? []) if (art?.file) files.push({ label: null, path: art.file });
  const commit = a?.commit ?? d.artifacts?.find((x) => x?.commit)?.commit ?? null;
  return { files, commit };
}

// Backend detail → the mock's DecisionDetail shape. Returns null when there's
// no body worth rendering (e.g. a bare deferred with empty detail).
const OPT_LETTERS = "ABCDEFGHIJKLMN";
function mapDetail(d) {
  const dt = d.detail;
  if (!dt) return null;
  // OPTION column is a short letter (the schema's `name` is often a long
  // phrase, which doesn't fit the 54px column). APPROACH carries the content:
  // the name (bold) + the one-line desc when present.
  const options = (dt.options ?? []).map((o, i) => {
    const name = o.name ?? "";
    const desc = o.desc ?? "";
    const ap = desc ? `<strong>${name}</strong> — ${desc}` : name;
    return {
      n: OPT_LETTERS[i] ?? String(i + 1),
      ap,
      vd: o.why ?? (o.verdict === "chosen" ? "✓" : "✗"),
      chosen: o.chosen ?? o.verdict === "chosen",
    };
  });
  const artifact = artifactOf(d);
  const out = {
    trigger: dt.trigger ?? null,
    constraint: dt.constraint ?? null,
    axis: dt.optionAxis ?? null,
    options: options.length ? options : null,
    why: dt.why?.length ? dt.why : null,
    locks: dt.locks && (dt.locks.in || dt.locks.out) ? dt.locks : null,
    artifact: artifact.files.length || artifact.commit ? artifact : null,
  };
  const hasBody = out.trigger || out.constraint || out.options || out.why || out.locks || out.artifact;
  return hasBody ? out : null;
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
  const showEn = getLocale() !== "en"; // the Latin subtitle is a flourish; drop it on en
  return h("div", { class: "sess-groups" },
    ...groups.map(({ b, items }) =>
      h("div", { class: "grp", style: { "--bc": b.bc } },
        h("div", { class: "grp-h" },
          h("span", { class: "grp-dot" }),
          h("span", { class: "grp-lbl" }, t(b.labelKey)),
          showEn ? h("span", { class: "grp-en" }, b.en) : null,
          h("span", { class: "grp-n" }, String(items.length)),
        ),
        h("div", { class: "grp-cards" },
          ...items.map((d) => renderFlatDecision(d, b.key)),
        ),
      )),
  );
}

function renderFlatDecision(d, groupKey) {
  const over = isOverridden(d);
  const detail = mapDetail(d);
  const scope = d.scope ?? d.detail?.scope ?? null;
  const localId = d.id.split("/").slice(1).join("/") || d.id;
  const traceShort = renderTraceLink(d, true);

  let body;
  if (over) {
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
      h("span", { class: `fdec-st ${effMockType(d)}` }, nodeStateLabel(nodeStateOf(d))),
    ),
    ...body,
  );
}

function renderDecisionDetail(detail) {
  const parts = [];

  if (detail.trigger || detail.constraint) {
    const frame = h("div", { class: "dd-frame" });
    if (detail.trigger) {
      frame.append(h("span", { class: "lbl" }, t("ui.project.dd.trigger")),
        h("span", { class: "val" }, richText(detail.trigger)));
    }
    if (detail.constraint) {
      frame.append(h("span", { class: "lbl" }, t("ui.project.dd.constraint")),
        h("span", { class: "val" }, richText(detail.constraint)));
    }
    parts.push(frame);
  }

  if (detail.options) {
    parts.push(h("div", {},
      detail.axis
        ? h("div", { class: "dd-axis" },
            t("ui.project.dd.axis", { axis: detail.axis, count: detail.options.length }))
        : null,
      h("div", { class: "dd-options" },
        h("div", { class: "dd-opt-h" },
          h("span", {}, "Option"), h("span", {}, "Approach"), h("span", {}, "Verdict")),
        ...detail.options.map((o) =>
          h("div", { class: `dd-opt${o.chosen ? " chosen" : ""}` },
            h("span", { class: "o-n" }, o.n),
            h("span", { class: "o-ap" }, richText(o.ap)),
            h("span", { class: "o-vd" }, o.vd),
          )),
      ),
    ));
  }

  if (detail.why) {
    parts.push(h("div", { class: "dd-why" },
      h("div", { class: "dd-why-l" }, t("ui.project.dd.why")),
      ...detail.why.map((w) => h("p", {}, richText(w))),
    ));
  }

  if (detail.locks) {
    parts.push(h("div", { class: "dd-locks" },
      h("div", { class: "dd-lock in" },
        h("div", { class: "k" }, t("ui.project.dd.lock_in")),
        detail.locks.in ? h("span", {}, richText(detail.locks.in)) : null),
      h("div", { class: "dd-lock out" },
        h("div", { class: "k" }, t("ui.project.dd.lock_out")),
        detail.locks.out ? h("span", {}, richText(detail.locks.out)) : null),
    ));
  }

  if (detail.artifact) {
    const art = h("div", { class: "dd-artifact" });
    for (const file of detail.artifact.files) {
      art.append(h("span", { class: "lbl" }, file.label || "file"), h("code", {}, file.path));
    }
    if (detail.artifact.commit) {
      art.append(h("span", { class: "lbl" }, "commit"), h("code", {}, detail.artifact.commit));
    }
    parts.push(art);
  }

  return h("div", { class: "dd" }, ...parts);
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
