// Decision Graph page — interactive viewer at /<slug>/graph.
//
// Layout matches design/Decision Graph.html (the interactive prototype).
// We render the graph as an SVG with feature-clustered columns: each
// Feature is a vertical column, decisions stack inside it sorted by
// state rank then by id; edges draw between columns.
//
// API:
//   GET /<slug>/api/graph?feature=&tag=
//   Returns {nodes, edges, features}.
//
// 0.3.0: the slice used to carry a two-level {features, milestones} pivot
// when the umbrella Feature wrapped the old Milestone layer. The collapse
// dropped the umbrella, so the pivot list is flat and the only entity
// filter is `feature`.

import { apiGet, ensureCss, slugUrl } from "../api.js";
import { h, escapeHtml, svg } from "../dom.js";
import { t } from "../i18n.js";

// -------------------------------------------------------------------
// Enums (state + edge color)
// -------------------------------------------------------------------

// 0.5.0: labels migrated to t() at render time so the topbar toggle
// picks up new locales without a page reload. The cls fields stay
// static — they're CSS-class names, not user-facing strings.
const NODE_STATE_META = {
  decided:    { cls: "decided"    },
  deferred:   { cls: "deferred"   },
  resolved:   { cls: "resolved"   },
  superseded: { cls: "superseded" },
  open:       { cls: "open"       },
  conflicted: { cls: "conflicted" },
};

function nodeStateLabel(state) {
  return t(`ui.states.decision.${state}`);
}

// Edge colors are LITERAL hex (not CSS custom-properties) because:
//   (a) the v-graph token scope deliberately omits --seal / --mono (per
//       CLAUDE.md § Frontend canonical reference) and would silently fall
//       back to currentColor; and
//   (b) SVG presentation attributes like `stroke="var(--x)"` aren't reliably
//       resolved across browsers — only inline `style="stroke: var(--x)"`
//       (or CSS rules targeting the element) works portably.
// CLAUDE.md explicitly notes that DG "uses seal red inline only, not as a
// token" — these literals match that intent.
const RELATION_META = {
  resolves:    { color: "#A23A29", dashed: false },  // seal
  supersedes:  { color: "#5c5b56", dashed: false },  // t2
  reconciles:  { color: "#2f5278", dashed: false },  // blue
  relates:     { color: "#9c9a92", dashed: true  },  // t3
  depends_on:  { color: "#3a3185", dashed: true  },  // purple
};

function relationLabel(rel) {
  return t(`ui.relations.${rel}`);
}

const STATE_RANK = {
  open: 0, deferred: 1, decided: 2, resolved: 3, superseded: 4, conflicted: 0,
};

// -------------------------------------------------------------------
// DOM helpers
// -------------------------------------------------------------------

// h() + escapeHtml + svg() now live in ../dom.js (imported above).


function splitDecisionId(id) {
  const parts = id.split("/");
  if (parts.length < 2) return { fid: id, localId: "" };
  return { fid: parts[0], localId: parts.slice(1).join("/") };
}

// -------------------------------------------------------------------
// URL state — feature/tag filters
// -------------------------------------------------------------------

function getFilter() {
  const p = new URLSearchParams(location.search);
  return {
    feature: p.get("feature") ?? null,
    tag: p.get("tag") ?? null,
  };
}

function setFilter(next) {
  const url = new URL(location.href);
  for (const k of ["feature", "tag"]) {
    if (next[k]) url.searchParams.set(k, next[k]);
    else url.searchParams.delete(k);
  }
  history.replaceState(null, "", url.toString());
}

// -------------------------------------------------------------------
// Layout — feature-clustered columns
// -------------------------------------------------------------------

const COL_WIDTH = 220;
const COL_GAP = 60;
const NODE_HEIGHT = 56;
const NODE_GAP = 14;
const COL_HEADER = 64;
const PADDING_X = 40;
const PADDING_Y = 40;

function computeLayout(slice) {
  // Each Feature becomes a column. Nodes within a column stack vertically,
  // sorted by state rank (open/deferred first) then by id.
  const featureOrder = slice.features
    .filter((f) => slice.nodes.some((n) => n.featureId === f.id))
    .sort((a, b) => {
      // Prefer "going" then "winding" then others; tie-break by id.
      const sa = stateRankFt(a.state);
      const sb = stateRankFt(b.state);
      if (sa !== sb) return sa - sb;
      return a.id.localeCompare(b.id);
    });

  const cols = featureOrder.map((f, colIdx) => {
    const inCol = slice.nodes
      .filter((n) => n.featureId === f.id)
      .sort((a, b) => {
        const r = STATE_RANK[a.state] - STATE_RANK[b.state];
        if (r !== 0) return r;
        return a.id.localeCompare(b.id);
      });
    return { feature: f, nodes: inCol, colIdx };
  });

  // Position each node
  const nodePos = new Map(); // decisionId → {x, y}
  let maxColHeight = 0;
  for (const col of cols) {
    const x = PADDING_X + col.colIdx * (COL_WIDTH + COL_GAP) + COL_WIDTH / 2;
    let y = PADDING_Y + COL_HEADER;
    for (const n of col.nodes) {
      nodePos.set(n.id, { x, y: y + NODE_HEIGHT / 2 });
      y += NODE_HEIGHT + NODE_GAP;
    }
    if (y > maxColHeight) maxColHeight = y;
  }

  const width = PADDING_X * 2 + cols.length * (COL_WIDTH + COL_GAP) - COL_GAP;
  const height = Math.max(maxColHeight + PADDING_Y, 400);

  return { cols, nodePos, width, height };
}

function stateRankFt(s) {
  return ({ going: 0, winding: 1, paused: 2, draft: 3, done: 4 })[s] ?? 5;
}

// -------------------------------------------------------------------
// SVG render
// -------------------------------------------------------------------

function renderGraphSvg(slice, layout, onNodeClick, highlightedNodeId) {
  const { cols, nodePos, width, height } = layout;

  const root = svg("svg", {
    class: "graph-svg",
    viewBox: `0 0 ${width} ${height}`,
    width: String(width),
    height: String(height),
    preserveAspectRatio: "xMidYMid meet",
    role: "img",
    "aria-label": t("ui.graph.aria_label", { nodes: slice.nodes.length, edges: slice.edges.length }),
  });

  // <defs> with arrowhead markers per relation color. Same reason as edges
  // below: `fill=""` attribute with var() doesn't resolve; use style="".
  const defs = svg("defs");
  for (const [key, meta] of Object.entries(RELATION_META)) {
    const marker = svg("marker", {
      id: `ah-${key}`,
      viewBox: "0 0 8 8",
      refX: "7",
      refY: "4",
      markerWidth: "8",
      markerHeight: "8",
      orient: "auto",
      markerUnits: "userSpaceOnUse",
    },
      svg("path", { d: "M0 0 L8 4 L0 8 Z", style: `fill: ${meta.color}` }),
    );
    defs.append(marker);
  }
  root.append(defs);

  // Column backgrounds + headers
  for (const col of cols) {
    const x = PADDING_X + col.colIdx * (COL_WIDTH + COL_GAP);
    root.append(svg("rect", {
      class: "col-bg",
      x: String(x),
      y: String(PADDING_Y),
      width: String(COL_WIDTH),
      height: String(height - 2 * PADDING_Y),
      rx: "10",
    }));
    root.append(svg("text", {
      class: "col-h-label",
      x: String(x + 16),
      y: String(PADDING_Y + 22),
    }, col.feature.name));
    root.append(svg("text", {
      class: `col-h-state state-${col.feature.state}`,
      x: String(x + 16),
      y: String(PADDING_Y + 40),
    }, featureStateLabel(col.feature.state)));
    root.append(svg("text", {
      class: "col-h-count",
      x: String(x + COL_WIDTH - 16),
      y: String(PADDING_Y + 22),
      "text-anchor": "end",
    }, `${col.nodes.length}`));
  }

  // Edges first so nodes paint on top
  const highlightedEdges = new Set();
  if (highlightedNodeId) {
    for (const e of slice.edges) {
      if (e.from === highlightedNodeId || e.to === highlightedNodeId) {
        highlightedEdges.add(edgeKey(e));
      }
    }
  }

  for (const e of slice.edges) {
    const from = nodePos.get(e.from);
    const to = nodePos.get(e.to);
    if (!from || !to) continue;
    const meta = RELATION_META[e.relation] ?? RELATION_META.relates;
    const isHi = highlightedEdges.has(edgeKey(e));
    const path = bezierPath(from, to);
    // Style attribute (not stroke="") so the color actually applies — SVG
    // presentation attributes don't reliably resolve var() expressions and
    // we want a consistent literal value either way.
    const styleParts = [
      `stroke: ${meta.color}`,
      `stroke-width: ${isHi ? 2 : 1.5}`,
      "fill: none",
      meta.dashed ? "stroke-dasharray: 4 4" : "",
      highlightedNodeId && !isHi ? "opacity: 0.2" : "opacity: 1",
    ].filter(Boolean);
    root.append(svg("path", {
      class: `edge edge-${e.relation}${isHi ? " hi" : ""}`,
      d: path,
      "marker-end": `url(#ah-${e.relation})`,
      style: styleParts.join("; "),
    }));
  }

  // Nodes
  for (const col of cols) {
    for (const n of col.nodes) {
      const p = nodePos.get(n.id);
      if (!p) continue;
      const stMeta = NODE_STATE_META[n.state] ?? NODE_STATE_META.decided;
      const isHi = n.id === highlightedNodeId;
      const g = svg("g", {
        class: `node node-${n.type} state-${stMeta.cls}${isHi ? " hi" : ""}`,
        transform: `translate(${p.x - COL_WIDTH / 2 + 12} ${p.y - NODE_HEIGHT / 2})`,
        tabindex: "0",
        role: "button",
        onClick: () => onNodeClick(n),
        onKeydown: (e) => { if (e.key === "Enter" || e.key === " ") onNodeClick(n); },
      });
      g.append(svg("rect", {
        class: "node-bg",
        x: "0",
        y: "0",
        width: String(COL_WIDTH - 24),
        height: String(NODE_HEIGHT),
        rx: "6",
      }));
      const { localId } = splitDecisionId(n.id);
      g.append(svg("text", {
        class: "node-id",
        x: "10",
        y: "18",
      }, localId || n.id));
      g.append(svg("text", {
        class: "node-state",
        x: String(COL_WIDTH - 34),
        y: "18",
        "text-anchor": "end",
      }, nodeStateLabel(n.state)));
      g.append(svg("text", {
        class: "node-title",
        x: "10",
        y: "38",
      }, truncate(n.title || n.id, 30)));
      root.append(g);
    }
  }

  return root;
}

function edgeKey(e) {
  return `${e.from}${e.relation}${e.to}`;
}

function bezierPath(from, to) {
  // Smooth curve. Control points pulled out horizontally so columns flow
  // left-to-right.
  const dx = Math.abs(to.x - from.x);
  const cx = Math.max(40, dx * 0.5);
  return `M ${from.x} ${from.y} C ${from.x + cx} ${from.y}, ${to.x - cx} ${to.y}, ${to.x} ${to.y}`;
}

function truncate(s, n) {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function featureStateLabel(s) {
  return t(`ui.states.feature.${s}`);
}

// -------------------------------------------------------------------
// Filter pills + legend
// -------------------------------------------------------------------

function renderFilterBar(slice, filter, onFilter) {
  return h("div", { class: "graph-filters" },
    h("div", { class: "filt-group" },
      h("span", { class: "filt-lbl" }, t("ui.graph.filter_feature_label")),
      h("button", {
          class: `filt-chip${!filter.feature ? " on" : ""}`,
          onClick: () => onFilter({ ...filter, feature: null }),
        }, t("ui.graph.filter_all")),
      ...slice.features.map((f) =>
        h("button", {
            class: `filt-chip${filter.feature === f.id ? " on" : ""}`,
            onClick: () => onFilter({ ...filter, feature: f.id }),
          }, f.name),
      ),
    ),
  );
}

function renderLegend() {
  return h("div", { class: "graph-legend" },
    h("span", { class: "leg-h" }, t("ui.graph.legend_label")),
    ...Object.entries(RELATION_META).map(([key, meta]) =>
      h("span", { class: "leg-item" },
        h("span", {
          class: "leg-line",
          style: meta.dashed
            ? {
                backgroundImage: `linear-gradient(90deg, ${meta.color} 50%, transparent 50%)`,
                backgroundSize: "6px 100%",
              }
            : { background: meta.color },
        }),
        relationLabel(key)),
    ),
  );
}

// -------------------------------------------------------------------
// Page render
// -------------------------------------------------------------------

let rootEl = null;
let highlightedNodeId = null;

async function loadAndRender(filter) {
  const params = new URLSearchParams();
  if (filter.feature) params.set("feature", filter.feature);
  if (filter.tag) params.set("tag", filter.tag);
  const qs = params.toString();
  const slice = await apiGet(`/graph${qs ? `?${qs}` : ""}`);
  drawAll(slice, filter);
}

function drawAll(slice, filter) {
  rootEl.innerHTML = "";

  const onFilter = (next) => {
    setFilter(next);
    loadAndRender(next).catch((err) => {
      console.error("[stele] graph filter failed:", err);
    });
  };

  const onNodeClick = (n) => {
    // First click highlights; second navigates to trace.
    if (highlightedNodeId === n.id) {
      const { fid, localId } = splitDecisionId(n.id);
      const href = slugUrl(`/d/${encodeURIComponent(fid)}/${encodeURIComponent(localId)}`);
      location.href = href;
      return;
    }
    highlightedNodeId = n.id;
    drawAll(slice, filter);
  };

  rootEl.append(
    h("div", { class: "graph-head" },
      h("div", { class: "sec-head" },
        h("div", { class: "eyebrow" }, t("ui.graph.eyebrow")),
        h("h1", {}, t("ui.graph.heading")),
      ),
      h("div", { class: "graph-stats" },
        h("span", {},
          h("span", { class: "n" }, String(slice.nodes.length)),
          " ",
          t("ui.graph.stat_decisions")),
        h("span", { class: "sep" }),
        h("span", {},
          h("span", { class: "n" }, String(slice.edges.length)),
          " ",
          t("ui.graph.stat_edges")),
        h("span", { class: "sep" }),
        h("span", {},
          h("span", { class: "n" }, String(slice.features.length)),
          " ",
          t("ui.graph.stat_features")),
      ),
    ),
    renderFilterBar(slice, filter, onFilter),
  );

  if (slice.nodes.length === 0) {
    rootEl.append(h("section", { class: "placeholder" },
      h("h1", {}, t("ui.graph.empty_heading")),
      h("p", { class: "hint" },
        filter.feature || filter.tag
          ? t("ui.graph.empty_filtered")
          : t("ui.graph.empty_unfiltered_prefix"),
        h("code", {}, "/stele:feature"),
        filter.feature || filter.tag ? "" : t("ui.graph.empty_unfiltered_suffix")),
    ));
    return;
  }

  const layout = computeLayout(slice);
  const scrollWrap = h("div", { class: "graph-scroll" });
  scrollWrap.append(renderGraphSvg(slice, layout, onNodeClick, highlightedNodeId));
  rootEl.append(scrollWrap);
  rootEl.append(renderLegend());

  if (highlightedNodeId) {
    rootEl.append(renderHighlightHint(slice));
  }
}

function renderHighlightHint(slice) {
  const n = slice.nodes.find((x) => x.id === highlightedNodeId);
  if (!n) return null;
  return h("div", { class: "graph-hi" },
    h("span", { class: "hi-lbl" }, t("ui.graph.highlight_label")),
    h("span", { class: "hi-id" }, splitDecisionId(n.id).localId),
    h("span", { class: "hi-title" }, n.title),
    h("span", { class: "hi-hint" }, t("ui.graph.highlight_hint")),
    h("button", {
        class: "btn-mini ghost",
        onClick: () => {
          highlightedNodeId = null;
          loadAndRender(getFilter());
        },
      }, t("ui.graph.highlight_clear")),
  );
}

export async function render(root, _ctx) {
  ensureCss("/assets/styles/pages/graph.css");
  rootEl = root;
  highlightedNodeId = null;
  root.innerHTML = `<div class="loading">${escapeHtml(t("ui.graph.loading"))}</div>`;
  try {
    await loadAndRender(getFilter());
  } catch (err) {
    root.innerHTML = `<div class="loading">${escapeHtml(t("ui.graph.load_failed", { reason: String(err.message ?? err) }))}</div>`;
  }
}
