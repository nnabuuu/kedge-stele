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

// -------------------------------------------------------------------
// Enums
// -------------------------------------------------------------------

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

// h() + escapeHtml now live in ../dom.js (imported above).

// Inline SVG icons — paths transcribed from the mock's <Icon> component
// (design/Stele Trace.html:452-474). SVG needs createElementNS, so this is
// separate from h(). Stroke inherits currentColor (the eyebrow's accent).
const SVG_NS = "http://www.w3.org/2000/svg";
const ICON_PATHS = {
  chevron: [["polyline", { points: "9 6 15 12 9 18" }]],
  flag: [["line", { x1: 5, y1: 21, x2: 5, y2: 4 }], ["path", { d: "M5 4h12l-2.5 4 2.5 4H5" }]],
  doc: [["path", { d: "M6 3h8l4 4v14H6z" }], ["polyline", { points: "13 3 13 8 18 8" }]],
  spark: [["path", { d: "M12 3v4M12 17v4M3 12h4M17 12h4" }], ["circle", { cx: 12, cy: 12, r: 3 }]],
  branch: [["circle", { cx: 6, cy: 6, r: 2.4 }], ["circle", { cx: 6, cy: 18, r: 2.4 }],
           ["circle", { cx: 18, cy: 8, r: 2.4 }], ["path", { d: "M6 8.5v7M8.4 6.6c5 .4 7.6 .4 7.6 4.4v3" }]],
  link: [["path", { d: "M9 15l6-6" }], ["path", { d: "M11 6l1-1a4 4 0 0 1 6 6l-1 1" }],
         ["path", { d: "M13 18l-1 1a4 4 0 0 1-6-6l1-1" }]],
};
function icon(name, size = 13) {
  const defs = ICON_PATHS[name];
  if (!defs) return null;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.classList.add("ic");
  for (const [tag, attrs] of defs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.append(el);
  }
  return svg;
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
  const title = d.detail?.title ?? d.title ?? d.id;
  // The mock colors the id pill by the decision's tag, not its type.
  const tagColor = trace.tags?.[0]?.color ?? null;

  return h("section", { class: "focal" },
    h("div", { class: "focal-top" },
      h("span", { class: "fid", style: tagColor ? { "--tc": tagColor } : null }, d.id),
      h("span", { class: `state-pill st-${stateMeta.cls}` },
        h("span", { class: "dot" }),
        stateMeta.label,
      ),
      ...(trace.tags ?? []).map((t) =>
        h("span", { class: "scope-pill", style: { "--tc": t.color ?? "#9c9a92" } },
          h("span", { class: "scope-dot" }),
          t.name)),
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
        " 触发: ",
        h("span", {}, d.detail.trigger)) : null,
    ),
    d.sessionId ? renderResumeLauncher({ sessionId: d.sessionId }) : null,
  );
}

// "为什么这么定" — the decision rationale. The mock (design/Stele Trace.html
// :751-782) renders detail.{trigger,constraint,options,why,locks} as a
// <details> card of why-rows. Our captured detail is plain text (the mock's
// sample embeds HTML), so we render as text nodes — never innerHTML.
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
  if (trigger) rows.push(whyRow("触发", h("div", { class: "why-v" }, trigger)));
  if (constraint) rows.push(whyRow("约束", h("div", { class: "why-v" }, constraint)));

  if (options?.length) {
    const optEls = [];
    if (optionAxis) {
      optEls.push(h("div", { class: "opt-axis" },
        `沿「${optionAxis}」权衡 · ${options.length} 个选项`));
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
    rows.push(whyRow("方案", h("div", { class: "why-v" }, ...optEls)));
  }

  if (why?.length) {
    rows.push(whyRow("理由", h("div", { class: "why-v" },
      ...why.map((w) => h("p", { class: "why-reason" }, w)))));
  }

  if (hasLocks) {
    rows.push(whyRow("锁进 / 锁出", h("div", { class: "why-v" },
      h("div", { class: "locks" },
        h("div", { class: "lock in" },
          h("div", { class: "lock-k" }, "锁进了"),
          h("div", { class: "lock-v" }, locks.in ?? "—")),
        h("div", { class: "lock out" },
          h("div", { class: "lock-k" }, "锁出了"),
          h("div", { class: "lock-v" }, locks.out ?? "—")),
      ))));
  }

  return h("section", { class: "why-section" },
    h("div", { class: "why-head" },
      h("span", { class: "why-eyebrow" }, icon("spark"), "为什么这么定"),
    ),
    h("p", { class: "why-sub" }, "不只是结论,还有当时权衡过哪几个方案、选了哪个、拒了哪个。"),
    h("details", { class: "why", open: true },
      h("summary", {},
        "取舍全文 · 触发 / 方案 / 理由 / 锁进锁出",
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
      h("span", { class: "eyebrow" }, icon("link"), "跨对话缝合"),
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
        earlier?.featureName ? h("div", { class: "stitch-meta" },
          `${earlier.featureName} · ${fmtAgo(earlier.startedAt)}`) : null,
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
        later?.featureName ? h("div", { class: "stitch-meta" },
          `${later.featureName} · ${fmtAgo(later.startedAt)}`) : null,
      ),
    ),
    stitch.edgeNote
      ? h("p", { class: "stitch-note" }, h("b", {}, "记下:"), " ", stitch.edgeNote)
      : null,
  );
}

// Life Arc — the resolved decision's lifecycle (mock STAGE table, design
// Stele Trace.html lines 121-159). Each stage carries its own accent (--ac).
const ARC_STAGE = {
  raised:   { label: "提出",     ac: "var(--teal)",   dot: "solid" },
  decided:  { label: "定下",     ac: "var(--teal)",   dot: "solid" },
  deferred: { label: "推迟",     ac: "var(--amber)",  dot: "dashed" },
  open:     { label: "悬而未决", ac: "var(--purple)", dot: "hollow" },
  resolved: { label: "解决",     ac: "var(--green)",  dot: "fill" },
};

function renderArc(stitch) {
  if (!stitch?.arc?.length) return null;
  // The arc is the RESOLVED decision's lifecycle — only show it on that
  // decision's page, not on the resolver's (where it'd be "resolved-by-itself").
  if (!stitch.focalIsResolved) return null;
  return h("section", { class: "arc-section" },
    h("div", { class: "arc-head" },
      h("span", { class: "arc-eyebrow" }, icon("branch"), "状态变化"),
      h("span", { class: "arc-sub" }, "按时间排开,每一步都来自一次对话"),
    ),
    h("div", { class: "arc" },
      ...stitch.arc.map((st) => renderArcStage(st)),
    ),
  );
}

function renderArcStage(st) {
  const meta = ARC_STAGE[st.stage] ?? ARC_STAGE.raised;
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
          ? h("div", { class: "arc-resolver" }, "由 ", h("code", {}, st.resolver), " 解决")
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
          e.otherState
            ? h("span", { class: `nb-state s-${e.otherState}` },
                NODE_STATE_META[e.otherState]?.label ?? e.otherState)
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
      h("span", { class: "eyebrow" }, icon("doc"), "相关文件"),
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

  const { fid: mid, did } = ctx.params ?? {};
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
    renderArc(stitch),
    renderWhy(trace),
    renderNeighbors(trace),
    renderAffects(trace),
  ));
}
