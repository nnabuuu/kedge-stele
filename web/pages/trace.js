// Trace page — decision provenance at /<slug>/d/<mid>/<localId>.
//
// Layout matches design/Stele Trace.html: focal card (id + state + scope
// pills, large serif title, location link) · cross-session stitch band
// (when this decision participates in a `resolves` edge that crosses
// sessions) · neighbors grouped by relation · affects list.
//
// API:
//   GET /<slug>/api/decisions/<mid>/<localId>          existing — Trace
//   GET /<slug>/api/decisions/<mid>/<localId>/stitch    new in 0.2.0-snapshot.4

import { apiGet, ensureCss, slugUrl } from "../api.js";
import { renderResumeLauncher } from "../components/resume-launcher.js";
import { h, escapeHtml } from "../dom.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";

// -------------------------------------------------------------------
// Enums (cls / structural fields stay static; labels come from t() at
// render time so the locale toggle re-renders pick up new strings)
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
  if (!info) return { label: key, sectionLabel: key, hint: "", isKey: false };
  return {
    label: t(`ui.trace.rel.${key}.label`),
    sectionLabel: t(`ui.trace.rel.${key}.section`),
    hint: t(`ui.trace.rel.${key}.hint`),
    isKey: info.isKey,
  };
}

const NEIGHBOR_ORDER = [
  "resolvedBy",
  "resolves",
  "depends_on",
  "depended_on",
  "relates",
  "supersedes",
  "supersededBy",
  "reconciles",
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
  if (d < 7) return t("ui.projects.date.days_ago", { count: d });
  if (d < 14) return t("ui.projects.date.last_week");
  if (d < 30) return t("ui.projects.date.weeks_ago", { count: Math.round(d / 7) });
  return t("ui.projects.date.months_ago", { count: Math.round(d / 30) });
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

// statusLine looks like "DECIDED — 选了 ..." — we use the leading token
// as the state key for color.
function statusKeyOf(statusLine) {
  if (!statusLine) return "decided";
  const head = statusLine.split(/[\s—-]/)[0]?.toLowerCase() ?? "decided";
  if (NODE_STATE_KEYS.includes(head)) return head;
  return "decided";
}

// Group edges by an inferred relation key. For "resolves" we split by
// direction so the UI can show "this resolves X" vs "this is resolved by Y"
// separately.
function groupEdges(edges) {
  const groups = new Map(); // relationKey → [edge…]
  for (const e of edges) {
    let key = e.relation;
    if (e.relation === "resolves") {
      key = e.direction === "out" ? "resolves" : "resolvedBy";
    } else if (e.relation === "supersedes") {
      key = e.direction === "out" ? "supersedes" : "supersededBy";
    } else if (e.relation === "depends_on") {
      key = e.direction === "out" ? "depends_on" : "depended_on";
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  return groups;
}

// -------------------------------------------------------------------
// Sections
// -------------------------------------------------------------------

function renderFocalCard(trace) {
  const d = trace.decision;
  const { mid, localId } = splitDecisionId(d.id);
  const stateKey = statusKeyOf(trace.statusLine);
  const stateCls = nodeStateCls(stateKey);
  const title = d.detail?.title ?? d.title ?? d.id;
  // The mock colors the id pill by the decision's tag, not its type.
  const tagColor = trace.tags?.[0]?.color ?? null;

  return h("section", { class: "focal" },
    h("div", { class: "focal-top" },
      h("span", { class: "fid", style: tagColor ? { "--tc": tagColor } : null }, d.id),
      h("span", { class: `state-pill st-${stateCls}` },
        h("span", { class: "dot" }),
        nodeStateLabel(stateKey),
      ),
      ...(trace.tags ?? []).map((tag) =>
        h("span", { class: "scope-pill", style: { "--tc": tag.color ?? "#9c9a92" } },
          h("span", { class: "scope-dot" }),
          tag.name)),
    ),
    h("h1", { class: "focal-title" }, title),
    h("p", { class: "focal-status" }, trace.statusLine),
    d.detail?.note ? h("p", { class: "focal-note" }, d.detail.note) : null,
    h("div", { class: "focal-where" },
      h("a", { class: "where-loc mlink", href: slugUrl(`/?f=${encodeURIComponent(mid)}`), "data-route": "" },
        icon("flag", 11),
        h("b", {}, mid),
        " · ",
        h("span", {}, localId)),
      d.detail?.trigger ? h("span", { class: "where-trigger" },
        t("ui.trace.focal.trigger_label"),
        h("span", {}, d.detail.trigger)) : null,
    ),
    d.sessionId ? renderResumeLauncher({ sessionId: d.sessionId }) : null,
  );
}

// "为什么这么定" — the decision rationale.
function whyRow(label, valueEl) {
  return h("div", { class: "why-row" },
    h("div", { class: "why-k" }, label),
    valueEl,
  );
}

function renderWhy(trace) {
  const d = trace.decision;
  const detail = d.detail;
  if (!detail) return null;

  const trigger = detail.trigger ?? d.raisedBy?.trigger ?? null;
  const { optionAxis, options, why, constraint, locks } = detail;
  const hasLocks = locks && (locks.in || locks.out);
  if (!trigger && !constraint && !(options?.length) && !(why?.length) && !hasLocks) {
    return null;
  }

  const rows = [];
  if (trigger) rows.push(whyRow(t("ui.trace.why.k.trigger"), h("div", { class: "why-v" }, trigger)));
  if (constraint) rows.push(whyRow(t("ui.trace.why.k.constraint"), h("div", { class: "why-v" }, constraint)));

  if (options?.length) {
    const optEls = [];
    if (optionAxis) {
      optEls.push(h("div", { class: "opt-axis" },
        t("ui.trace.why.option_axis", { axis: optionAxis, count: options.length })));
    }
    options.forEach((o, i) => {
      const chosen = o.verdict === "chosen" || o.chosen === true;
      optEls.push(h("div", { class: "opt" + (chosen ? " chosen" : "") },
        h("span", { class: "opt-n" }, String(i + 1)),
        h("span", { class: "opt-b" },
          o.name ?? o.desc ?? "",
          o.why ? h("span", { class: "vd" }, o.why) : null,
        ),
      ));
    });
    rows.push(whyRow(t("ui.trace.why.k.options"), h("div", { class: "why-v" }, ...optEls)));
  }

  if (why?.length) {
    rows.push(whyRow(t("ui.trace.why.k.reasons"), h("div", { class: "why-v" },
      ...why.map((w) => h("p", { class: "why-reason" }, w)))));
  }

  if (hasLocks) {
    rows.push(whyRow(t("ui.trace.why.k.locks"), h("div", { class: "why-v" },
      h("div", { class: "locks" },
        h("div", { class: "lock in" },
          h("div", { class: "lock-k" }, t("ui.trace.why.lock_in_k")),
          h("div", { class: "lock-v" }, locks.in ?? t("ui.projects.date.unknown"))),
        h("div", { class: "lock out" },
          h("div", { class: "lock-k" }, t("ui.trace.why.lock_out_k")),
          h("div", { class: "lock-v" }, locks.out ?? t("ui.projects.date.unknown"))),
      ))));
  }

  return h("section", { class: "why-section" },
    h("div", { class: "why-head" },
      h("span", { class: "why-eyebrow" }, icon("spark"), t("ui.trace.why.eyebrow")),
    ),
    h("p", { class: "why-sub" }, t("ui.trace.why.sub")),
    h("details", { class: "why", open: true },
      h("summary", {},
        t("ui.trace.why.summary"),
        h("span", { class: "chev" }, icon("chevron", 14))),
      ...rows,
    ),
  );
}

function renderStitch(stitch) {
  if (!stitch) return null;
  const earlier = stitch.earlierSession;
  const later = stitch.laterSession;
  const span = stitch.daysSpanned;

  return h("section", { class: "stitch" },
    h("div", { class: "stitch-h" },
      h("span", { class: "eyebrow" }, icon("link"), t("ui.trace.stitch.eyebrow")),
      h("span", { class: "stitch-sub" }, t("ui.trace.stitch.sub")),
    ),
    h("div", { class: "stitch-flow" },
      // resolved (older) side
      h("div", { class: "stitch-card stitch-older" },
        h("div", { class: "stitch-rel" }, t("ui.trace.stitch.older")),
        h("a", { class: "stitch-link", href: decisionTraceHref(stitch.resolved.id), "data-route": "" },
          h("span", { class: "stitch-id" }, splitDecisionId(stitch.resolved.id).localId),
          h("span", { class: "stitch-title" }, stitch.resolved.title),
        ),
        earlier?.featureName ? h("div", { class: "stitch-meta" },
          `${earlier.featureName} · ${fmtAgo(earlier.startedAt)}`) : null,
      ),
      // arrow
      h("div", { class: "stitch-arrow" },
        h("span", { class: "stitch-arrow-line" }),
        h("span", { class: "stitch-arrow-tip" }, t("ui.trace.stitch.arrow_tip")),
        span != null
          ? h("span", { class: "stitch-arrow-span" }, t("ui.trace.stitch.days_after", { count: span }))
          : null,
      ),
      // resolver (newer) side
      h("div", { class: "stitch-card stitch-newer" },
        h("div", { class: "stitch-rel" }, t("ui.trace.stitch.newer")),
        h("a", { class: "stitch-link", href: decisionTraceHref(stitch.resolver.id), "data-route": "" },
          h("span", { class: "stitch-id" }, splitDecisionId(stitch.resolver.id).localId),
          h("span", { class: "stitch-title" }, stitch.resolver.title),
        ),
        later?.featureName ? h("div", { class: "stitch-meta" },
          `${later.featureName} · ${fmtAgo(later.startedAt)}`) : null,
      ),
    ),
    stitch.edgeNote
      ? h("p", { class: "stitch-note" }, h("b", {}, t("ui.trace.stitch.note_prefix")), " ", stitch.edgeNote)
      : null,
  );
}

// Life Arc — the resolved decision's lifecycle.
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

function renderArc(stitch) {
  if (!stitch?.arc?.length) return null;
  // The arc is the RESOLVED decision's lifecycle — only show it on that
  // decision's page, not on the resolver's.
  if (!stitch.focalIsResolved) return null;
  return h("section", { class: "arc-section" },
    h("div", { class: "arc-head" },
      h("span", { class: "arc-eyebrow" }, icon("branch"), t("ui.trace.arc.eyebrow")),
      h("span", { class: "arc-sub" }, t("ui.trace.arc.sub")),
    ),
    h("div", { class: "arc" },
      ...stitch.arc.map((st) => renderArcStage(st)),
    ),
  );
}

function renderArcStage(st) {
  const meta = arcStageMeta(st.stage);
  return h("div", {
      class: `arc-stage stage-${st.stage}${meta.dot === "dashed" ? " dashed" : ""}`,
      style: { "--ac": meta.ac },
    },
    h("div", { class: "arc-gut" },
      h("div", { class: `arc-dot ${meta.dot}` }, st.stage === "resolved" ? "✓" : null),
      h("div", { class: "arc-line" }),
    ),
    h("div", { class: "arc-body" },
      h("div", { class: "arc-shead" },
        h("span", { class: "arc-stagelabel" }, meta.label),
        h("span", { class: "arc-date" }, fmtAgo(st.at)),
      ),
      h("div", { class: `arc-card${st.key ? " key" : ""}` },
        st.featureName ? h("div", { class: "arc-where" }, st.featureName) : null,
        st.note ? h("div", { class: "arc-note" }, st.note) : null,
        st.resolver
          ? h("div", { class: "arc-resolver" },
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

function renderNeighbors(trace) {
  const groups = groupEdges(trace.edges);
  const blocks = [];
  for (const key of NEIGHBOR_ORDER) {
    const edges = groups.get(key);
    if (!edges?.length) continue;
    blocks.push(renderNeighborBlock(relMeta(key), key, edges));
  }
  // Any unknown relations (defensive)
  for (const [key, edges] of groups) {
    if (NEIGHBOR_ORDER.includes(key)) continue;
    blocks.push(renderNeighborBlock(relMeta(key), key, edges));
  }
  if (blocks.length === 0) {
    return h("section", { class: "neighbors empty" },
      h("p", { class: "hint" }, t("ui.trace.neighbors.empty")),
    );
  }
  return h("section", { class: "neighbors" }, ...blocks);
}

function renderNeighborBlock(meta, key, edges) {
  return h("div", { class: `nb nb-${key}${meta.isKey ? " key" : ""}` },
    h("div", { class: "nb-head" },
      h("span", { class: "nb-label" }, meta.sectionLabel),
      h("span", { class: "nb-count" }, String(edges.length)),
      meta.hint ? h("span", { class: "nb-hint" }, meta.hint) : null,
    ),
    h("div", { class: "nb-list" },
      ...edges.map((e) =>
        h("a", {
            class: "nb-row",
            href: decisionTraceHref(e.otherId),
            "data-route": "",
          },
          h("span", { class: "nb-id" }, splitDecisionId(e.otherId).localId),
          h("span", { class: "nb-title" }, e.otherTitle ?? "?"),
          e.otherState
            ? h("span", { class: `nb-state s-${e.otherState}` }, nodeStateLabel(e.otherState))
            : null,
        ),
      ),
    ),
  );
}

function renderAffects(trace) {
  if (!trace.affects?.length) return null;
  return h("section", { class: "affects" },
    h("div", { class: "affects-head" },
      h("span", { class: "eyebrow" }, icon("doc"), t("ui.trace.affects.eyebrow")),
      h("span", { class: "affects-sub" }, t("ui.trace.affects.count_suffix", { count: trace.affects.length })),
    ),
    h("div", { class: "affects-list" },
      ...trace.affects.map((a) =>
        a.href
          ? h("a", { class: "aff-row", href: a.href, target: "_blank", rel: "noopener" },
              h("span", { class: "aff-kind" }, a.ref.kind),
              h("span", { class: "aff-label" }, a.label),
            )
          : h("div", { class: "aff-row" },
              h("span", { class: "aff-kind" }, a.ref.kind),
              h("span", { class: "aff-label" }, a.label),
            ),
      ),
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

  let trace, stitch;
  try {
    [trace, stitch] = await Promise.all([
      apiGet(decisionPath),
      apiGet(`${decisionPath}/stitch`).catch(() => null),
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
  root.append(h("div", { class: "trace-page" },
    h("div", { class: "trace-back" },
      h("a", { class: "back-link", href: slugUrl("/"), "data-route": "" }, t("ui.trace.back_to_projects")),
    ),
    renderFocalCard(trace),
    renderStitch(stitch),
    renderArc(stitch),
    renderWhy(trace),
    renderNeighbors(trace),
    renderAffects(trace),
  ));
}
