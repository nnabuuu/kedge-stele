// Project page — single-project view at /<slug>/.
//
// Layout matches design/Stele Project.html: sticky topbar with breadcrumbs ·
// left feature rail (filterable by tag, show-done toggle) · main panel
// (milestone header + resume strip + session timeline with decision chips).
//
// API:
//   GET /<slug>/api/project        existing — project + rollup
//   GET /<slug>/api/feature-rail   new in 0.2.0-snapshot.3 — features
//                                    grouped with milestone summaries
//   GET /<slug>/api/milestones/<id> existing — selected-milestone detail
//                                    with sessions and per-session decisions

import { apiGet, ensureCss, slugUrl } from "../api.js";

// -------------------------------------------------------------------
// Static enums (mirror src/types.ts)
// -------------------------------------------------------------------

const STATUS_META = {
  active:   { label: "推进中", cls: "active" },
  winding:  { label: "收尾中", cls: "winding" },
  dormant:  { label: "搁置中", cls: "dormant" },
  archived: { label: "已归档", cls: "archived" },
};

const MS_STATE = {
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

const DEC_TYPE = {
  decision: { label: "已决",  cls: "decided" },
  deferred: { label: "推迟",  cls: "deferred" },
  open:     { label: "待决",  cls: "open" },
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
// Selection / URL state
// -------------------------------------------------------------------

function getSelectedMilestoneId() {
  const params = new URLSearchParams(location.search);
  return params.get("m") || null;
}

function setSelectedMilestoneId(id) {
  const url = new URL(location.href);
  if (id) url.searchParams.set("m", id);
  else url.searchParams.delete("m");
  history.replaceState(null, "", url.toString());
}

function pickDefaultMilestone(rail) {
  // First going/winding milestone wins; fall back to first one overall.
  for (const entry of rail) {
    for (const m of entry.milestones) {
      if (m.state === "going" || m.state === "winding") return m.id;
    }
  }
  return rail[0]?.milestones[0]?.id ?? null;
}

function findMilestoneInRail(rail, mid) {
  for (const entry of rail) {
    for (const m of entry.milestones) {
      if (m.id === mid) return { feature: entry.feature, milestone: m };
    }
  }
  return null;
}

// -------------------------------------------------------------------
// Rail
// -------------------------------------------------------------------

function renderRail(rail, selectedMid, onSelect) {
  const totalCount = rail.reduce((n, e) => n + e.milestones.length, 0);

  return h("aside", { class: "rail" },
    h("div", { class: "rail-h" },
      h("h2", {}, "milestone"),
      h("div", { class: "rail-h-r" },
        h("span", {}, `${totalCount} 个`),
      ),
    ),
    ...rail.map((entry) =>
      h("div", { class: "rg" },
        h("div", { class: "rg-lbl" },
          h("span", { class: "ic" }, "▸"),
          entry.feature.name,
          h("span", { class: "n" }, String(entry.milestones.length)),
        ),
        ...entry.milestones.map((m) =>
          renderMilestoneRow(m, selectedMid === m.id, onSelect),
        ),
      ),
    ),
    rail.length === 0
      ? h("div", { class: "filt-empty" }, "没有 feature/milestone — 试试在这个项目里跑 /decision")
      : null,
  );
}

function renderMilestoneRow(m, isSelected, onSelect) {
  const st = MS_STATE[m.state] ?? MS_STATE.going;
  return h("button", {
      class: `mrow ${m.state}${isSelected ? " on" : ""}`,
      type: "button",
      onClick: () => onSelect(m.id),
    },
    h("div", { class: "mrow-top" },
      h("span", { class: "mrow-dot" }),
      h("span", { class: "mrow-name" }, m.name),
    ),
    h("div", { class: "mrow-meta" },
      h("span", { class: "mrow-ses" }, `${m.sessionCount} 次对话`),
      m.lastActivity
        ? h("span", {}, `· 最近 ${fmtAgo(m.lastActivity)}`)
        : null,
      h("span", { class: "mrow-state" }, st.label),
    ),
    m.tags.length > 0
      ? h("div", { class: "mrow-tags" },
          ...m.tags.map((t) =>
            h("span", { class: "td", style: { "--tc": t.color }, title: t.name }),
          ),
        )
      : null,
  );
}

// -------------------------------------------------------------------
// Main (selected milestone)
// -------------------------------------------------------------------

function renderMain(milestoneDetail, railEntry) {
  if (!milestoneDetail) {
    return h("main", { class: "main" },
      h("div", { class: "main-in" },
        h("section", { class: "placeholder" },
          h("h1", {}, "没有选中 milestone"),
          h("p", { class: "hint" }, "在左边选一个，或者跑 /decision 创建。"),
        ),
      ),
    );
  }

  const m = milestoneDetail.milestone;
  const featureName = railEntry?.feature?.name ?? "";
  const st = MS_STATE[m.state] ?? MS_STATE.going;
  const sessions = milestoneDetail.sessions; // [{session, decisions}]
  const decCount = sessions.reduce((n, s) => n + s.decisions.length, 0);

  // Latest session for resume strip
  const latest = sessions[sessions.length - 1] ?? null;

  // Sessions ordered desc (newest first) for the timeline
  const orderedSessions = [...sessions].reverse();

  return h("main", { class: "main" },
    h("div", { class: "main-in", "data-mid": m.id },

      // Milestone header
      h("div", { class: "ms-head" },
        featureName
          ? h("span", { class: "ms-feat" }, featureName)
          : null,
        h("div", { class: "ms-titlerow" },
          h("h1", { class: "ms-title" }, m.name),
          h("span", { class: `ms-state-pill ${m.state}` },
            h("span", { class: "dot" }),
            st.label,
          ),
        ),
        m.about
          ? h("p", { class: "ms-about" }, m.about)
          : null,
        h("div", { class: "ms-stats" },
          h("span", { class: "ms-stat" },
            h("b", {}, String(sessions.length)),
            " 次对话累积"),
          h("span", { class: "ms-stat" },
            h("b", {}, String(decCount)),
            " 个决定"),
          latest?.session?.startedAt
            ? h("span", { class: "ms-stat" },
                `最近 ${fmtAgo(latest.session.startedAt)}`)
            : null,
        ),
      ),

      // Resume strip
      latest ? renderResumeStrip(latest, sessions.length) : null,

      // Timeline
      h("div", { class: "tl-head" },
        h("span", { class: "eyebrow" }, "对话时间线"),
        h("span", { class: "tl-hint" },
          `· 这个 milestone 由 ${sessions.length} 次对话累积而成`),
      ),
      h("p", { class: "tl-sub" },
        "每一次对话推进一点,沉淀出下面的决定。点决定可进溯源图看它的来历。"),
      sessions.length === 0
        ? h("div", { class: "placeholder" },
            h("p", { class: "hint" }, "还没有 session — 在这个 milestone 下跑 /decision 开始。"))
        : h("div", { class: "tl" },
            ...orderedSessions.map((s, idx) =>
              renderSessionCard(s, sessions.length - idx, s === latest),
            ),
          ),
    ),
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
      h("div", { class: `tl-dot ${s.outcome?.type ?? "touched"}` }),
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
  const dm = DEC_TYPE[d.type] ?? DEC_TYPE.decision;
  const title = d.detail?.title ?? d.title ?? d.id;
  // Decision id is "<milestoneId>/<localId>"; Trace route is /<slug>/d/<m>/<id>
  const parts = d.id.split("/");
  const mid = parts[0];
  const localId = parts.slice(1).join("/");
  const href = slugUrl(`/d/${encodeURIComponent(mid)}/${encodeURIComponent(localId)}`);

  return h("a", {
      class: "dchip",
      href,
      "data-route": "",
      onClick: (e) => e.stopPropagation(),
    },
    h("span", { class: `dchip-g ${d.type}` }, localId || d.id),
    h("span", { class: "dchip-t" }, title),
    h("span", { class: `dchip-st ${d.type}` }, dm.label),
  );
}

// -------------------------------------------------------------------
// Page render
// -------------------------------------------------------------------

export async function render(root, ctx) {
  ensureCss("/assets/styles/pages/project.css");
  root.innerHTML = `<div class="loading">loading project…</div>`;

  let rail, projectInfo;
  try {
    [rail, projectInfo] = await Promise.all([
      apiGet("/feature-rail"),
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
  let selected = getSelectedMilestoneId();
  if (!selected || !findMilestoneInRail(rail, selected)) {
    selected = pickDefaultMilestone(rail);
    if (selected) setSelectedMilestoneId(selected);
  }

  await renderShell(root, ctx, projectInfo, rail, selected);
}

async function renderShell(root, ctx, projectInfo, rail, selectedMid) {
  root.innerHTML = "";

  // Fetch milestone detail
  let detail = null;
  if (selectedMid) {
    try {
      detail = await apiGet(`/milestones/${encodeURIComponent(selectedMid)}`);
    } catch (err) {
      // Treat as no selection; rail still renders
      console.error(`[stele] milestone fetch failed:`, err);
    }
  }

  const railEntry = selectedMid ? findMilestoneInRail(rail, selectedMid) : null;

  const onSelect = (mid) => {
    if (mid === selectedMid) return;
    setSelectedMilestoneId(mid);
    renderShell(root, ctx, projectInfo, rail, mid);
  };

  // Optional project subtitle (path, status)
  const project = projectInfo?.project;
  if (project) {
    root.append(renderProjectSubhead(project));
  }

  root.append(
    h("div", { class: "body" },
      renderRail(rail, selectedMid, onSelect),
      renderMain(detail, railEntry),
    ),
  );
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
    h("h1", {}, "这个项目还没有 feature/milestone"),
    h("p", { class: "hint" },
      "在项目根目录跑 ",
      h("code", {}, "stele init"),
      " 装好钩子,然后用 ",
      h("code", {}, "/decision"),
      " 起草第一个决策 — feature 和 milestone 会自动出现。"),
  ));
}
