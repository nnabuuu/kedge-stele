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
import { t, formatRelativeDate } from "../i18n.js";

// -------------------------------------------------------------------
// Enums (label / desc come from t() at render time so the topbar
// toggle re-renders pick up new locales — see graph.js for the
// pattern)
// -------------------------------------------------------------------

const POLICY_KEYS = ["auto", "propose", "locked"];
const POLICY_DEFAULT = "propose";

function policyLabel(key) {
  return t(`ui.tags.policy.${key}.label`);
}
function policyDesc(key) {
  return t(`ui.tags.policy.${key}.desc`);
}

// -------------------------------------------------------------------
// DOM helper
// -------------------------------------------------------------------

// h() + escapeHtml now live in ../dom.js (imported above).

function fmtAgo(iso) {
  if (!iso) return t("ui.tags.no_date");
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return t("ui.tags.no_date");
  return formatRelativeDate(new Date(parsed));
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
      h("div", { class: "eyebrow" }, t("ui.tags.eyebrow")),
      h("h1", {}, t("ui.tags.heading")),
    ),
    h("div", { class: "tag-head-counts" },
      h("span", {}, h("span", { class: "n" }, String(activeCount)), " ", t("ui.tags.count_active")),
      h("span", { class: "sep" }),
      h("span", {}, h("span", { class: "n" }, String(pendCount)), " ", t("ui.tags.count_pending")),
      h("span", { class: "sep" }),
      h("span", {}, h("span", { class: "n" }, String(archivedCount)), " ", t("ui.tags.count_archived")),
    ),
  );
}

function renderPolicy(state, onPolicyChange, onRequireReasonChange) {
  return h("section", { class: "sec policy-sec" },
    h("div", { class: "sec-h" },
      h("span", { class: "eyebrow" }, t("ui.tags.policy_section_label")),
      h("span", { class: "hint" }, t("ui.tags.policy_section_hint")),
    ),
    h("div", { class: "policy" },
      h("div", { class: "policy-modes" },
        ...POLICY_KEYS.map((k) => {
          const isDefault = k === POLICY_DEFAULT;
          return h("button", {
              class: `pmode${state.policy === k ? " on" : ""}`,
              type: "button",
              onClick: () => onPolicyChange(k),
            },
            h("span", { class: "pmode-t" },
              policyLabel(k),
              isDefault ? h("span", { class: "badge" }, t("ui.tags.policy.default_badge")) : null,
            ),
            h("span", { class: "pmode-d" }, policyDesc(k)),
          );
        }),
      ),
      h("div", { class: "policy-extra" },
        h("div", { class: "policy-extra-tx" },
          h("b", {}, t("ui.tags.policy.require_reason_title")),
          h("span", {}, t("ui.tags.policy.require_reason_desc")),
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

  // Banner shape: prefix + <b>strong</b> + suffix per policy. Splitting into
  // three keys per locale keeps natural CN/EN order without forcing string
  // concatenation in the caller.
  const banner = (mode) => [
    t(`ui.tags.pending_banner_${mode}_prefix`),
    h("b", {}, t(`ui.tags.pending_banner_${mode}_strong`)),
    t(`ui.tags.pending_banner_${mode}_suffix`),
  ];
  const bannerCopy = {
    propose: banner("propose"),
    auto: banner("auto"),
    locked: banner("locked"),
  };

  return h("section", { class: "sec" },
    h("div", { class: "sec-h" },
      h("span", { class: "eyebrow" }, t("ui.tags.pending_section_label")),
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
          : h("div", { class: "pend-reason muted" }, t("ui.tags.pending_no_reason")),
        h("div", { class: "pend-sub" },
          `${fmtAgo(p.createdAt)}`,
          p.targets?.length ? t("ui.tags.pending_targets", { count: p.targets.length }) : "",
        ),
      ),
    ),
    h("div", { class: "pend-r" },
      h("button", {
          class: "btn-mini ok",
          type: "button",
          onClick: () => onConfirm(p),
        }, t("ui.tags.pending_action_confirm")),
      h("button", {
          class: "btn-mini no",
          type: "button",
          onClick: () => onReject(p),
        }, t("ui.tags.pending_action_reject")),
    ),
  );
}

function renderLibrary(tags, onRename, onRecolor, onArchive) {
  return h("section", { class: "sec" },
    h("div", { class: "sec-h" },
      h("span", { class: "eyebrow" }, t("ui.tags.library_section_label")),
      h("span", { class: "cnt" }, String(tags.length)),
      h("span", { class: "hint" }, t("ui.tags.library_section_hint")),
    ),
    tags.length === 0
      ? h("div", { class: "lib-empty" }, t("ui.tags.library_empty"))
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
      t("ui.tags.archived_summary", { count: archived.length })),
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
        title: t("ui.tags.row_recolor_title"),
        disabled: isArchived,
        onChange: (e) => onRecolor?.(tag, e.target.value),
      }),
    h("span", { class: "trow-name", title: tag.name }, tag.name),
    h("span", { class: "trow-count" }, h("b", {}, String(tag.count ?? 0)), t("ui.tags.row_count")),
    h("span", { class: "trow-kind" }, tag.kind ?? t("ui.tags.row_kind_fallback")),
    h("span", { class: `trow-origin trow-origin-${tag.origin}` },
      tag.origin === "agent" ? t("ui.tags.row_origin_agent") : t("ui.tags.row_origin_you")),
    h("div", { class: "trow-acts" },
      isArchived
        ? h("button", {
            class: "btn-mini",
            type: "button",
            onClick: () => onRestore?.(tag),
          }, t("ui.tags.row_action_restore"))
        : [
            h("button", {
              class: "btn-mini ghost",
              type: "button",
              onClick: () => {
                const nv = window.prompt(t("ui.tags.rename_prompt"), tag.name);
                if (nv && nv.trim() && nv !== tag.name) onRename?.(tag, nv.trim());
              },
            }, t("ui.tags.row_action_rename")),
            h("button", {
              class: "btn-mini ghost",
              type: "button",
              onClick: () => onArchive?.(tag),
            }, t("ui.tags.row_action_archive")),
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
    toast(t("ui.tags.toast.policy_changed", { label: policyLabel(next) }));
  } catch (err) {
    state.policy = prev;
    rerender();
    toast(t("ui.tags.toast.policy_change_failed", { reason: err.message ?? err }), true);
  }
}

async function onRequireReasonChange(next) {
  const prev = state.requireReason;
  state.requireReason = next;
  rerender();
  try {
    await apiPost("/config/tag_require_reason", { value: String(next) });
    toast(next ? t("ui.tags.toast.require_reason_on") : t("ui.tags.toast.require_reason_off"));
  } catch (err) {
    state.requireReason = prev;
    rerender();
    toast(t("ui.tags.toast.setting_change_failed", { reason: err.message ?? err }), true);
  }
}

async function onConfirm(p) {
  try {
    await apiPost(`/tags/proposals/${encodeURIComponent(p.id)}/confirm`, {});
    await loadAll();
    rerender();
    toast(t("ui.tags.toast.confirmed", { name: p.name }));
  } catch (err) {
    toast(t("ui.tags.toast.confirm_failed", { reason: err.message ?? err }), true);
  }
}

async function onReject(p) {
  try {
    await apiPost(`/tags/proposals/${encodeURIComponent(p.id)}/reject`, {});
    await loadAll();
    rerender();
    toast(t("ui.tags.toast.rejected", { name: p.name }));
  } catch (err) {
    toast(t("ui.tags.toast.reject_failed", { reason: err.message ?? err }), true);
  }
}

async function onRename(tag, newName) {
  try {
    await apiPost(`/tags/${encodeURIComponent(tag.id)}/rename`, { name: newName });
    await loadAll();
    rerender();
    toast(t("ui.tags.toast.renamed", { name: newName }));
  } catch (err) {
    toast(t("ui.tags.toast.rename_failed", { reason: err.message ?? err }), true);
  }
}

async function onRecolor(tag, color) {
  try {
    await apiPost(`/tags/${encodeURIComponent(tag.id)}/recolor`, { color });
    // Update in-place; don't reload everything
    const found = state.active.find((x) => x.id === tag.id);
    if (found) found.color = color;
    toast(t("ui.tags.toast.recolored"));
  } catch (err) {
    toast(t("ui.tags.toast.recolor_failed", { reason: err.message ?? err }), true);
  }
}

async function onArchive(tag) {
  if (!confirm(t("ui.tags.archive_confirm", { name: tag.name }))) return;
  try {
    await apiPost(`/tags/${encodeURIComponent(tag.id)}/archive`, {});
    await loadAll();
    rerender();
    toast(t("ui.tags.toast.archived", { name: tag.name }));
  } catch (err) {
    toast(t("ui.tags.toast.archive_failed", { reason: err.message ?? err }), true);
  }
}

async function onRestore(tag) {
  try {
    await apiPost(`/tags/${encodeURIComponent(tag.id)}/restore`, {});
    await loadAll();
    rerender();
    toast(t("ui.tags.toast.restored", { name: tag.name }));
  } catch (err) {
    toast(t("ui.tags.toast.restore_failed", { reason: err.message ?? err }), true);
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
  root.innerHTML = `<div class="loading">${escapeHtml(t("ui.tags.loading"))}</div>`;
  try {
    await loadAll();
  } catch (err) {
    root.innerHTML = `<div class="loading">${escapeHtml(t("ui.tags.load_failed", { reason: String(err.message ?? err) }))}</div>`;
    return;
  }
  rerender();
}
