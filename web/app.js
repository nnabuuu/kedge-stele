// Stele · web UI SPA. Vanilla JS, no build, no framework.
//
// Structure: a small history-API router dispatches to view renderers.
// Each renderer is async, fetches from /api/*, and returns nothing — it
// imperatively builds DOM into the #view container.
//
// Views are deliberately independent — they pull data fresh on each
// navigation. No global cache; the server is the source of truth and a
// project's decision DB is small enough that re-fetching is free.

// ============================================================================
// API client
// ============================================================================

async function apiGet(path) {
  const r = await fetch(path);
  if (!r.ok) {
    const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    throw new Error(body.error || `HTTP ${r.status}`);
  }
  return r.json();
}

async function apiPost(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { details: data.details });
  return data;
}

// ============================================================================
// DOM helpers
// ============================================================================

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "dataset") for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv;
      else el.setAttribute(k, v);
    }
  }
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

const $view = () => document.getElementById("view");
const $overlay = () => document.getElementById("overlay");

function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

function setHead(eyebrow, title, sub) {
  return h("header", { class: "page-head" },
    eyebrow && h("div", { class: "eyebrow" }, eyebrow),
    h("h1", null, title),
    sub && h("div", { class: "sub" }, sub),
  );
}

function toast(message, kind = "info") {
  const host = document.getElementById("toast-host");
  const t = h("div", { class: "toast", role: "status" }, message);
  host.append(t);
  setTimeout(() => t.remove(), 2400);
}

function showError(container, e) {
  const err = h("div", { class: "error" }, String(e.message || e));
  if (e.details) {
    err.append(h("pre", null, JSON.stringify(e.details, null, 2)));
  }
  container.append(err);
}

// ----------------------------------------------------------------------------
// Overlay / modal
// ----------------------------------------------------------------------------

function openOverlay(modalNode) {
  const ov = $overlay();
  clear(ov);
  ov.append(modalNode);
  ov.classList.remove("hidden");
  ov.setAttribute("aria-hidden", "false");
  // Click outside modal closes
  ov.onclick = (e) => { if (e.target === ov) closeOverlay(); };
  // Focus first input/button
  const firstInput = modalNode.querySelector("input, textarea, select, button");
  if (firstInput) firstInput.focus();
}

function closeOverlay() {
  const ov = $overlay();
  ov.classList.add("hidden");
  ov.setAttribute("aria-hidden", "true");
  ov.onclick = null;
  clear(ov);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$overlay().classList.contains("hidden")) {
    closeOverlay();
  }
});

// ----------------------------------------------------------------------------
// Search overlay (triggered by `/`)
// ----------------------------------------------------------------------------

async function openSearchOverlay() {
  const placeholder = h("div", { class: "modal" }, h("div", { class: "loading" }, "loading…"));
  openOverlay(placeholder);

  let decisions;
  try {
    decisions = await apiGet("/api/decisions");
  } catch (e) {
    toast(e.message || "failed to load decisions");
    closeOverlay();
    return;
  }

  const state = { query: "", focused: 0 };
  const modal = h("div", { class: "modal" });

  function filtered() {
    const q = state.query.trim().toLowerCase();
    return decisions.filter((d) => !q ||
      d.id.toLowerCase().includes(q) ||
      d.title.toLowerCase().includes(q)).slice(0, 20);
  }

  function rerender() {
    clear(modal);
    const matches = filtered();
    if (state.focused >= matches.length) state.focused = Math.max(0, matches.length - 1);

    modal.append(
      h("button", { class: "close", onclick: closeOverlay }, "×"),
      h("h3", null, "Search decisions"),
      h("input", {
        class: "search-input",
        autofocus: true,
        placeholder: "filter by id or title…",
        value: state.query,
        oninput: (e) => { state.query = e.target.value; state.focused = 0; rerenderResults(); },
        onkeydown: (e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); state.focused = Math.min(state.focused + 1, filtered().length - 1); rerenderResults(); }
          else if (e.key === "ArrowUp") { e.preventDefault(); state.focused = Math.max(state.focused - 1, 0); rerenderResults(); }
          else if (e.key === "Enter") {
            e.preventDefault();
            const m = filtered()[state.focused];
            if (m) { closeOverlay(); navigate(`/decisions/${m.id}`); }
          }
        },
      }),
      h("div", { class: "search-results", id: "search-results" }),
      h("div", { class: "sub", style: "margin-top:10px" },
        h("span", { class: "kbd" }, "↑↓"), " navigate · ",
        h("span", { class: "kbd" }, "↵"), " open · ",
        h("span", { class: "kbd" }, "esc"), " close",
      ),
    );
    rerenderResults();
  }

  function rerenderResults() {
    const list = modal.querySelector("#search-results");
    if (!list) return;
    clear(list);
    const matches = filtered();
    matches.forEach((d, i) => list.append(h("div", {
      class: "result" + (i === state.focused ? " focused" : ""),
      onclick: () => { closeOverlay(); navigate(`/decisions/${d.id}`); },
    },
      h("span", { class: "id" }, d.id),
      h("span", null, d.title),
      h("span", { class: `badge ${d.status.kind}`, style: "margin-left:auto" },
        STATUS_LABEL[d.status.kind] || d.status.kind),
    )));
  }

  // Swap placeholder for the real modal
  const ov = $overlay();
  if (ov.classList.contains("hidden")) return; // user closed during load
  clear(ov);
  ov.append(modal);
  ov.onclick = (e) => { if (e.target === ov) closeOverlay(); };
  rerender();
  modal.querySelector(".search-input")?.focus();
}

// ----------------------------------------------------------------------------
// Global keyboard shortcuts (Linear-style chords)
// ----------------------------------------------------------------------------

let chordState = null;
let chordTimer = null;

function inEditable(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (inEditable(e.target)) return;
  if (!$overlay().classList.contains("hidden")) return; // overlay owns focus

  // chord prefix
  if (chordState === "g") {
    if (e.key === "r") { e.preventDefault(); navigate("/"); }
    else if (e.key === "a") { e.preventDefault(); navigate("/decisions"); }
    chordState = null;
    clearTimeout(chordTimer);
    return;
  }

  if (e.key === "g") {
    chordState = "g";
    clearTimeout(chordTimer);
    chordTimer = setTimeout(() => { chordState = null; }, 900);
    return;
  }
  if (e.key === "c") { e.preventDefault(); navigate("/new"); return; }
  if (e.key === "/") { e.preventDefault(); openSearchOverlay(); return; }
});

// ============================================================================
// Router
// ============================================================================

const routes = [];
function route(pattern, render, opts = {}) { routes.push({ pattern, render, opts }); }

function matchRoute(path) {
  for (const r of routes) {
    const m = path.match(r.pattern);
    if (m) return { render: r.render, params: m.slice(1), opts: r.opts };
  }
  return null;
}

function setActiveNav(navKey) {
  for (const a of document.querySelectorAll(".topbar nav a, .topbar .btn-new")) {
    a.classList.toggle("active", a.dataset.nav === navKey);
  }
}

async function renderRoute() {
  const v = $view();
  clear(v);
  v.append(h("div", { class: "loading" }, "loading…"));
  const m = matchRoute(location.pathname);
  if (!m) {
    clear(v);
    v.append(setHead(null, "Not found", `no view for ${location.pathname}`));
    return;
  }
  setActiveNav(m.opts.nav);
  try {
    const fragment = document.createDocumentFragment();
    await m.render(fragment, ...m.params);
    clear(v);
    v.append(fragment);
    window.scrollTo(0, 0);
  } catch (e) {
    clear(v);
    v.append(setHead(null, "Error", ""));
    showError(v, e);
  }
}

function navigate(path, { replace = false } = {}) {
  if (location.pathname === path) return;
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  renderRoute();
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-route]");
  if (!a) return;
  // Allow modifier-clicks to do their thing (new tab etc.)
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(a.getAttribute("href"));
});
window.addEventListener("popstate", renderRoute);

// ============================================================================
// Shared formatting
// ============================================================================

const STATUS_LABEL = {
  open: "OPEN", decided: "DECIDED", deferred: "DEFERRED",
  superseded: "SUPERSEDED", resolved: "RESOLVED", conflicted: "CONFLICTED",
};

function statusBadge(kind) {
  return h("span", { class: `badge ${kind}` }, STATUS_LABEL[kind] || kind.toUpperCase());
}

function triggerText(t) {
  if (!t) return "";
  switch (t.kind) {
    case "manual": return "手动复审";
    case "metric": return `指标: ${t.expr}`;
    case "event": return `事件: ${t.name}`;
    case "dependency": return `依赖: ${t.on}`;
    default: return JSON.stringify(t);
  }
}

function statusLine(d) {
  const s = d.status;
  switch (s.kind) {
    case "open": return `OPEN — ${s.question}`;
    case "decided": {
      const c = (s.options || []).find((o) => o.verdict === "chosen");
      return `DECIDED — 选了 ${c ? c.label + ": " + c.summary : "?"}`;
    }
    case "deferred": return `DEFERRED — ${s.reason}`;
    case "resolved": return `RESOLVED — 由 ${s.by} 解决`;
    case "superseded": return `SUPERSEDED — 被 ${s.by} 取代`;
    case "conflicted": return `CONFLICTED — ${(s.between || []).join(" × ")} @ ${s.path}`;
    default: return s.kind;
  }
}

// ============================================================================
// View · /  (Resume digest)
// ============================================================================

function resumeCard(item) {
  const isDeferred = item.bucket === "deferred";
  const cls = `card ${isDeferred ? "deferred" : "open"}${item.needsCheck ? " due" : ""}`;
  return h("a", { class: cls, href: `/decisions/${item.id}`, "data-route": "" },
    h("div", { class: "top" },
      h("span", { class: "id" }, item.id),
      h("span", { class: `bucket ${isDeferred ? "deferred" : "open"}` },
        isDeferred ? "DEFERRED" : "OPEN"),
      h("span", { class: "age" }, `${item.ageDays}d`),
      item.needsCheck && h("span", { class: "flag" }, "复审条件可能已满足"),
    ),
    h("div", { class: "title" }, item.title),
    h("div", { class: "detail" }, item.detail),
    item.trigger && h("div", { class: "trig" },
      h("span", { class: "lbl" }, "复审触发"),
      item.trigger,
    ),
  );
}

async function viewResume(root) {
  const items = await apiGet("/api/resume");
  const due = items.filter((i) => i.needsCheck);
  const open = items.filter((i) => i.bucket === "open" && !i.needsCheck);
  const deferred = items.filter((i) => i.bucket === "deferred" && !i.needsCheck);

  root.append(setHead("Resume Digest · 跨 session 的开放回路", "什么在等我",
    `${items.length} 个未闭合的决策回路`));

  if (items.length === 0) {
    root.append(h("div", { class: "empty" }, "没有未闭合的回路 — 全部 decided / resolved。"));
    return;
  }
  const section = (title, en, list) => {
    if (list.length === 0) return null;
    return h("div", null,
      h("div", { class: "sec-h" },
        h("h2", null, title, h("span", { class: "en" }, ` ${en}`)),
        h("span", { class: "hint" }, `${list.length} 项`),
      ),
      h("div", { class: "grid" }, list.map(resumeCard)),
    );
  };
  root.append(
    section("可能到期了", "复审条件或已满足", due),
    section("开放问题", "真正还没答案的", open),
    section("已推迟", "等触发条件", deferred),
  );
  root.append(h("footer", { class: "page-foot" },
    "resume digest 是 decision DAG 的一个投影 · 每次从 store 重新生成"));
}

// ============================================================================
// View · /decisions  (all decisions, grouped by status)
// ============================================================================

function decisionRow(d) {
  return h("a", { class: `card ${d.status.kind}`, href: `/decisions/${d.id}`, "data-route": "" },
    h("div", { class: "top" },
      h("span", { class: "id" }, d.id),
      h("span", { class: `bucket ${d.status.kind}` }, STATUS_LABEL[d.status.kind] || d.status.kind),
      d.scope && h("span", { class: "age" }, d.scope),
    ),
    h("div", { class: "title" }, d.title),
  );
}

async function viewAllDecisions(root) {
  const decisions = await apiGet("/api/decisions");
  root.append(setHead(null, "全部决策", `${decisions.length} 个节点`));

  // Group by status kind, preserve order
  const order = ["open", "deferred", "decided", "resolved", "superseded", "conflicted"];
  const groups = new Map(order.map((k) => [k, []]));
  for (const d of decisions) {
    if (!groups.has(d.status.kind)) groups.set(d.status.kind, []);
    groups.get(d.status.kind).push(d);
  }
  for (const kind of order) {
    const list = groups.get(kind);
    if (!list || list.length === 0) continue;
    root.append(h("div", { class: "sec-h" },
      h("h2", null, STATUS_LABEL[kind] || kind),
      h("span", { class: "hint" }, `${list.length} 项`),
    ));
    root.append(h("div", { class: "grid" }, list.map(decisionRow)));
  }
}

// ============================================================================
// View · /decisions/:id  (single decision + neighbourhood)
// ============================================================================

function metaRow(k, v) {
  return v == null || v === "" ? null
    : h("div", { class: "row" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v));
}

function affectsList(refs) {
  return h("div", { class: "affects-list" },
    refs.map((a) => h("a", {
      class: "ref",
      href: `/entities/${encodeURIComponent(a.ref.kind)}/${encodeURIComponent(a.ref.id)}`,
      "data-route": "",
    },
      h("span", { class: "kind" }, `${a.ref.kind}:`),
      a.ref.id,
    )),
  );
}

function edgeRow(e) {
  const dirCls = e.direction === "out" ? "out" : "in";
  const arrow = e.direction === "out" ? `—${e.kind}→` : `←${e.kind}—`;
  return h("a", { class: "edge-row", href: `/decisions/${e.otherId}`, "data-route": "" },
    h("span", { class: `arrow ${dirCls}` }, arrow),
    h("span", { class: "other-id" }, e.otherId),
    h("span", { class: "other-title" }, e.otherTitle),
    e.note && h("span", { class: "note" }, e.note),
  );
}

function statusSection(d) {
  const s = d.status;
  if (s.kind === "decided") {
    return h("div", { class: "section" },
      h("h3", null, "Options"),
      h("div", null, (s.options || []).map((o) =>
        h("div", { class: `option ${o.verdict}` },
          h("div", { class: "opt-head" },
            h("span", { class: "opt-name" }, o.label),
            h("span", { class: `opt-verdict ${o.verdict}` }, o.verdict),
          ),
          o.summary && h("div", { class: "opt-summary" }, o.summary),
          o.why && h("div", { class: "opt-why" }, o.why),
        )
      )),
      s.rationale && h("div", { class: "section" },
        h("h3", null, "Rationale"),
        h("div", { class: "rationale" }, s.rationale),
      ),
    );
  }
  if (s.kind === "deferred") {
    return h("div", { class: "section" },
      h("h3", null, "Deferred"),
      h("div", { class: "rationale" },
        h("div", null, h("strong", null, "现状: "), s.current),
        h("div", { style: "margin-top:6px" }, h("strong", null, "理由: "), s.reason),
        h("div", { style: "margin-top:6px" }, h("strong", null, "复审触发: "), triggerText(s.revisitWhen)),
      ),
    );
  }
  if (s.kind === "open") {
    return h("div", { class: "section" },
      h("h3", null, "Open question"),
      h("div", { class: "rationale" }, s.question),
    );
  }
  if (s.kind === "resolved") {
    return h("div", { class: "section" },
      h("h3", null, "Resolved by"),
      h("a", { class: "edge-row", href: `/decisions/${s.by}`, "data-route": "" },
        h("span", { class: "arrow in" }, "←resolved by—"),
        h("span", { class: "other-id" }, s.by),
      ),
    );
  }
  if (s.kind === "superseded") {
    return h("div", { class: "section" },
      h("h3", null, "Superseded by"),
      h("a", { class: "edge-row", href: `/decisions/${s.by}`, "data-route": "" },
        h("span", { class: "arrow in" }, "←superseded by—"),
        h("span", { class: "other-id" }, s.by),
      ),
    );
  }
  if (s.kind === "conflicted") {
    return h("div", { class: "section" },
      h("h3", null, "Conflicted"),
      h("div", { class: "rationale" },
        h("div", null, h("strong", null, "Between: "), (s.between || []).join(" × ")),
        h("div", null, h("strong", null, "Path: "), s.path),
      ),
    );
  }
  return null;
}

async function viewDecision(root, id) {
  const t = await apiGet(`/api/decisions/${encodeURIComponent(id)}`);
  const d = t.decision;

  const head = h("div", { class: "detail-head" },
    h("div", { class: "id-row" },
      h("span", { class: "id" }, d.id),
      statusBadge(d.status.kind),
      d.scope && h("span", { class: "age" }, d.scope),
    ),
    h("h1", null, d.title),
    d.constraint && h("div", { class: "sub", style: "margin-top:8px" },
      h("strong", null, "约束: "), d.constraint),
  );

  const meta = h("div", { class: "meta-table" },
    metaRow("Raised", `${d.raisedBy.actor || "?"} · ${(d.raisedBy.at || "").slice(0, 10)}`),
    metaRow("Trigger", d.raisedBy.trigger),
    metaRow("Layer", d.raisedBy.layer),
    metaRow("Status", t.statusLine),
    d.sourceReport && metaRow("Source", d.sourceReport),
  );

  root.append(head, meta);

  const status = statusSection(d);
  if (status) root.append(status);

  if (d.consequences && (d.consequences.lockedIn || d.consequences.lockedOut)) {
    root.append(h("div", { class: "section" },
      h("h3", null, "Consequences"),
      h("div", { class: "consequences" },
        d.consequences.lockedIn
          ? h("div", { class: "cell in" }, h("span", { class: "lbl" }, "locked in"), d.consequences.lockedIn) : null,
        d.consequences.lockedOut
          ? h("div", { class: "cell out" }, h("span", { class: "lbl" }, "locked out"), d.consequences.lockedOut) : null,
      ),
    ));
  }

  if (t.affects && t.affects.length > 0) {
    root.append(h("div", { class: "section" },
      h("h3", null, "Affects"),
      affectsList(t.affects),
    ));
  }

  if (t.edges && t.edges.length > 0) {
    root.append(h("div", { class: "section" },
      h("h3", null, "Graph neighbourhood"),
      h("div", { class: "edges-list" }, t.edges.map(edgeRow)),
    ));
  }

  // Edge ops
  const refresh = () => renderRoute();
  const buttons = [];
  if (d.status.kind === "open" || d.status.kind === "deferred") {
    buttons.push(h("button", {
      class: "button primary",
      onclick: () => openOverlay(buildResolveByModal(d.id, refresh)),
    }, "Mark resolved by…"));
  }
  buttons.push(h("button", {
    class: "button secondary",
    onclick: () => openOverlay(buildAddEdgeModal(d.id, refresh)),
  }, "+ Add edge…"));

  root.append(h("div", { class: "button-row" }, buttons));
}

// Synchronous wrapper around the async buildEdgeModal — opens overlay with
// a loading placeholder, then swaps in the real modal. Mirrors the pattern
// used by buildResolveByModal below.
function buildAddEdgeModal(fromId, onDone) {
  const placeholder = h("div", { class: "modal" }, h("div", { class: "loading" }, "loading decisions…"));
  buildEdgeModal({ from: fromId, defaultKind: "relates", title: "Add edge", onDone }).then((m) => {
    const ov = $overlay();
    if (ov.classList.contains("hidden")) return;
    clear(ov);
    ov.append(m);
    ov.onclick = (e) => { if (e.target === ov) closeOverlay(); };
    const firstInput = m.querySelector("input, textarea, select, button");
    if (firstInput) firstInput.focus();
  });
  return placeholder;
}

// "Mark resolved by..." picks a resolver decision (the FROM end). This is
// the inverse of the generic add-edge picker (which picks the TO end), so
// it gets its own small builder rather than overloading the generic one.
async function buildResolveByModalAsync(toId, onDone) {
  const decisions = (await apiGet("/api/decisions")).filter((d) => d.id !== toId);
  const state = { from: null, query: "", note: "" };
  const modal = h("div", { class: "modal" });

  function rerender() {
    clear(modal);
    modal.append(
      h("button", { class: "close", onclick: closeOverlay }, "×"),
      h("h3", null, `Mark ${toId} as resolved by…`),
      h("div", { class: "sub" }, `picks a later decision that answered this; target flips to RESOLVED.`),
      h("div", { class: "field" },
        h("label", { class: "field-label" }, "Resolver decision"),
        h("input", {
          class: "search-input",
          type: "text",
          placeholder: "type to filter…",
          value: state.query,
          oninput: (e) => { state.query = e.target.value; rerenderResults(); },
        }),
        h("div", { class: "search-results", id: "rby-results" }),
      ),
      h("div", { class: "field" },
        h("label", { class: "field-label" }, "Note ", h("span", { class: "hint" }, "optional")),
        h("input", {
          class: "field-input", type: "text",
          value: state.note, oninput: (e) => { state.note = e.target.value; },
        }),
      ),
      h("div", { class: "button-row" },
        h("button", { class: "button primary", onclick: submit }, "Resolve"),
        h("button", { class: "button secondary", onclick: closeOverlay }, "Cancel"),
      ),
    );
    rerenderResults();
  }
  function rerenderResults() {
    const list = modal.querySelector("#rby-results");
    if (!list) return;
    clear(list);
    const q = state.query.trim().toLowerCase();
    const matches = decisions.filter((d) => !q ||
      d.id.toLowerCase().includes(q) || d.title.toLowerCase().includes(q)).slice(0, 12);
    for (const d of matches) {
      list.append(h("div", {
        class: "result" + (state.from === d.id ? " focused" : ""),
        onclick: () => { state.from = d.id; rerenderResults(); },
      },
        h("span", { class: "id" }, d.id),
        h("span", null, d.title),
        h("span", { class: `badge ${d.status.kind}`, style: "margin-left:auto" },
          STATUS_LABEL[d.status.kind] || d.status.kind),
      ));
    }
  }
  async function submit() {
    if (!state.from) { toast("pick a resolver first"); return; }
    try {
      await apiPost("/api/edges", {
        from: state.from, to: toId, kind: "resolves",
        note: state.note || undefined,
      });
      closeOverlay();
      toast(`${state.from} resolves ${toId}`);
      if (onDone) onDone();
    } catch (e) {
      toast(e.message || "failed");
    }
  }
  rerender();
  return modal;
}

// Synchronous wrapper: opens overlay with a loading state, then swaps in
// the real modal once the async builder finishes. Keeps the click handler
// non-async (so it can be passed straight to onclick without awaits).
function buildResolveByModal(toId, onDone) {
  const placeholder = h("div", { class: "modal" }, h("div", { class: "loading" }, "loading decisions…"));
  buildResolveByModalAsync(toId, onDone).then((m) => {
    const ov = $overlay();
    if (ov.classList.contains("hidden")) return; // user closed
    clear(ov);
    ov.append(m);
    ov.onclick = (e) => { if (e.target === ov) closeOverlay(); };
    const firstInput = m.querySelector("input, textarea, select, button");
    if (firstInput) firstInput.focus();
  });
  return placeholder;
}

// ============================================================================
// Edge-picker modal — used by detail page's "Add edge" and quick-resolve.
// ============================================================================

const EDGE_KIND_LABEL = {
  resolves: "resolves (target → RESOLVED)",
  supersedes: "supersedes (target → SUPERSEDED)",
  relates: "relates (non-destructive link)",
  reconciles: "reconciles (multi-party reconcile)",
};

async function buildEdgeModal({ from, defaultKind = "relates", lockedKind = false, title = "Add edge", onDone }) {
  const state = {
    kind: defaultKind,
    to: null, // selected decision id
    query: "",
    note: "",
    decisions: [],
  };

  // Pre-fetch the decisions list for the picker. Small enough to keep in memory.
  try {
    state.decisions = (await apiGet("/api/decisions")).filter((d) => d.id !== from);
  } catch (e) {
    state.decisions = [];
  }

  const modal = h("div", { class: "modal" });
  function rerender() {
    clear(modal);

    modal.append(
      h("button", { class: "close", onclick: closeOverlay, title: "Close" }, "×"),
      h("h3", null, title),
      h("div", { class: "sub" }, `from ${from} → …`),
    );

    // Edge kind picker (segmented)
    if (!lockedKind) {
      modal.append(
        h("div", { class: "field" },
          h("label", { class: "field-label" }, "Edge kind"),
          h("div", { class: "segmented" },
            ...["resolves", "supersedes", "relates", "reconciles"].map((k) =>
              h("button", {
                class: state.kind === k ? "active" : "",
                onclick: () => { state.kind = k; rerender(); },
              }, k),
            ),
          ),
          h("div", { class: "sub", style: "margin-top:6px" }, EDGE_KIND_LABEL[state.kind] || ""),
        ),
      );
    }

    // Target search
    modal.append(
      h("div", { class: "field" },
        h("label", { class: "field-label" }, "Target decision"),
        h("input", {
          class: "search-input",
          type: "text",
          placeholder: "type to filter by id or title…",
          value: state.query,
          oninput: (e) => { state.query = e.target.value; rerenderResults(); },
        }),
        h("div", { class: "search-results", id: "edge-pick-results" }),
      ),
    );

    // Note
    modal.append(
      h("div", { class: "field" },
        h("label", { class: "field-label" }, "Note ", h("span", { class: "hint" }, "optional")),
        h("input", {
          class: "field-input",
          type: "text",
          placeholder: "why this edge…",
          value: state.note,
          oninput: (e) => { state.note = e.target.value; },
        }),
      ),
    );

    // Actions
    modal.append(
      h("div", { class: "button-row" },
        h("button", { class: "button primary", onclick: submit }, "Add edge"),
        h("button", { class: "button secondary", onclick: closeOverlay }, "Cancel"),
      ),
    );

    rerenderResults();
  }

  function rerenderResults() {
    const list = modal.querySelector("#edge-pick-results");
    if (!list) return;
    clear(list);
    const q = state.query.trim().toLowerCase();
    const matches = state.decisions.filter((d) => {
      if (!q) return true;
      return d.id.toLowerCase().includes(q) || d.title.toLowerCase().includes(q);
    }).slice(0, 12);
    if (matches.length === 0) {
      list.append(h("div", { class: "loading" }, "no matches"));
      return;
    }
    for (const d of matches) {
      const isSelected = state.to === d.id;
      list.append(h("div", {
        class: "result" + (isSelected ? " focused" : ""),
        onclick: () => { state.to = d.id; rerenderResults(); },
      },
        h("span", { class: "id" }, d.id),
        h("span", null, d.title),
        h("span", { class: `badge ${d.status.kind}`, style: "margin-left:auto" }, STATUS_LABEL[d.status.kind] || d.status.kind),
      ));
    }
  }

  async function submit() {
    if (!state.to) {
      toast("pick a target decision first");
      return;
    }
    try {
      await apiPost("/api/edges", {
        from, to: state.to, kind: state.kind, note: state.note || undefined,
      });
      closeOverlay();
      toast(`${from} —${state.kind}→ ${state.to}`);
      if (onDone) onDone();
    } catch (e) {
      toast(e.message || "failed");
    }
  }

  rerender();
  return modal;
}

// ============================================================================
// View · /entities/:kind/:id  (entity-anchored trace)
// ============================================================================

async function viewEntity(root, kind, id) {
  kind = decodeURIComponent(kind);
  id = decodeURIComponent(id);
  const data = await apiGet(`/api/entity/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`);
  root.append(setHead("Entity trace · 围绕一个 entity 的所有决策",
    `${kind}:${id}`,
    `${data.traces.length} 个相关决策`));

  if (data.traces.length === 0) {
    root.append(h("div", { class: "empty" }, "没有决策触及这个 entity。"));
    return;
  }
  root.append(h("div", { class: "grid" },
    data.traces.map((t) => h("a", {
      class: `card ${t.decision.status.kind}`,
      href: `/decisions/${t.decision.id}`, "data-route": "",
    },
      h("div", { class: "top" },
        h("span", { class: "id" }, t.decision.id),
        statusBadge(t.decision.status.kind),
        t.decision.scope && h("span", { class: "age" }, t.decision.scope),
      ),
      h("div", { class: "title" }, t.decision.title),
      h("div", { class: "detail" }, t.statusLine),
    )),
  ));
}

// ============================================================================
// View · /new  (capture form)
// ============================================================================

const ENTITY_KINDS = ["file", "feature", "skill", "lesson", "module", "schema"];
const TRIGGER_KINDS = ["manual", "event", "metric", "dependency"];

function nowIsoLocal() {
  // datetime-local input expects YYYY-MM-DDTHH:mm (local). We store back as ISO.
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 16);
}

function defaultActor() {
  try { return localStorage.getItem("stele:actor") || ""; } catch { return ""; }
}

function rememberActor(v) {
  try { localStorage.setItem("stele:actor", v); } catch { /* ignore */ }
}

async function fetchNextId(prefix) {
  try { return await apiGet(`/api/next-id?prefix=${prefix}`); } catch { return ""; }
}

function statusPrefix(kind) {
  return kind === "decided" ? "D" : kind === "deferred" ? "DEF" : "OQ";
}

async function viewNew(root) {
  // -- State ---------------------------------------------------------------
  const state = {
    id: "",
    idTouched: false,
    title: "",
    scope: "",
    constraint: "",
    raisedBy: {
      trigger: "",
      actor: defaultActor(),
      layer: "personal",
      at: nowIsoLocal(),
    },
    statusKind: "decided",
    // status — one sub-object per kind, only the active one is used at submit
    open: { question: "" },
    decided: {
      options: [{ label: "", summary: "", verdict: "chosen", why: "" }],
      rationale: "",
    },
    deferred: {
      current: "",
      reason: "",
      trigger: { kind: "event", value: "" }, // value semantics depend on kind
    },
    affects: [],
    consequences: { lockedIn: "", lockedOut: "" },
  };

  // Bootstrap id from /api/next-id for the initial status
  state.id = await fetchNextId(statusPrefix(state.statusKind));

  // -- Helpers -------------------------------------------------------------

  const card = (titleText, ...kids) =>
    h("div", { class: "form-section" },
      h("h3", null, titleText),
      ...kids,
    );

  const labeledInput = (label, value, oninput, opts = {}) =>
    h("div", { class: "field" },
      h("label", { class: "field-label" }, label, opts.hint && h("span", { class: "hint" }, opts.hint)),
      h("input", {
        class: "field-input",
        type: opts.type || "text",
        placeholder: opts.placeholder || "",
        value,
        oninput: (e) => oninput(e.target.value),
        list: opts.list,
      }),
      opts.datalist,
    );

  const labeledTextarea = (label, value, oninput, opts = {}) =>
    h("div", { class: "field" },
      h("label", { class: "field-label" }, label, opts.hint && h("span", { class: "hint" }, opts.hint)),
      h("textarea", {
        class: "field-textarea",
        placeholder: opts.placeholder || "",
        rows: opts.rows || 3,
        oninput: (e) => oninput(e.target.value),
      }, value),
    );

  const segmented = (current, options, onpick) =>
    h("div", { class: "segmented" },
      options.map((o) => h("button", {
        type: "button",
        class: current === (o.value ?? o) ? "active" : "",
        onclick: () => onpick(o.value ?? o),
      }, o.label ?? o)),
    );

  // -- Sections ------------------------------------------------------------

  function basicsSection() {
    return card("Basics",
      h("div", { class: "field-row" },
        h("div", { class: "field", style: "flex:0 0 160px" },
          h("label", { class: "field-label" }, "ID", h("span", { class: "hint" }, "auto-suggested")),
          h("input", {
            class: "field-input",
            value: state.id,
            oninput: (e) => { state.idTouched = true; state.id = e.target.value; },
          }),
        ),
        h("div", { class: "field" },
          h("label", { class: "field-label" }, "Title ", h("span", { class: "hint" }, "phrased as a question")),
          h("input", {
            class: "field-input",
            placeholder: "e.g. worktree 隔离用 per-session 还是 per-feature?",
            value: state.title,
            oninput: (e) => { state.title = e.target.value; },
          }),
        ),
      ),
      labeledInput("Scope", state.scope, (v) => state.scope = v,
        { hint: "optional", placeholder: "Runtime · Concurrency / Design · Layout / ..." }),
      labeledTextarea("Constraint", state.constraint, (v) => state.constraint = v,
        { hint: "the hard thing that made the choice non-obvious", rows: 2 }),
    );
  }

  function statusSection() {
    const renderInner = () => {
      const wrap = h("div", null);
      if (state.statusKind === "open") {
        wrap.append(labeledTextarea("Question", state.open.question,
          (v) => state.open.question = v, { rows: 3 }));
      } else if (state.statusKind === "decided") {
        wrap.append(
          h("div", { class: "field" },
            h("label", { class: "field-label" }, "Options",
              h("span", { class: "hint" }, "every alternative weighed; mark one chosen"),
            ),
            ...state.decided.options.map((o, i) => h("div", { style: "margin-bottom:10px;padding:10px 12px;border:1px solid var(--border);border-radius:8px" },
              h("div", { class: "field-row" },
                h("div", { class: "field", style: "flex:0 0 140px;margin-bottom:6px" },
                  h("input", { class: "field-input", placeholder: "label", value: o.label,
                    oninput: (e) => o.label = e.target.value }),
                ),
                h("div", { class: "field", style: "flex:0 0 200px;margin-bottom:6px" },
                  segmented(o.verdict, [
                    { value: "chosen", label: "chosen" },
                    { value: "rejected", label: "rejected" },
                  ], (v) => { o.verdict = v; rerender(); }),
                ),
                state.decided.options.length > 1 && h("button", {
                  class: "multi-remove", title: "remove",
                  onclick: () => { state.decided.options.splice(i, 1); rerender(); },
                }, "✕"),
              ),
              h("div", { class: "field", style: "margin-bottom:6px" },
                h("input", { class: "field-input", placeholder: "summary",
                  value: o.summary, oninput: (e) => o.summary = e.target.value }),
              ),
              h("div", { class: "field", style: "margin-bottom:0" },
                h("input", { class: "field-input", placeholder: "why (optional)",
                  value: o.why || "", oninput: (e) => o.why = e.target.value }),
              ),
            )),
            h("button", { class: "multi-add", type: "button",
              onclick: () => {
                state.decided.options.push({ label: "", summary: "", verdict: "rejected", why: "" });
                rerender();
              },
            }, "+ add option"),
          ),
          labeledTextarea("Rationale", state.decided.rationale,
            (v) => state.decided.rationale = v,
            { rows: 4, hint: "why this option specifically" }),
        );
      } else if (state.statusKind === "deferred") {
        wrap.append(
          labeledTextarea("Current state", state.deferred.current,
            (v) => state.deferred.current = v, { hint: "what's happening now (instead of fixing it)", rows: 2 }),
          labeledTextarea("Reason to defer", state.deferred.reason,
            (v) => state.deferred.reason = v, { rows: 2 }),
          h("div", { class: "field" },
            h("label", { class: "field-label" }, "Revisit when ",
              h("span", { class: "hint" }, "must be structured — never free text")),
            segmented(state.deferred.trigger.kind, TRIGGER_KINDS, (k) => {
              state.deferred.trigger.kind = k;
              state.deferred.trigger.value = "";
              rerender();
            }),
            h("div", { class: "trigger-fields" },
              state.deferred.trigger.kind === "manual"
                ? h("div", { class: "sub" }, "manual review — no automatic trigger")
                : h("input", {
                    class: "field-input",
                    placeholder: state.deferred.trigger.kind === "metric"
                      ? "e.g. 单 entity 并发 session 数 > 10"
                      : state.deferred.trigger.kind === "event"
                      ? "e.g. 第一个 solution delete flow ships"
                      : "e.g. D-04",
                    value: state.deferred.trigger.value,
                    oninput: (e) => state.deferred.trigger.value = e.target.value,
                  }),
            ),
          ),
        );
      }
      return wrap;
    };

    const innerHost = h("div", { id: "status-inner" }, renderInner());
    // Save the renderer so we can swap inner on status-kind change.
    statusSection._renderInner = renderInner;
    statusSection._innerHost = innerHost;

    return card("Status",
      segmented(state.statusKind,
        [{ value: "decided", label: "decided" },
         { value: "deferred", label: "deferred" },
         { value: "open", label: "open" }],
        async (k) => {
          state.statusKind = k;
          if (!state.idTouched) state.id = await fetchNextId(statusPrefix(k));
          rerender();
        }),
      innerHost,
    );
  }

  function raisedBySection() {
    return card("Raised by",
      labeledInput("Trigger", state.raisedBy.trigger,
        (v) => state.raisedBy.trigger = v,
        { placeholder: "what surfaced this question, in one line" }),
      h("div", { class: "field-row" },
        h("div", { class: "field" },
          h("label", { class: "field-label" }, "Actor"),
          h("input", { class: "field-input", value: state.raisedBy.actor,
            oninput: (e) => { state.raisedBy.actor = e.target.value; rememberActor(e.target.value); } }),
        ),
        h("div", { class: "field" },
          h("label", { class: "field-label" }, "Layer"),
          segmented(state.raisedBy.layer,
            [{ value: "personal", label: "personal" },
             { value: "school", label: "school" },
             { value: "district", label: "district" }],
            (v) => { state.raisedBy.layer = v; rerender(); }),
        ),
      ),
      h("div", { class: "field" },
        h("label", { class: "field-label" }, "When"),
        h("input", { class: "field-input", type: "datetime-local",
          value: state.raisedBy.at,
          oninput: (e) => { state.raisedBy.at = e.target.value; },
          style: "max-width:260px" }),
      ),
    );
  }

  function affectsSection() {
    const datalist = h("datalist", { id: "affects-kinds" },
      ENTITY_KINDS.map((k) => h("option", { value: k })));
    return card("Affects",
      h("div", { class: "sub", style: "margin-bottom:10px" },
        "EntityRefs — what this decision touches. file paths, feature ids, skill names…"),
      datalist,
      ...state.affects.map((a, i) => h("div", { class: "multi-row" },
        h("input", { class: "field-input", style: "flex:0 0 140px",
          placeholder: "kind", list: "affects-kinds",
          value: a.kind, oninput: (e) => a.kind = e.target.value }),
        h("input", { class: "field-input", placeholder: "id (file path / feature id / ...)",
          value: a.id, oninput: (e) => a.id = e.target.value }),
        h("button", { class: "multi-remove", title: "remove",
          onclick: () => { state.affects.splice(i, 1); rerender(); } }, "✕"),
      )),
      h("button", { class: "multi-add", type: "button",
        onclick: () => { state.affects.push({ kind: "file", id: "" }); rerender(); }
      }, "+ add reference"),
    );
  }

  function consequencesSection() {
    return card("Consequences ",
      h("div", { class: "sub", style: "margin-bottom:10px" },
        h("span", { class: "hint", style: "margin:0" }, "optional — what gets cheap or expensive downstream")),
      labeledTextarea("Locked in", state.consequences.lockedIn,
        (v) => state.consequences.lockedIn = v, { rows: 2 }),
      labeledTextarea("Locked out", state.consequences.lockedOut,
        (v) => state.consequences.lockedOut = v, { rows: 2 }),
    );
  }

  // -- Render orchestration ------------------------------------------------

  const formHost = h("form", { onsubmit: (e) => { e.preventDefault(); submit(); } });

  function rerender() {
    clear(formHost);
    formHost.append(
      basicsSection(),
      statusSection(),
      raisedBySection(),
      affectsSection(),
      consequencesSection(),
      h("div", { class: "button-row", style: "margin-top:14px" },
        h("button", { class: "button primary", type: "submit" }, "Capture decision"),
        h("a", { class: "button secondary", href: "/", "data-route": "" }, "Cancel"),
      ),
    );
  }

  // -- Submit --------------------------------------------------------------

  function buildDecision() {
    const d = {
      id: state.id.trim(),
      title: state.title.trim(),
      raisedBy: {
        trigger: state.raisedBy.trigger.trim(),
        actor: state.raisedBy.actor.trim(),
        layer: state.raisedBy.layer,
        at: new Date(state.raisedBy.at).toISOString(),
      },
      affects: state.affects
        .map((a) => ({ kind: a.kind.trim(), id: a.id.trim() }))
        .filter((a) => a.kind && a.id),
    };
    if (state.scope.trim()) d.scope = state.scope.trim();
    if (state.constraint.trim()) d.constraint = state.constraint.trim();

    if (state.statusKind === "open") {
      d.status = { kind: "open", question: state.open.question };
    } else if (state.statusKind === "decided") {
      d.status = {
        kind: "decided",
        options: state.decided.options
          .filter((o) => o.label.trim() || o.summary.trim())
          .map((o) => ({
            label: o.label.trim(),
            summary: o.summary.trim(),
            verdict: o.verdict,
            ...(o.why?.trim() ? { why: o.why.trim() } : {}),
          })),
        rationale: state.decided.rationale.trim(),
      };
    } else {
      const t = state.deferred.trigger;
      let revisitWhen;
      if (t.kind === "manual") revisitWhen = { kind: "manual" };
      else if (t.kind === "metric") revisitWhen = { kind: "metric", expr: t.value };
      else if (t.kind === "event") revisitWhen = { kind: "event", name: t.value };
      else revisitWhen = { kind: "dependency", on: t.value };
      d.status = {
        kind: "deferred",
        current: state.deferred.current.trim(),
        reason: state.deferred.reason.trim(),
        revisitWhen,
      };
    }

    const c = state.consequences;
    if (c.lockedIn.trim() || c.lockedOut.trim()) {
      d.consequences = {};
      if (c.lockedIn.trim()) d.consequences.lockedIn = c.lockedIn.trim();
      if (c.lockedOut.trim()) d.consequences.lockedOut = c.lockedOut.trim();
    }

    return d;
  }

  async function submit() {
    // Clear prior errors
    formHost.querySelectorAll(".error").forEach((e) => e.remove());

    const decision = buildDecision();
    if (!decision.id || !decision.title || !decision.raisedBy.trigger || !decision.raisedBy.actor) {
      const err = h("div", { class: "error" },
        "missing required fields — id, title, raisedBy.trigger, raisedBy.actor are all required");
      formHost.prepend(err);
      window.scrollTo(0, 0);
      return;
    }

    try {
      const result = await apiPost("/api/decisions", { decision });
      toast(`captured ${result.id}`);
      // Show proposed edges (if any) so the user can accept them
      if (result.proposed && result.proposed.length > 0) {
        openOverlay(buildProposedEdgesModal(result.id, result.proposed));
      } else {
        navigate(`/decisions/${result.id}`);
      }
    } catch (e) {
      const err = h("div", { class: "error" }, e.message || "capture failed");
      if (e.details) err.append(h("pre", null, JSON.stringify(e.details, null, 2)));
      formHost.prepend(err);
      window.scrollTo(0, 0);
    }
  }

  // -- Mount ---------------------------------------------------------------

  root.append(setHead("Decision capture", "新建一个决策",
    "等价于在 Claude Code 里用 /decision。所有 surface 写的是同一个 store。"));
  root.append(formHost);
  rerender();
}

// ----------------------------------------------------------------------------
// Proposed-edges modal (shown after capture)
// ----------------------------------------------------------------------------

function buildProposedEdgesModal(newId, proposals) {
  const modal = h("div", { class: "modal" });
  const remaining = new Map(proposals.map((p, i) => [i, p]));

  function rerender() {
    clear(modal);
    modal.append(
      h("button", { class: "close", onclick: () => goNext() }, "×"),
      h("h3", null, `Captured ${newId} ✓`),
      h("div", { class: "sub" },
        `The consolidate layer thinks this decision may relate to ${proposals.length} other node(s). Accept the good ones; ignore the rest.`),
      h("div", { style: "margin:14px 0" },
        ...Array.from(remaining.values()).map((p, i) => h("div", { class: "proposed-edge" },
          h("span", { class: "confidence" }, `${(p.confidence * 100) | 0}%`),
          h("span", { class: "reason" },
            `${p.edge.from} —${p.edge.kind}→ ${p.edge.to}`,
            h("div", { class: "sub", style: "margin-top:2px" }, p.reason || ""),
          ),
          h("button", {
            class: "button primary accept",
            onclick: async () => {
              try {
                await apiPost("/api/edges", p.edge);
                toast(`${p.edge.from} —${p.edge.kind}→ ${p.edge.to}`);
                // Find and remove this exact proposal
                for (const [k, v] of remaining) {
                  if (v === p) { remaining.delete(k); break; }
                }
                if (remaining.size === 0) goNext();
                else rerender();
              } catch (e) { toast(e.message || "failed"); }
            },
          }, "accept"),
          h("button", {
            class: "button secondary",
            onclick: () => {
              for (const [k, v] of remaining) {
                if (v === p) { remaining.delete(k); break; }
              }
              if (remaining.size === 0) goNext();
              else rerender();
            },
          }, "skip"),
        )),
      ),
      h("div", { class: "button-row" },
        h("button", { class: "button secondary", onclick: () => goNext() }, "Done"),
      ),
    );
  }

  function goNext() {
    closeOverlay();
    navigate(`/decisions/${newId}`);
  }

  rerender();
  return modal;
}

// ============================================================================
// Registration + boot
// ============================================================================

route(/^\/$/, viewResume, { nav: "resume" });
route(/^\/decisions$/, viewAllDecisions, { nav: "decisions" });
route(/^\/decisions\/([^/]+)$/, viewDecision, {});
route(/^\/entities\/([^/]+)\/([^/]+)$/, viewEntity, {});
route(/^\/new$/, viewNew, { nav: "new" });

// Expose for debugging
window.__stele = { apiGet, apiPost, navigate, toast };

renderRoute();
