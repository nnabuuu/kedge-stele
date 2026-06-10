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

import { apiGet } from "../api.js";

export function renderResumeLauncher({ sessionId } = {}) {
  if (!sessionId) return null;

  const wrap = document.createElement("div");
  wrap.className = "resume-launcher";

  const btn = document.createElement("button");
  btn.className = "resume-btn";
  btn.type = "button";
  btn.append(Object.assign(document.createElement("span"), { className: "resume-dot" }));
  btn.append(document.createTextNode("继续这次对话"));

  const pop = document.createElement("div");
  pop.className = "resume-pop";
  pop.hidden = true;

  wrap.append(btn, pop);

  let loaded = false;
  btn.addEventListener("click", async () => {
    pop.hidden = !pop.hidden;
    if (pop.hidden || loaded) return;
    loaded = true;
    pop.textContent = "…";
    try {
      const data = await apiGet(`/sessions/${encodeURIComponent(sessionId)}/resume-command`);
      pop.textContent = "";
      pop.append(renderPop(data));
    } catch {
      loaded = false;
      pop.textContent = "无法获取恢复命令";
    }
  });

  return wrap;
}

function renderPop(data) {
  const inner = document.createElement("div");
  inner.className = "resume-pop-in";

  const label = document.createElement("div");
  label.className = "resume-pop-label";
  label.textContent = data.mode === "jump" ? "回到正在运行的会话" : "复制并运行以继续这次对话";
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
    copy.textContent = "复制";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(data.command);
        copy.textContent = "已复制 ✓";
        setTimeout(() => { copy.textContent = "复制"; }, 1500);
      } catch {
        copy.textContent = "复制失败";
      }
    });
    row.append(copy);
  }

  inner.append(row);
  return inner;
}
