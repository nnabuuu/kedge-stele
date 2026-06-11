// English translations for stele's web UI.
//
// Flat-key shape; matches the same convention as src/locales/en.ts.
// Grouped by surface-prefix for grep-ability:
//   ui.topbar.*    — shared shell (brand, breadcrumbs, language toggle)
//   ui.states.*    — Feature / Decision state labels (cross-page)
//   ui.relations.* — Edge relation labels (cross-page)
//   ui.sources.*   — Decision.source pill labels (cross-page)
//   ui.projects.*  — Projects page (overview, multi-tenant landing)
//   ui.project.*   — Project page (feature rail + timeline)
//   ui.trace.*     — Trace page (decision provenance)
//   ui.tags.*      — Tags page (tag library + proposals)
//   ui.graph.*     — Decision Graph page
//   ui.common.*    — generic ("loading", "error", buttons used across pages)

export const LOCALES_EN = {
  // ---------------------------------------------------------------------------
  // ui.topbar.* — shared shell
  // ---------------------------------------------------------------------------

  "ui.topbar.projects_link": "Projects",
  "ui.topbar.lang_toggle_label": "Language",

  // ---------------------------------------------------------------------------
  // ui.common.* — strings shared across multiple pages
  // ---------------------------------------------------------------------------

  "ui.common.loading": "loading…",
  "ui.common.page_failed": "page \"{page}\" failed to load · {reason}",

  // ---------------------------------------------------------------------------
  // ui.states.* — Feature.state labels (the 0.3.0 5-state model)
  // ---------------------------------------------------------------------------

  "ui.states.feature.draft": "draft",
  "ui.states.feature.going": "in progress",
  "ui.states.feature.winding": "wrapping up",
  "ui.states.feature.done": "done",
  "ui.states.feature.paused": "paused",

  // Project.status (4-state)
  "ui.states.project.active": "active",
  "ui.states.project.winding": "wrapping up",
  "ui.states.project.dormant": "dormant",
  "ui.states.project.archived": "archived",

  // Decision nodeState (derived; 6-state)
  "ui.states.decision.decided": "decided",
  "ui.states.decision.deferred": "deferred",
  "ui.states.decision.superseded": "superseded",
  "ui.states.decision.resolved": "resolved",
  "ui.states.decision.open": "open",
  "ui.states.decision.conflicted": "conflicted",

  // Session.outcome.type
  "ui.states.outcome.advanced": "advanced",
  "ui.states.outcome.resolved": "resolved",
  "ui.states.outcome.touched": "touched",

  // ---------------------------------------------------------------------------
  // ui.relations.* — Edge.relation labels
  // ---------------------------------------------------------------------------

  "ui.relations.depends_on": "depends on",
  "ui.relations.resolves": "resolves",
  "ui.relations.supersedes": "supersedes",
  "ui.relations.relates": "relates to",
  "ui.relations.reconciles": "reconciles",

  // ---------------------------------------------------------------------------
  // ui.sources.* — Decision.source pill labels
  // ---------------------------------------------------------------------------

  "ui.sources.manual": "manual",
  "ui.sources.agent_live": "live capture",
  "ui.sources.session_extract": "extracted",

  // ---------------------------------------------------------------------------
  // ui.graph.* — Decision Graph page (/<slug>/graph)
  // ---------------------------------------------------------------------------

  "ui.graph.aria_label":
    "Decision graph · {nodes} nodes · {edges} edges",
  "ui.graph.filter_feature_label": "Feature",
  "ui.graph.filter_all": "all",
  "ui.graph.legend_label": "relation",
  "ui.graph.eyebrow": "Decision graph",
  "ui.graph.heading": "decision graph",
  "ui.graph.stat_decisions": "decisions",
  "ui.graph.stat_edges": "edges",
  "ui.graph.stat_features": "features",
  "ui.graph.empty_heading": "this graph is empty",
  "ui.graph.empty_filtered":
    "try clearing the filter, or pick a different feature.",
  "ui.graph.empty_unfiltered_prefix":
    "nothing has been captured yet — run ",
  "ui.graph.empty_unfiltered_suffix":
    " in the project to draft the first one.",
  "ui.graph.highlight_label": "selected",
  "ui.graph.highlight_hint": "click again to open the trace",
  "ui.graph.highlight_clear": "clear",
  "ui.graph.loading": "loading graph…",
  "ui.graph.load_failed": "failed to load graph · {reason}",
};
