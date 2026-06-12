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

export const SVG_NS = "http://www.w3.org/2000/svg";

// SVG hyperscript — like h() but for SVG-namespaced elements (the Decision
// Graph's nodes, the icon library). No style-object branch: SVG styling is via
// attributes (incl. a plain `style` string), so everything goes through
// setAttribute.
export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.setAttribute("class", v);
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

// Render a string of decision content with a SMALL allowlist of inline emphasis
// tags into real DOM nodes. The design (spec §4) injects emphasis as HTML —
// <em>, <strong>/<b>, <mark> (+ class "warn"/"good"), <code> — into decision
// detail fields (trigger, constraint, why[], option.desc, locks, ms-about, …).
// We render exactly those and turn EVERYTHING else into inert text: arbitrary
// tags (<script>, <img onerror=…>, <div>), unexpected attributes, and stray
// close tags all degrade to literal characters via text nodes. innerHTML is
// never touched, so this is XSS-safe by construction even though the content is
// agent-authored.
//
// Returns a DocumentFragment — append it like any node (h() and Element.append
// both splice a fragment's children in place).
const RICH_TAG_RE = /<(\/?)(em|strong|b|code|mark)(?:\s+class="(warn|good)")?\s*>/gi;

export function richText(str) {
  const frag = document.createDocumentFragment();
  const src = String(str ?? "");
  const stack = []; // currently-open allowlisted elements
  const parent = () => (stack.length ? stack[stack.length - 1] : frag);
  const pushText = (s) => { if (s) parent().append(document.createTextNode(s)); };

  let last = 0;
  let m;
  RICH_TAG_RE.lastIndex = 0;
  while ((m = RICH_TAG_RE.exec(src))) {
    pushText(src.slice(last, m.index)); // text since the previous tag
    last = RICH_TAG_RE.lastIndex;
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (!closing) {
      const el = document.createElement(tag);
      if (tag === "mark" && m[3]) el.className = m[3];
      parent().append(el);
      stack.push(el);
    } else {
      // Close the nearest matching open element (and any unclosed inner ones).
      // A stray close with no match degrades to literal text.
      const idx = stack.map((e) => e.tagName.toLowerCase()).lastIndexOf(tag);
      if (idx >= 0) stack.length = idx;
      else pushText(m[0]);
    }
  }
  pushText(src.slice(last)); // trailing text
  return frag;
}
