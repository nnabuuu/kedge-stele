// Resume launcher — surfaces the `claude --resume <cc-id>` command for the
// session that produced a decision, so the user can jump back into that
// conversation. Mirrors the ResumeLauncher in the design mocks (Projects /
// Project / Trace all use it).
//
// Liveness ("process still alive" → jump mode) is deferred — there's no
// backend signal for it yet — so we render the rebuild command (copy + run),
// which always works. The API already distinguishes mode: "jump" | "rebuild".
//
// Consumes: GET /<slug>/api/sessions/<id>/resume-command
//   → { mode, command, copyable, lastSession }
//
// Returns a DOM element (or null) — callers append it directly.

import { currentSlug } from "../api.js";
import { t } from "../i18n.js";

// Resolve the resume-command URL. On slug-scoped pages (Trace/Project) the
// slug comes from the URL; on the slug-less Projects overview the caller
// passes the target project's slug explicitly.
async function fetchResumeCommand(sessionId, slug) {
  const s = slug ?? currentSlug();
  const base = s ? `/${encodeURIComponent(s)}/api` : "/api";
  const r = await fetch(`${base}/sessions/${encodeURIComponent(sessionId)}/resume-command`, {
    headers: { accept: "application/json" },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export function renderResumeLauncher({ sessionId, slug } = {}) {
  if (!sessionId) return null;

  const wrap = document.createElement("div");
  wrap.className = "resume-launcher";

  const btn = document.createElement("button");
  btn.className = "resume-btn";
  btn.type = "button";
  btn.append(Object.assign(document.createElement("span"), { className: "resume-dot" }));
  btn.append(document.createTextNode(t("ui.resume.btn")));

  const pop = document.createElement("div");
  pop.className = "resume-pop";
  pop.hidden = true;

  wrap.append(btn, pop);

  let loaded = false;
  btn.addEventListener("click", async () => {
    pop.hidden = !pop.hidden;
    if (pop.hidden || loaded) return;
    loaded = true;
    pop.textContent = t("ui.resume.loading");
    try {
      const data = await fetchResumeCommand(sessionId, slug);
      pop.textContent = "";
      pop.append(renderPop(data));
    } catch {
      loaded = false;
      pop.textContent = t("ui.resume.fetch_failed");
    }
  });

  return wrap;
}

function renderPop(data) {
  const inner = document.createElement("div");
  inner.className = "resume-pop-in";

  const label = document.createElement("div");
  label.className = "resume-pop-label";
  label.textContent = data.mode === "jump" ? t("ui.resume.label_jump") : t("ui.resume.label_rebuild");
  inner.append(label);

  const row = document.createElement("div");
  row.className = "resume-cmd-row";

  const cmd = document.createElement("code");
  cmd.className = "resume-cmd";
  cmd.textContent = data.command ?? "";
  row.append(cmd);

  if (data.copyable && data.command) {
    const copy = document.createElement("button");
    copy.className = "resume-copy";
    copy.type = "button";
    copy.textContent = t("ui.resume.copy");
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(data.command);
        copy.textContent = t("ui.resume.copied");
        setTimeout(() => { copy.textContent = t("ui.resume.copy"); }, 1500);
      } catch {
        copy.textContent = t("ui.resume.copy_failed");
      }
    });
    row.append(copy);
  }

  inner.append(row);
  return inner;
}
