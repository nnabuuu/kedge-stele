// Inline-SVG icon library. Paths transcribed from the design mocks' <Icon>
// component (design/Stele Trace.html:452-474) — 24×24 viewBox, currentColor
// stroke at 1.8 so the icon inherits its container's accent color. Union of
// what the Trace eyebrows/flag and the Project timeline glyph need (was
// duplicated as trace.js `icon()` + project.js `glyph()`).

import { svg } from "./dom.js";

const ICON_PATHS = {
  chevron: [["polyline", { points: "9 6 15 12 9 18" }]],
  check:   [["polyline", { points: "5 12.5 10 17.5 19 7" }]],
  flag:    [["line", { x1: 5, y1: 21, x2: 5, y2: 4 }], ["path", { d: "M5 4h12l-2.5 4 2.5 4H5" }]],
  doc:     [["path", { d: "M6 3h8l4 4v14H6z" }], ["polyline", { points: "13 3 13 8 18 8" }]],
  spark:   [["path", { d: "M12 3v4M12 17v4M3 12h4M17 12h4" }], ["circle", { cx: 12, cy: 12, r: 3 }]],
  branch:  [["circle", { cx: 6, cy: 6, r: 2.4 }], ["circle", { cx: 6, cy: 18, r: 2.4 }],
            ["circle", { cx: 18, cy: 8, r: 2.4 }], ["path", { d: "M6 8.5v7M8.4 6.6c5 .4 7.6 .4 7.6 4.4v3" }]],
  link:    [["path", { d: "M9 15l6-6" }], ["path", { d: "M11 6l1-1a4 4 0 0 1 6 6l-1 1" }],
            ["path", { d: "M13 18l-1 1a4 4 0 0 1-6-6l1-1" }]],
  msg:     [["path", { d: "M21 11.5a8 8 0 0 1-11.5 7.2L4 20.5l1.8-5A8 8 0 1 1 21 11.5z" }]],
  layers:  [["polygon", { points: "12 3 21 8 12 13 3 8 12 3" }], ["polyline", { points: "3 13 12 18 21 13" }]],
  bell:    [["path", { d: "M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" }], ["path", { d: "M13.7 21a2 2 0 0 1-3.4 0" }]],
  ext:     [["line", { x1: 7, y1: 17, x2: 17, y2: 7 }], ["polyline", { points: "8 7 17 7 17 16" }]],
  clock:   [["circle", { cx: 12, cy: 12, r: 8.5 }], ["polyline", { points: "12 7.5 12 12 15.2 13.8" }]],
  help:    [["circle", { cx: 12, cy: 12, r: 8.5 }], ["path", { d: "M9.6 9.4a2.5 2.5 0 0 1 4.8 .9c0 1.7-2.4 1.9-2.4 3.4" }],
            ["circle", { cx: 12, cy: 16.7, r: 0.7, fill: "currentColor", stroke: "none" }]],
};

// Build an inline icon SVG (class "ic"). Returns null for an unknown name.
export function icon(name, size = 13) {
  const defs = ICON_PATHS[name];
  if (!defs) return null;
  return svg("svg", {
      class: "ic",
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.8",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    },
    ...defs.map(([tag, attrs]) => svg(tag, attrs)),
  );
}
