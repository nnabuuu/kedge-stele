import { readFileSync } from "node:fs";
import type { Decision, Edge, EntityRef, GovLayer, Option, Trigger } from "./types.ts";

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function between(s: string, start: string, end: string): string {
  const i = s.indexOf(start);
  if (i < 0) return "";
  const j = end ? s.indexOf(end, i + start.length) : s.length;
  return s.slice(i + start.length, j < 0 ? s.length : j);
}

function scopeToLayer(_scope: string): GovLayer {
  // Seeded reports are engineering decisions → personal layer in this single-tenant POC.
  return "personal";
}

// Pull cross-references (D-0X / DEF-0X / OQ-0X) out of prose to wire relates-edges.
function refsIn(text: string, selfId: string): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(/\b(D-\d{2}|DEF-\d{2}|OQ-\d{2})\b/g)) {
    if (m[1] !== selfId) ids.add(m[1]);
  }
  return [...ids];
}

const FEATURE: EntityRef = { kind: "feature", id: "ccaas-bootstrap-materialize" };

export function parseReport(htmlPath: string): { decisions: Decision[]; edges: Edge[] } {
  const html = readFileSync(htmlPath, "utf8");
  const at = "2026-06-03T00:00:00Z";
  const sourceReport = htmlPath.split("/").pop() ?? htmlPath;
  const decisions: Decision[] = [];
  const edges: Edge[] = [];

  // ---- DECIDED (D-cards) ----------------------------------------------------
  const decRegion = between(html, "<!-- DECISIONS -->", "<!-- DEFERRED -->");
  const dBlocks = decRegion.split(/<!-- D-\d+ -->/).slice(1);
  for (const block of dBlocks) {
    const id = (block.match(/<div class="d-num">(D-\d+)<\/div>/) || [])[1];
    if (!id) continue;
    const title = stripTags(between(block, "<h3>", "</h3>")).replace(/^问:\s*/, "");
    const scope = stripTags((block.match(/<span class="d-scope[^"]*">([\s\S]*?)<\/span>/) || [])[1] || "");

    const frame = between(block, '<div class="d-frame">', "</div>");
    const framePairs = [...frame.matchAll(/<span class="lbl">([\s\S]*?)<\/span>\s*<span class="val">([\s\S]*?)<\/span>/g)];
    let trigger = "", constraint = "";
    for (const p of framePairs) {
      const lbl = stripTags(p[1]); const val = stripTags(p[2]);
      if (lbl.includes("触发")) trigger = val;
      else if (lbl.includes("约束")) constraint = val;
    }

    const options: Option[] = [];
    for (const o of block.matchAll(/<div class="d-option( chosen)?">([\s\S]*?)<\/div>\s*(?=<div class="d-option|<\/div>)/g)) {
      const chosen = !!o[1];
      const body = o[2];
      const label = stripTags((body.match(/<span class="opt-name">([\s\S]*?)<\/span>/) || [])[1] || "");
      const summary = stripTags((body.match(/<span class="opt-desc">([\s\S]*?)<\/span>/) || [])[1] || "");
      const why = stripTags((body.match(/<span class="opt-verdict">([\s\S]*?)<\/span>/) || [])[1] || "");
      if (label) options.push({ label, summary, verdict: chosen ? "chosen" : "rejected", why });
    }

    const whyBlock = between(block, '<div class="d-why">', "</div>\n      </div>");
    const rationale = [...whyBlock.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => stripTags(m[1])).join(" ");

    const lockIn = stripTags((block.match(/<div class="d-lock in">[\s\S]*?<\/div>([\s\S]*?)<\/div>/) || [])[1] || "");
    const lockOut = stripTags((block.match(/<div class="d-lock out">[\s\S]*?<\/div>([\s\S]*?)<\/div>/) || [])[1] || "");

    const artifactBlock = between(block, '<div class="d-artifact">', "</div>");
    const files = [...artifactBlock.matchAll(/<code>([\s\S]*?)<\/code>/g)]
      .map((m) => stripTags(m[1]))
      .filter((f) => f.includes("/") || f.endsWith(".ts"));
    const affects: EntityRef[] = [FEATURE, ...files.map((f) => ({ kind: "file", id: f }))];

    decisions.push({
      id, title, scope,
      raisedBy: { trigger, actor: "xiaochen", layer: scopeToLayer(scope), session: sourceReport, at },
      constraint,
      status: { kind: "decided", options, rationale },
      consequences: { lockedIn: lockIn, lockedOut: lockOut },
      affects, sourceReport,
    });

    for (const ref of refsIn(rationale + " " + lockIn + " " + lockOut, id)) {
      edges.push({ from: id, to: ref, kind: "relates", note: "seed: referenced in rationale" });
    }
  }

  // ---- DEFERRED + OPEN (dq-cards) ------------------------------------------
  const defRegion = between(html, "<!-- DEFERRED -->", "<!-- OPEN QUESTIONS -->");
  const openRegion = between(html, "<!-- OPEN QUESTIONS -->", "<!-- CHANGE SURFACE -->");

  const parseDq = (region: string, cls: string) => {
    for (const c of region.matchAll(new RegExp(`<div class="dq-card ${cls}">([\\s\\S]*?)<\\/div>\\s*<\\/div>`, "g"))) {
      const body = c[1];
      const id = stripTags((body.match(/<div class="dq-num">([\s\S]*?)<\/div>/) || [])[1] || "");
      const title = stripTags((body.match(/<h4>([\s\S]*?)<\/h4>/) || [])[1] || "");
      const ps = [...body.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => ({
        lbl: stripTags((m[1].match(/<span class="lbl">([\s\S]*?)<\/span>/) || [])[1] || ""),
        text: stripTags(m[1].replace(/<span class="lbl">[\s\S]*?<\/span>/, "")),
      }));
      const pick = (k: string) => ps.find((p) => p.lbl.includes(k))?.text || "";
      if (!id) continue;

      if (cls === "deferred") {
        const reason = pick("推迟理由");
        const revisit = pick("重新审视");
        const trigger: Trigger = /告警|超|profil|metric|GB|磁盘/i.test(revisit)
          ? { kind: "metric", expr: revisit }
          : { kind: "event", name: revisit || "TBD" };
        decisions.push({
          id, title,
          raisedBy: { trigger: pick("现状"), actor: "xiaochen", layer: "personal", session: sourceReport, at },
          status: { kind: "deferred", current: pick("现状"), reason, revisitWhen: trigger },
          affects: [FEATURE], sourceReport,
        });
      } else {
        decisions.push({
          id, title,
          raisedBy: { trigger: pick("问题"), actor: "xiaochen", layer: "personal", session: sourceReport, at },
          status: { kind: "open", question: pick("问题") || title },
          affects: [FEATURE], sourceReport,
        });
        for (const ref of refsIn(pick("为什么") + " " + pick("问题"), id)) {
          edges.push({ from: id, to: ref, kind: "relates", note: "seed: referenced in open question" });
        }
      }
    }
  };
  parseDq(defRegion, "deferred");
  parseDq(openRegion, "open");

  // keep only edges whose endpoints both exist
  const ids = new Set(decisions.map((d) => d.id));
  return { decisions, edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
}
