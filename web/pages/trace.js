// Trace page — decision provenance at /<slug>/d/<mid>/<localId>.
//
// Matches design/Stele Trace.html: a decision picker, the focal decision card
// (id + state + scope pills, large serif title, gist, location link), the
// cross-session stitch band, then four editorial sections under .sec-h headers
// — Lifecycle (life arc) / Trade-offs (the ADR card) / Related (neighbor refs)
// / Affects. All injected content runs through richText() so authored
// <em>/<strong>/<mark> render styled.
//
// API:
//   GET /<slug>/api/decisions/<mid>/<localId>          trace
//   GET /<slug>/api/decisions/<mid>/<localId>/stitch    cross-session stitch
//   GET /<slug>/api/features/<mid>/decisions            siblings (picker)

import { apiGet, ensureCss, slugUrl } from "../api.js";
import { h, escapeHtml, richText } from "../dom.js";
import { mapDetail, renderDecisionDetail } from "../decision-detail.js";
import { icon } from "../icons.js";
import { t, getLocale } from "../i18n.js";

// -------------------------------------------------------------------
// Enums (cls / structural fields stay static; labels come from t())
// -------------------------------------------------------------------

const NODE_STATE_KEYS = ["decided", "deferred", "resolved", "superseded", "open", "conflicted"];
function nodeStateCls(s) { return NODE_STATE_KEYS.includes(s) ? s : "decided"; }
function nodeStateLabel(s) { return t(`ui.trace.node_state.${nodeStateCls(s)}`); }

const RELATION_KEYS_INFO = {
  resolves:    { isKey: true },
  resolvedBy:  { isKey: true },
  depends_on:  { isKey: false },
  depended_on: { isKey: false },
  relates:     { isKey: false },
  supersedes:  { isKey: false },
  supersededBy:{ isKey: false },
  reconciles:  { isKey: false },
};
function relMeta(key) {
  const info = RELATION_KEYS_INFO[key];
  if (!info) return { label: key, hint: "", isKey: false };
  return {
    label: t(`ui.trace.rel.${key}.label`),
    hint: t(`ui.trace.rel.${key}.hint`),
    isKey: info.isKey,
  };
}

// nb-lbl glyph per relation (Related section). resolves/resolvedBy live in the
// stitch band, not here.
const REL_ICON = {
  depends_on: "arrowDown",
  depended_on: "arrowUp",
  relates: "link",
  supersedes: "branch",
  supersededBy: "branch",
  reconciles: "link",
};
const RELATED_ORDER = ["depends_on", "depended_on", "relates", "supersedes", "supersededBy", "reconciles"];

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
  if (!iso) return "";
  const dt = new Date(iso);
  if (Number.isNaN(+dt)) return "";
  return `${dt.getMonth() + 1}/${String(dt.getDate()).padStart(2, "0")}`;
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function splitDecisionId(id) {
  const parts = id.split("/");
  if (parts.length < 2) return { mid: id, localId: "" };
  return { mid: parts[0], localId: parts.slice(1).join("/") };
}

function decisionTraceHref(id) {
  const { mid, localId } = splitDecisionId(id);
  return slugUrl(`/d/${encodeURIComponent(mid)}/${encodeURIComponent(localId)}`);
}

// statusLine looks like "DECIDED — 选了 …" — the leading token is the state.
function statusKeyOf(statusLine) {
  if (!statusLine) return "decided";
  const head = statusLine.split(/[\s—-]/)[0]?.toLowerCase() ?? "decided";
  return NODE_STATE_KEYS.includes(head) ? head : "decided";
}

// The focal gist: statusLine without its leading "STATE — " prefix (the
// state-pill already shows the state).
function focalNote(statusLine) {
  if (!statusLine) return "";
  // Strip only the LEADING "STATE — " prefix; keep the body verbatim (it's
  // free text that may itself contain a spaced hyphen).
  const m = statusLine.match(/^\S+\s+[—-]\s+([\s\S]+)$/);
  return m ? m[1] : statusLine;
}

// Group edges by an inferred relation key, splitting the symmetric relations
// by direction so the UI can show "this resolves X" vs "resolved by Y".
function groupEdges(edges) {
  const groups = new Map();
  for (const e of edges ?? []) {
    let key = e.relation;
    if (e.relation === "resolves") key = e.direction === "out" ? "resolves" : "resolvedBy";
    else if (e.relation === "supersedes") key = e.direction === "out" ? "supersedes" : "supersededBy";
    else if (e.relation === "depends_on") key = e.direction === "out" ? "depends_on" : "depended_on";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  return groups;
}

// Editorial section header (spec §7.6): icon + 20px title + uppercase Latin
// subtitle + bottom rule. The Latin subtitle is a flourish — drop it on en
// where it would duplicate the (now-English) title.
function renderSecH(iconName, title, en) {
  return h("div", { class: "sec-h" },
    icon(iconName, 15),
    h("span", { class: "sec-title" }, title),
    getLocale() !== "en" ? h("span", { class: "sec-en" }, en) : null,
  );
}

// -------------------------------------------------------------------
// Picker
// -------------------------------------------------------------------

const PICKER_TYPES = ["decision", "deferred", "open"];
function renderPicker(focalId, siblings) {
  if (!Array.isArray(siblings) || siblings.length === 0) return null;
  return h("div", { class: "picker" },
    h("span", { class: "picker-lbl" }, t("ui.trace.picker.label")),
    ...siblings.map((d) => {
      const ty = PICKER_TYPES.includes(d.type) ? d.type : "decision";
      const localId = splitDecisionId(d.id).localId || d.id;
      const title = d.title ?? d.id;
      const short = title.length > 12 ? title.slice(0, 12) + "…" : title;
      return h("a", {
          class: `pchip pchip-${ty}${d.id === focalId ? " on" : ""}`,
          href: decisionTraceHref(d.id),
          "data-route": "",
        },
        h("span", { class: "pchip-ty" }, t(`ui.trace.picker.ty.${ty}`)),
        h("code", {}, localId),
        short,
      );
    }),
  );
}

// -------------------------------------------------------------------
// Focal card
// -------------------------------------------------------------------

function renderFocalCard(trace) {
  const d = trace.decision;
  const { mid } = splitDecisionId(d.id);
  const stateKey = statusKeyOf(trace.statusLine);
  const title = d.detail?.title ?? d.title ?? d.id;
  const tagColor = trace.tags?.[0]?.color ?? null;
  const note = focalNote(trace.statusLine);

  return h("div", { class: "focal" },
    h("div", { class: "focal-top" },
      h("span", { class: "fid", style: tagColor ? { "--tc": tagColor } : null }, d.id),
      h("span", { class: `state-pill st-${nodeStateCls(stateKey)}` },
        h("span", { class: "dot" }),
        nodeStateLabel(stateKey)),
      ...(trace.tags ?? []).map((tag) =>
        h("span", { class: "scope-pill", style: { "--tc": tag.color ?? "#9c9a92" } }, tag.name)),
    ),
    h("h1", { class: "focal-title" }, title),
    note ? h("p", { class: "focal-note" }, richText(note)) : null,
    h("div", { class: "focal-where" },
      h("a", { class: "mlink", href: slugUrl(`/?f=${encodeURIComponent(mid)}`), "data-route": "" },
        icon("flag", 11),
        h("b", {}, trace.featureName ?? mid)),
    ),
  );
}

// -------------------------------------------------------------------
// Cross-session stitch band
// -------------------------------------------------------------------

function renderStitch(stitch) {
  if (!stitch || (!stitch.resolved && !stitch.resolver)) return null;
  // The projection gives the resolved↔resolver pair; focalIsResolved says which
  // side the focal decision is. Render the mock's flow: self chip —[relation]→
  // the other decision's card.
  const focalIsResolved = stitch.focalIsResolved;
  const self = focalIsResolved ? stitch.resolved : stitch.resolver;
  const target = focalIsResolved ? stitch.resolver : stitch.resolved;
  if (!self || !target) return null;
  const relLabel = t(focalIsResolved ? "ui.trace.stitch.rel_resolved_by" : "ui.trace.stitch.rel_resolves");
  const say = t(focalIsResolved ? "ui.trace.stitch.say_resolved_by" : "ui.trace.stitch.say_resolves");

  return h("section", { class: "stitch" },
    h("div", { class: "stitch-h" },
      icon("link", 12),
      t("ui.trace.stitch.eyebrow"),
      h("span", { class: "stitch-sub" }, t("ui.trace.stitch.sub")),
    ),
    h("div", { class: "stitch-block" },
      h("p", { class: "stitch-say" }, richText(say)),
      h("div", { class: "stitch-flow" },
        h("span", { class: "stitch-self" }, t("ui.trace.stitch.self", { id: splitDecisionId(self.id).localId })),
        h("span", { class: "stitch-rel" }, h("span", { class: "stitch-rel-l" }, relLabel)),
        h("div", { class: "stitch-cards" }, renderStitchCard(target)),
      ),
    ),
    stitch.edgeNote
      ? h("p", { class: "stitch-say stitch-edge-note" }, h("b", {}, t("ui.trace.stitch.note_prefix")), " ", richText(stitch.edgeNote))
      : null,
  );
}

function renderStitchCard(ref) {
  return h("a", { class: "stitch-card", href: decisionTraceHref(ref.id), "data-route": "" },
    h("span", { class: `dref-g ${gClsOf(ref.type)}` }, splitDecisionId(ref.id).localId),
    h("span", { class: "stitch-card-t" }, ref.title),
    h("span", { class: "dref-go" }, icon("arrowRight", 14)),
  );
}

// -------------------------------------------------------------------
// Lifecycle (life arc)
// -------------------------------------------------------------------

const ARC_STAGE_KEYS = ["raised", "decided", "deferred", "open", "resolved"];
const ARC_STAGE_VISUAL = {
  raised:   { ac: "var(--teal)",   dot: "solid"  },
  decided:  { ac: "var(--teal)",   dot: "solid"  },
  deferred: { ac: "var(--amber)",  dot: "dashed" },
  open:     { ac: "var(--purple)", dot: "hollow" },
  resolved: { ac: "var(--green)",  dot: "fill"   },
};
function arcStageMeta(stage) {
  const k = ARC_STAGE_KEYS.includes(stage) ? stage : "raised";
  return { label: t(`ui.trace.arc.stage.${k}`), ...ARC_STAGE_VISUAL[k] };
}

// Session-anchored date label (mock "M/D · 第N次"); the deferred step shows the
// hung span "悬 from → to" instead.
function arcDateLabel(st) {
  if (st.stage === "deferred" && st.toAt) {
    return t("ui.trace.arc.span", { from: fmtMD(st.at), to: fmtMD(st.toAt) });
  }
  const md = fmtMD(st.at);
  if (!md) return fmtAgo(st.at); // unparseable timestamp → relative fallback
  return st.sessionOrdinal
    ? t("ui.trace.arc.date_session", { date: md, n: st.sessionOrdinal })
    : md;
}

// Right-aligned duration badge — the deferral length on the hung step. Diff on
// the SAME local-calendar frame fmtMD renders the span dates in, so the badge
// can never disagree with the "悬 from → to" endpoints beside it; a sub-day
// deferral (same calendar day) shows no badge.
function arcSegLabel(st) {
  if (st.stage !== "deferred" || !st.toAt) return null;
  const midnight = (iso) => {
    const d = new Date(iso);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((midnight(st.toAt) - midnight(st.at)) / DAY_MS);
  return days >= 1 ? t("ui.trace.arc.seg_hung", { days }, days) : null;
}

function renderLifecycle(stitch) {
  // The arc is the RESOLVED decision's lifecycle — show it only on that
  // decision's page, not on the resolver's.
  if (!stitch?.arc?.length || !stitch.focalIsResolved) return null;
  return h("section", { class: "sec" },
    renderSecH("branch", t("ui.trace.sec.lifecycle"), "Lifecycle"),
    h("div", { class: "arc" }, ...stitch.arc.map(renderArcStage)),
  );
}

function renderArcStage(st) {
  const meta = arcStageMeta(st.stage);
  return h("div", {
      class: `arc-stage${meta.dot === "dashed" ? " dashed" : ""}`,
      style: { "--ac": meta.ac, "--seg": meta.ac },
    },
    h("div", { class: "arc-gut" },
      h("span", { class: `arc-dot ${meta.dot}` }, st.stage === "resolved" ? icon("check", 11) : null),
      h("span", { class: "arc-line" }),
    ),
    h("div", { class: "arc-body" },
      (() => {
        const seg = arcSegLabel(st);
        return h("div", { class: "arc-shead" },
          h("span", { class: "arc-stagelabel" }, meta.label),
          h("span", { class: "arc-date" }, arcDateLabel(st)),
          seg ? h("span", { class: "arc-seg" }, seg) : null,
        );
      })(),
      h("div", { class: `arc-card${st.key ? " key" : ""}` },
        st.featureName ? h("div", { class: "arc-where" }, icon("flag", 11), st.featureName) : null,
        st.note ? h("div", { class: "arc-note" }, richText(st.note)) : null,
        st.resolver
          ? h("div", { class: "arc-resolver" },
              icon("check", 12),
              t("ui.trace.arc.resolver_prefix"),
              h("code", {}, st.resolver),
              t("ui.trace.arc.resolver_suffix"))
          : null,
        st.ccid
          ? h("div", { class: "arc-foot" },
              h("span", { class: "arc-ccid" }, `cc · ${st.ccid.slice(0, 8)}…`))
          : null,
      ),
    ),
  );
}

// -------------------------------------------------------------------
// Trade-offs (the ADR card)
// -------------------------------------------------------------------

function renderTradeoff(trace) {
  const detail = mapDetail(trace.decision);
  if (!detail) return null;
  return h("section", { class: "sec" },
    renderSecH("spark", t("ui.trace.sec.tradeoffs"), "Trade-offs"),
    renderDecisionDetail(detail, { card: true }),
  );
}

// -------------------------------------------------------------------
// Related (neighbor decisions)
// -------------------------------------------------------------------

function renderRelated(trace) {
  const groups = groupEdges(trace.edges);
  const focalMid = splitDecisionId(trace.decision.id).mid;
  const blocks = [];
  for (const key of RELATED_ORDER) {
    const edges = groups.get(key);
    if (edges?.length) blocks.push(renderNbGroup(key, edges, focalMid));
  }
  // unknown relations (defensive), excluding the stitch ones
  for (const [key, edges] of groups) {
    if (key === "resolves" || key === "resolvedBy" || RELATED_ORDER.includes(key)) continue;
    blocks.push(renderNbGroup(key, edges, focalMid));
  }
  if (blocks.length === 0) return null;
  return h("section", { class: "sec" },
    renderSecH("link", t("ui.trace.sec.related"), "Related"),
    ...blocks,
  );
}

function renderNbGroup(key, edges, focalMid) {
  const meta = relMeta(key);
  return h("div", { class: "nb-group" },
    h("div", { class: `nb-lbl${meta.isKey ? " key" : ""}` },
      icon(REL_ICON[key] ?? "link", 12),
      meta.label,
      meta.hint ? h("span", { class: "hint" }, meta.hint) : null,
    ),
    ...edges.map((e) => renderDRef(e, focalMid)),
  );
}

// dref-g glyph color follows the neighbor's decision TYPE (the mock's TYPE_G):
// decision→teal / deferred→amber / open→purple. A resolved deferred keeps the
// amber glyph even though its derived state is "resolved".
function gClsOf(type) {
  if (type === "deferred") return "deferred";
  if (type === "open") return "open";
  return "decision";
}

function renderDRef(edge, focalMid) {
  const { mid: otherMid, localId } = splitDecisionId(edge.otherId);
  const internal = otherMid === focalMid;
  const state = edge.otherState ?? "decided";
  return h("a", { class: "dref", href: decisionTraceHref(edge.otherId), "data-route": "" },
    h("span", { class: `dref-g ${gClsOf(edge.otherType)}` }, localId),
    h("span", { class: "dref-t" }, edge.otherTitle ?? "?"),
    h("span", { class: `dref-st ${nodeStateCls(state)}` }, nodeStateLabel(state)),
    h("span", { class: "dref-go" }, icon(internal ? "arrowRight" : "ext", 14)),
  );
}

// -------------------------------------------------------------------
// Affects (skills / features — files live in the artifact row)
// -------------------------------------------------------------------

function renderAffects(trace) {
  const affects = (trace.affects ?? []).filter((a) => (a.ref?.kind ?? a.kind) !== "file");
  if (affects.length === 0) return null;
  return h("section", { class: "sec" },
    renderSecH("spark", t("ui.trace.sec.affects"), "Affects"),
    h("div", { class: "aff" },
      ...affects.map((a) => {
        const kind = a.ref?.kind ?? a.kind ?? "";
        return h("span", { class: "achip" },
          icon(kind === "feature" ? "flag" : "spark", 13),
          a.label,
          h("span", { class: "ak" }, kind),
        );
      }),
    ),
  );
}

// -------------------------------------------------------------------
// Page render
// -------------------------------------------------------------------

export async function render(root, ctx) {
  ensureCss("/assets/styles/pages/trace.css");
  root.innerHTML = `<div class="loading">${escapeHtml(t("ui.trace.loading"))}</div>`;

  const { fid: mid, did } = ctx.params ?? {};
  if (!mid || !did) {
    root.innerHTML = `<div class="loading">${escapeHtml(t("ui.trace.missing_url"))}</div>`;
    return;
  }
  const decisionPath = `/decisions/${encodeURIComponent(mid)}/${encodeURIComponent(did)}`;

  let trace, stitch, siblings;
  try {
    [trace, stitch, siblings] = await Promise.all([
      apiGet(decisionPath),
      apiGet(`${decisionPath}/stitch`).catch(() => null),
      apiGet(`/features/${encodeURIComponent(mid)}/decisions`).catch(() => null),
    ]);
  } catch (err) {
    root.innerHTML = `<div class="loading">${escapeHtml(t("ui.trace.load_failed", { reason: String(err.message ?? err) }))}</div>`;
    return;
  }

  if (!trace || !trace.decision) {
    root.innerHTML = "";
    root.append(h("section", { class: "placeholder" },
      h("div", { class: "eyebrow" }, t("ui.trace.not_found_eyebrow")),
      h("h1", {}, t("ui.trace.not_found_heading", { fid: mid, did })),
      h("p", { class: "hint" }, t("ui.trace.not_found_hint")),
    ));
    return;
  }

  root.innerHTML = "";
  root.append(h("div", { class: "canvas" },
    renderPicker(trace.decision.id, siblings),
    renderFocalCard(trace),
    renderStitch(stitch),
    renderLifecycle(stitch),
    renderTradeoff(trace),
    renderRelated(trace),
    renderAffects(trace),
  ));
}
