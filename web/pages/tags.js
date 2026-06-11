// Tags page — tag library at /<slug>/tags.
//
// Layout matches design/Stele Tags.html:
//   • policy panel — 3 mode cards (auto / propose / locked) + require_reason toggle
//   • pending proposals queue (when policy != auto and there's anything pending)
//   • active tag library (sortable rows: swatch, name, kind, origin, count)
//   • archived collapsible
//
// All endpoints exist as of 0.1.x — no new backend in phase 5.
//
// API:
//   GET /<slug>/api/tags?status=active|archived|all
//   GET /<slug>/api/tags/proposals?outcome=pending
//   GET /<slug>/api/config
//   POST /<slug>/api/config/tag_policy
//   POST /<slug>/api/config/tag_require_reason
//   POST /<slug>/api/tags/proposals/<id>/confirm
//   POST /<slug>/api/tags/proposals/<id>/reject
//   POST /<slug>/api/tags/<id>/rename
//   POST /<slug>/api/tags/<id>/recolor
//   POST /<slug>/api/tags/<id>/archive
//   POST /<slug>/api/tags/<id>/restore

import { apiGet, apiPost, ensureCss } from "../api.js";
import { h, escapeHtml } from "../dom.js";

// -------------------------------------------------------------------
// Enums
// -------------------------------------------------------------------

const POLICY_META = {
  auto: {
    label: "自动新增",
    desc: "agent 提的新标签自动生效,事后能看到。最轻松,但容易积出近义标签。",
  },
  propose: {
    label: "提议待确认",
    desc: "agent 提议,你逐条确认。手动把关,适合开始阶段。",
    isDefault: true,
  },
  locked: {
    label: "仅用现有",
    desc: "标签库锁定。agent 只能用已有标签,新提议被拦下。",
  },
};

const POLICY_KEYS = ["auto", "propose", "locked"];

// -------------------------------------------------------------------
// DOM helper
// -------------------------------------------------------------------

// h() + escapeHtml now live in ../dom.js (imported above).

function fmtAgo(iso) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const d = Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
  if (d <= 0) return "今天";
  if (d === 1) return "昨天";
  if (d < 30) return `${d} 天前`;
  if (d < 365) return `${Math.round(d / 30)} 个月前`;
  return `${Math.round(d / 365)} 年前`;
}

// -------------------------------------------------------------------
// Toast (light feedback for actions)
// -------------------------------------------------------------------

function toast(msg, isErr = false) {
  const host = document.getElementById("toast-host");
  if (!host) return;
  const el = h("div", { class: `toast${isErr ? " err" : ""}` }, msg);
  host.append(el);
  setTimeout(() => el.classList.add("on"), 20);
  setTimeout(() => {
    el.classList.remove("on");
    setTimeout(() => el.remove(), 240);
  }, 2400);
}

// -------------------------------------------------------------------
// Sections
// -------------------------------------------------------------------

function renderHeader(activeCount, pendCount, archivedCount) {
  return h("div", { class: "tag-page-head" },
    h("div", { class: "sec-head" },
      h("div", { class: "eyebrow" }, "Tag library"),
      h("h1", {}, "标签"),
    ),
    h("div", { class: "tag-head-counts" },
      h("span", {}, h("span", { class: "n" }, String(activeCount)), " 在用"),
      h("span", { class: "sep" }),
      h("span", {}, h("span", { class: "n" }, String(pendCount)), " 待确认"),
      h("span", { class: "sep" }),
      h("span", {}, h("span", { class: "n" }, String(archivedCount)), " 已归档"),
    ),
  );
}

function renderPolicy(state, onPolicyChange, onRequireReasonChange) {
  return h("section", { class: "sec policy-sec" },
    h("div", { class: "sec-h" },
      h("span", { class: "eyebrow" }, "本地策略 · 谁能建新标签"),
      h("span", { class: "hint" }, "存在 .stele/decisions.db · 不出本机"),
    ),
    h("div", { class: "policy" },
      h("div", { class: "policy-modes" },
        ...POLICY_KEYS.map((k) => {
          const m = POLICY_META[k];
          return h("button", {
              class: `pmode${state.policy === k ? " on" : ""}`,
              type: "button",
              onClick: () => onPolicyChange(k),
            },
            h("span", { class: "pmode-t" },
              m.label,
              m.isDefault ? h("span", { class: "badge" }, "默认") : null,
            ),
            h("span", { class: "pmode-d" }, m.desc),
          );
        }),
      ),
      h("div", { class: "policy-extra" },
        h("div", { class: "policy-extra-tx" },
          h("b", {}, "采用前要 agent 说明理由"),
          h("span", {}, "提议新标签时,agent 必须附上「为什么现有标签不够用」。"),
        ),
        h("button", {
            class: `toggle${state.requireReason ? " on" : ""}`,
            type: "button",
            onClick: () => onRequireReasonChange(!state.requireReason),
            "aria-pressed": state.requireReason ? "true" : "false",
          },
          h("i", {}),
        ),
      ),
    ),
  );
}

function renderPending(pending, policy, onConfirm, onReject) {
  if (pending.length === 0) return null;

  const bannerCopy = {
    propose: ["当前是", h("b", {}, "「提议待确认」"), ": 下面的新标签需要你逐个确认才进标签库。"],
    auto:    ["当前是", h("b", {}, "「自动新增」"), ": agent 建的标签直接生效,这里只是回看。"],
    locked:  ["当前是", h("b", {}, "「仅用现有」"), ": 这些是被拦下的提议。你可以破例采用,或让它们就这么记着。"],
  };

  return h("section", { class: "sec" },
    h("div", { class: "sec-h" },
      h("span", { class: "eyebrow" }, "待确认 / 提议"),
      h("span", { class: "cnt" }, String(pending.length)),
    ),
    h("div", { class: `pend-banner ${policy}` }, bannerCopy[policy] ?? bannerCopy.propose),
    ...pending.map((p) => renderPendingRow(p, onConfirm, onReject)),
  );
}

function renderPendingRow(p, onConfirm, onReject) {
  return h("div", { class: "pend-row" },
    h("div", { class: "pend-l" },
      h("span", { class: "pend-swatch", style: { background: p.suggestedColor ?? "#9c9a92" } }),
      h("div", { class: "pend-meta" },
        h("div", { class: "pend-name" }, p.name),
        p.reason
          ? h("div", { class: "pend-reason" }, p.reason)
          : h("div", { class: "pend-reason muted" }, "(没有附上理由)"),
        h("div", { class: "pend-sub" },
          `${fmtAgo(p.createdAt)}`,
          p.targets?.length ? ` · 计划应用到 ${p.targets.length} 个目标` : "",
        ),
      ),
    ),
    h("div", { class: "pend-r" },
      h("button", {
          class: "btn-mini ok",
          type: "button",
          onClick: () => onConfirm(p),
        }, "采用"),
      h("button", {
          class: "btn-mini no",
          type: "button",
          onClick: () => onReject(p),
        }, "驳回"),
    ),
  );
}

function renderLibrary(tags, onRename, onRecolor, onArchive) {
  return h("section", { class: "sec" },
    h("div", { class: "sec-h" },
      h("span", { class: "eyebrow" }, "在用的标签"),
      h("span", { class: "cnt" }, String(tags.length)),
      h("span", { class: "hint" }, "点色块改色 · 悬停看操作"),
    ),
    tags.length === 0
      ? h("div", { class: "lib-empty" }, "还没有标签 — agent 在 /stele:feature 流程里识别到的标签会出现在这里。")
      : h("div", { class: "tlib" },
          ...tags.map((tg) => renderTagRow(tg, false, onRename, onRecolor, onArchive)),
        ),
  );
}

function renderArchived(archived, onRestore) {
  if (archived.length === 0) return null;
  return h("details", { class: "arch" },
    h("summary", {},
      h("span", { class: "chev" }, "▸"),
      `已归档 · ${archived.length}`),
    h("div", { class: "arch-list tlib" },
      ...archived.map((tg) => renderTagRow(tg, true, null, null, null, onRestore)),
    ),
  );
}

function renderTagRow(tag, isArchived, onRename, onRecolor, onArchive, onRestore) {
  const row = h("div", { class: `trow${isArchived ? " archived" : ""}` },
    h("input", {
        class: "trow-color",
        type: "color",
        value: tag.color ?? "#9c9a92",
        title: "改色",
        disabled: isArchived,
        onChange: (e) => onRecolor?.(tag, e.target.value),
      }),
    h("span", { class: "trow-name", title: tag.name }, tag.name),
    h("span", { class: "trow-count" }, h("b", {}, String(tag.count ?? 0)), " 处在用"),
    h("span", { class: "trow-kind" }, tag.kind ?? "scope"),
    h("span", { class: `trow-origin trow-origin-${tag.origin}` },
      tag.origin === "agent" ? "agent" : "you"),
    h("div", { class: "trow-acts" },
      isArchived
        ? h("button", {
            class: "btn-mini",
            type: "button",
            onClick: () => onRestore?.(tag),
          }, "恢复")
        : [
            h("button", {
              class: "btn-mini ghost",
              type: "button",
              onClick: () => {
                const nv = window.prompt("新名字", tag.name);
                if (nv && nv.trim() && nv !== tag.name) onRename?.(tag, nv.trim());
              },
            }, "改名"),
            h("button", {
              class: "btn-mini ghost",
              type: "button",
              onClick: () => onArchive?.(tag),
            }, "归档"),
          ],
    ),
  );
  return row;
}

// -------------------------------------------------------------------
// State + actions
// -------------------------------------------------------------------

const state = {
  policy: "propose",
  requireReason: true,
  active: [],
  archived: [],
  pending: [],
};

async function loadAll() {
  const [config, active, archived, pending] = await Promise.all([
    apiGet("/config"),
    apiGet("/tags?status=active"),
    apiGet("/tags?status=archived"),
    apiGet("/tags/proposals?outcome=pending"),
  ]);
  // config has explicit overrides; _defaults gives the effective values
  const defaults = config?._defaults ?? {};
  state.policy = config.tag_policy ?? defaults.tag_policy ?? "propose";
  state.requireReason = parseBool(config.tag_require_reason, defaults.tag_require_reason ?? true);
  state.active = Array.isArray(active) ? active : [];
  state.archived = Array.isArray(archived) ? archived : [];
  state.pending = Array.isArray(pending) ? pending : [];
}

function parseBool(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === "boolean") return raw;
  const s = String(raw).toLowerCase();
  return !(s === "false" || s === "0" || s === "no" || s === "off");
}

async function onPolicyChange(next) {
  const prev = state.policy;
  state.policy = next;
  rerender();
  try {
    await apiPost("/config/tag_policy", { value: next });
    toast(`策略 → ${POLICY_META[next].label}`);
  } catch (err) {
    state.policy = prev;
    rerender();
    toast(`改策略失败 · ${err.message ?? err}`, true);
  }
}

async function onRequireReasonChange(next) {
  const prev = state.requireReason;
  state.requireReason = next;
  rerender();
  try {
    await apiPost("/config/tag_require_reason", { value: String(next) });
    toast(next ? "要求 agent 附上理由" : "不强制理由");
  } catch (err) {
    state.requireReason = prev;
    rerender();
    toast(`改设置失败 · ${err.message ?? err}`, true);
  }
}

async function onConfirm(p) {
  try {
    await apiPost(`/tags/proposals/${encodeURIComponent(p.id)}/confirm`, {});
    await loadAll();
    rerender();
    toast(`采用 · ${p.name}`);
  } catch (err) {
    toast(`采用失败 · ${err.message ?? err}`, true);
  }
}

async function onReject(p) {
  try {
    await apiPost(`/tags/proposals/${encodeURIComponent(p.id)}/reject`, {});
    await loadAll();
    rerender();
    toast(`驳回 · ${p.name}`);
  } catch (err) {
    toast(`驳回失败 · ${err.message ?? err}`, true);
  }
}

async function onRename(tag, newName) {
  try {
    await apiPost(`/tags/${encodeURIComponent(tag.id)}/rename`, { name: newName });
    await loadAll();
    rerender();
    toast(`重命名 · ${newName}`);
  } catch (err) {
    toast(`改名失败 · ${err.message ?? err}`, true);
  }
}

async function onRecolor(tag, color) {
  try {
    await apiPost(`/tags/${encodeURIComponent(tag.id)}/recolor`, { color });
    // Update in-place; don't reload everything
    const t = state.active.find((x) => x.id === tag.id);
    if (t) t.color = color;
    toast("色块已更新");
  } catch (err) {
    toast(`改色失败 · ${err.message ?? err}`, true);
  }
}

async function onArchive(tag) {
  if (!confirm(`归档 "${tag.name}"? 已经打过的标记不会被清除。`)) return;
  try {
    await apiPost(`/tags/${encodeURIComponent(tag.id)}/archive`, {});
    await loadAll();
    rerender();
    toast(`已归档 · ${tag.name}`);
  } catch (err) {
    toast(`归档失败 · ${err.message ?? err}`, true);
  }
}

async function onRestore(tag) {
  try {
    await apiPost(`/tags/${encodeURIComponent(tag.id)}/restore`, {});
    await loadAll();
    rerender();
    toast(`已恢复 · ${tag.name}`);
  } catch (err) {
    toast(`恢复失败 · ${err.message ?? err}`, true);
  }
}

// -------------------------------------------------------------------
// Page render
// -------------------------------------------------------------------

let rootEl = null;

function rerender() {
  if (!rootEl) return;
  rootEl.innerHTML = "";
  // renderPending / renderArchived return null when their lists are empty;
  // Element.append() stringifies null → a literal "null" text node, so filter
  // them out before appending.
  // Wrap in a max-width column (mock .canvas: 880px centered) — the shell
  // otherwise stretches the rows to the full 1140px content width.
  rootEl.append(
    h("div", { class: "tag-page" },
      ...[
        renderHeader(state.active.length, state.pending.length, state.archived.length),
        renderPolicy(state, onPolicyChange, onRequireReasonChange),
        renderPending(state.pending, state.policy, onConfirm, onReject),
        renderLibrary(state.active, onRename, onRecolor, onArchive),
        renderArchived(state.archived, onRestore),
      ].filter(Boolean),
    ),
  );
}

export async function render(root, _ctx) {
  ensureCss("/assets/styles/pages/tags.css");
  rootEl = root;
  root.innerHTML = `<div class="loading">loading tags…</div>`;
  try {
    await loadAll();
  } catch (err) {
    root.innerHTML = `<div class="loading">failed to load tags · ${escapeHtml(err.message ?? err)}</div>`;
    return;
  }
  rerender();
}
