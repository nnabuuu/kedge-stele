// Shared DOM helpers for the SPA page modules. These were copy-pasted across
// every page (trace/project/projects/tags/graph + app/topbar); the copies
// diverged — the CSS-custom-property fix landed in only some — which caused a
// recurring class of "fixed in N-of-M copies" bugs. One canonical copy here.

// Hyperscript: build a DOM element from a tag, an attrs object, and children.
//   - class: string → el.className
//   - style: object → per-property; CSS custom properties (--x) MUST go through
//     setProperty (Object.assign silently no-ops on them)
//   - on*: function → addEventListener (onClick → "click")
//   - other: setAttribute (true → "")
//   - children: flattened; null/false skipped; Nodes appended, else text node
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith("--")) el.style.setProperty(sk, sv);
        else el.style[sk] = sv;
      }
    }
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Escape a string for safe interpolation into an HTML template literal (used by
// the topbar + app.js loading/error states that build markup as strings).
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}
