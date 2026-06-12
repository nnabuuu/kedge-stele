// Shared ADR decision-detail rendering — the .dd-* trade-off body used by both
// the Project page (inside each .fdec card) and the Trace page (as a .dd.dd-card).
// Maps the backend Decision.detail shape onto the mock's render shape and builds
// the frame / options table / why / locks / artifact blocks. All injected text
// runs through richText() so authored <em>/<strong>/<mark> render styled.

import { h, richText } from "./dom.js";
import { t } from "./i18n.js";

const OPT_LETTERS = "ABCDEFGHIJKLMN";

// Collapse detail.artifact (+ legacy top-level artifacts[]) into {files, commit}.
export function artifactOf(d) {
  const files = [];
  const a = d.detail?.artifact;
  if (a?.file) files.push({ label: null, path: a.file });
  for (const art of d.artifacts ?? []) if (art?.file) files.push({ label: null, path: art.file });
  const commit = a?.commit ?? d.artifacts?.find((x) => x?.commit)?.commit ?? null;
  return { files, commit };
}

// Backend detail → the mock's DecisionDetail shape. Returns null when there is
// no body worth rendering (e.g. a bare deferred with empty detail).
export function mapDetail(d) {
  const dt = d.detail;
  if (!dt) return null;
  // OPTION column is a short letter (the schema's `name` is often a long phrase
  // that doesn't fit the narrow column). APPROACH carries the content: the name
  // (bold) + the one-line desc when present.
  const options = (dt.options ?? []).map((o, i) => {
    const name = o.name ?? "";
    const desc = o.desc ?? "";
    const ap = desc ? `<strong>${name}</strong> — ${desc}` : name;
    return {
      n: OPT_LETTERS[i] ?? String(i + 1),
      ap,
      vd: o.why ?? (o.verdict === "chosen" ? "✓" : "✗"),
      chosen: o.chosen ?? o.verdict === "chosen",
    };
  });
  const artifact = artifactOf(d);
  const out = {
    trigger: dt.trigger ?? null,
    constraint: dt.constraint ?? null,
    axis: dt.optionAxis ?? null,
    options: options.length ? options : null,
    why: dt.why?.length ? dt.why : null,
    locks: dt.locks && (dt.locks.in || dt.locks.out) ? dt.locks : null,
    artifact: artifact.files.length || artifact.commit ? artifact : null,
  };
  const hasBody = out.trigger || out.constraint || out.options || out.why || out.locks || out.artifact;
  return hasBody ? out : null;
}

// Render the .dd body. `card: true` wraps it as the Trace page's .dd.dd-card
// (accent left border); otherwise it's the bare .dd used inside a Project .fdec.
export function renderDecisionDetail(detail, { card = false } = {}) {
  const parts = [];

  if (detail.trigger || detail.constraint) {
    const frame = h("div", { class: "dd-frame" });
    if (detail.trigger) {
      frame.append(h("span", { class: "lbl" }, t("ui.project.dd.trigger")),
        h("span", { class: "val" }, richText(detail.trigger)));
    }
    if (detail.constraint) {
      frame.append(h("span", { class: "lbl" }, t("ui.project.dd.constraint")),
        h("span", { class: "val" }, richText(detail.constraint)));
    }
    parts.push(frame);
  }

  if (detail.options) {
    parts.push(h("div", {},
      detail.axis
        ? h("div", { class: "dd-axis" },
            t("ui.project.dd.axis", { axis: detail.axis, count: detail.options.length }))
        : null,
      h("div", { class: "dd-options" },
        h("div", { class: "dd-opt-h" },
          h("span", {}, "Option"), h("span", {}, "Approach"), h("span", {}, "Verdict")),
        ...detail.options.map((o) =>
          h("div", { class: `dd-opt${o.chosen ? " chosen" : ""}` },
            h("span", { class: "o-n" }, o.n),
            h("span", { class: "o-ap" }, richText(o.ap)),
            h("span", { class: "o-vd" }, o.vd),
          )),
      ),
    ));
  }

  if (detail.why) {
    parts.push(h("div", { class: "dd-why" },
      h("div", { class: "dd-why-l" }, t("ui.project.dd.why")),
      ...detail.why.map((w) => h("p", {}, richText(w))),
    ));
  }

  if (detail.locks) {
    parts.push(h("div", { class: "dd-locks" },
      h("div", { class: "dd-lock in" },
        h("div", { class: "k" }, t("ui.project.dd.lock_in")),
        detail.locks.in ? h("span", {}, richText(detail.locks.in)) : null),
      h("div", { class: "dd-lock out" },
        h("div", { class: "k" }, t("ui.project.dd.lock_out")),
        detail.locks.out ? h("span", {}, richText(detail.locks.out)) : null),
    ));
  }

  if (detail.artifact) {
    const art = h("div", { class: "dd-artifact" });
    for (const file of detail.artifact.files) {
      art.append(h("span", { class: "lbl" }, file.label || "file"), h("code", {}, file.path));
    }
    if (detail.artifact.commit) {
      art.append(h("span", { class: "lbl" }, "commit"), h("code", {}, detail.artifact.commit));
    }
    parts.push(art);
  }

  return h("div", { class: card ? "dd dd-card" : "dd" }, ...parts);
}
