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

// -------------------------------------------------------------------
// Enums
// -------------------------------------------------------------------

const DEC_TYPE = {
  decision: { label: "已决",  cls: "decided" },
  deferred: { label: "推迟",  cls: "deferred" },
  open:     { label: "待决",  cls: "open" },
};

// nodeState string returned by statusLine — also used for state pill color
const NODE_STATE_META = {
  decided:    { label: "已决",      cls: "decided" },
  deferred:   { label: "推迟",      cls: "deferred" },
  resolved:   { label: "已解决",    cls: "resolved" },
  superseded: { label: "已被取代",  cls: "superseded" },
  open:       { label: "待决",      cls: "open" },
  conflicted: { label: "有冲突",    cls: "conflicted" },
};

const RELATION_META = {
  resolves:    { label: "解决了",   sectionLabel: "这条决定关闭了", hint: "本条把它们闭合", isKey: true },
  resolvedBy:  { label: "被解决",   sectionLabel: "被这条收尾",     hint: "这些决定关闭了本条", isKey: true },
  depends_on:  { label: "依赖",     sectionLabel: "依赖",           hint: "本条建立在它们之上" },
  depended_on: { label: "被依赖",   sectionLabel: "被依赖",         hint: "这些决定建立在本条之上" },
  relates:     { label: "相关",     sectionLabel: "相关",           hint: "话题相关的决定" },
  supersedes:  { label: "取代了",   sectionLabel: "取代",           hint: "本条把它们替换掉" },
  supersededBy: { label: "被取代", sectionLabel: "被取代",         hint: "这些决定取代了本条" },
  reconciles:  { label: "调和",     sectionLabel: "调和",           hint: "把它们的冲突调和" },
};

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

// -------------------------------------------------------------------
// DOM helper
// -------------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
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
  if (NODE_STATE_META[head]) return head;
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
  const stateMeta = NODE_STATE_META[stateKey] ?? NODE_STATE_META.decided;
  const typeMeta = DEC_TYPE[d.type] ?? DEC_TYPE.decision;
  const title = d.detail?.title ?? d.title ?? d.id;

  return h("section", { class: "focal" },
    h("div", { class: "focal-top" },
      h("span", { class: `fid type-${d.type}` }, d.id),
      h("span", { class: `state-pill st-${stateMeta.cls}` },
        h("span", { class: "dot" }),
        stateMeta.label,
      ),
      h("span", { class: `type-pill type-${typeMeta.cls}` }, typeMeta.label),
    ),
    h("h1", { class: "focal-title" }, title),
    h("p", { class: "focal-status" }, trace.statusLine),
    d.detail?.note ? h("p", { class: "focal-note" }, d.detail.note) : null,
    h("div", { class: "focal-where" },
      h("span", { class: "where-loc" },
        h("b", {}, mid),
        " · ",
        h("span", {}, localId)),
      d.detail?.trigger ? h("span", {},
        h("span", { class: "where-sep" }, "·"),
        " 触发: ",
        h("span", {}, d.detail.trigger)) : null,
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
      h("span", { class: "eyebrow" }, "跨对话缝合"),
      h("span", { class: "stitch-sub" },
        "在另一次对话里被接上的那条边"),
    ),
    h("div", { class: "stitch-flow" },
      // resolved (older) side
      h("div", { class: "stitch-card stitch-older" },
        h("div", { class: "stitch-rel" }, "原本悬挂"),
        h("a", { class: "stitch-link", href: decisionTraceHref(stitch.resolved.id), "data-route": "" },
          h("span", { class: "stitch-id" }, splitDecisionId(stitch.resolved.id).localId),
          h("span", { class: "stitch-title" }, stitch.resolved.title),
        ),
        earlier?.milestoneName ? h("div", { class: "stitch-meta" },
          `${earlier.milestoneName} · ${fmtAgo(earlier.startedAt)}`) : null,
      ),
      // arrow
      h("div", { class: "stitch-arrow" },
        h("span", { class: "stitch-arrow-line" }),
        h("span", { class: "stitch-arrow-tip" }, "resolves"),
        span != null
          ? h("span", { class: "stitch-arrow-span" }, `${span} 天后`)
          : null,
      ),
      // resolver (newer) side
      h("div", { class: "stitch-card stitch-newer" },
        h("div", { class: "stitch-rel" }, "在这次会话里被收掉"),
        h("a", { class: "stitch-link", href: decisionTraceHref(stitch.resolver.id), "data-route": "" },
          h("span", { class: "stitch-id" }, splitDecisionId(stitch.resolver.id).localId),
          h("span", { class: "stitch-title" }, stitch.resolver.title),
        ),
        later?.milestoneName ? h("div", { class: "stitch-meta" },
          `${later.milestoneName} · ${fmtAgo(later.startedAt)}`) : null,
      ),
    ),
    stitch.edgeNote
      ? h("p", { class: "stitch-note" }, h("b", {}, "记下:"), " ", stitch.edgeNote)
      : null,
  );
}

function renderNeighbors(trace) {
  const groups = groupEdges(trace.edges);
  const blocks = [];
  for (const key of NEIGHBOR_ORDER) {
    const edges = groups.get(key);
    if (!edges?.length) continue;
    const meta = RELATION_META[key];
    blocks.push(renderNeighborBlock(meta, key, edges));
  }
  // Any unknown relations (defensive)
  for (const [key, edges] of groups) {
    if (NEIGHBOR_ORDER.includes(key)) continue;
    const meta = RELATION_META[key] ?? { label: key, sectionLabel: key, hint: "" };
    blocks.push(renderNeighborBlock(meta, key, edges));
  }
  if (blocks.length === 0) {
    return h("section", { class: "neighbors empty" },
      h("p", { class: "hint" }, "这条决定还没有连接到别的决定 — 没有传入/传出的边。"),
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
          e.note ? h("span", { class: "nb-note" }, e.note) : null,
        ),
      ),
    ),
  );
}

function renderAffects(trace) {
  if (!trace.affects?.length) return null;
  return h("section", { class: "affects" },
    h("div", { class: "affects-head" },
      h("span", { class: "eyebrow" }, "Affects"),
      h("span", { class: "affects-sub" }, `· ${trace.affects.length} 个实体`),
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
  root.innerHTML = `<div class="loading">loading decision…</div>`;

  const { mid, did } = ctx.params ?? {};
  if (!mid || !did) {
    root.innerHTML = `<div class="loading">missing decision id in URL</div>`;
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
    root.innerHTML = `<div class="loading">failed to load decision · ${escapeHtml(err.message ?? err)}</div>`;
    return;
  }

  if (!trace || !trace.decision) {
    root.innerHTML = "";
    root.append(h("section", { class: "placeholder" },
      h("div", { class: "eyebrow" }, "Not found"),
      h("h1", {}, `决定 ${mid}/${did} 不存在`),
      h("p", { class: "hint" }, "可能是 id 拼错了,或者它还没在本地库里。"),
    ));
    return;
  }

  root.innerHTML = "";
  root.append(h("div", { class: "trace-page" },
    h("div", { class: "trace-back" },
      h("a", { class: "back-link", href: slugUrl("/"), "data-route": "" }, "← 项目"),
    ),
    renderFocalCard(trace),
    renderStitch(stitch),
    renderNeighbors(trace),
    renderAffects(trace),
  ));
}
