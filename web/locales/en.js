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

  // ---------------------------------------------------------------------------
  // ui.tags.* — Tags page (/<slug>/tags)
  // ---------------------------------------------------------------------------

  "ui.tags.eyebrow": "Tag library",
  "ui.tags.heading": "tags",
  "ui.tags.count_active": "in use",
  "ui.tags.count_pending": "pending",
  "ui.tags.count_archived": "archived",
  "ui.tags.policy_section_label": "local policy · who can create new tags",
  "ui.tags.policy_section_hint":
    "stored in .stele/decisions.db · stays on this machine",
  "ui.tags.policy.auto.label": "auto add",
  "ui.tags.policy.auto.desc":
    "agent-proposed tags land immediately; you can review them after. Easiest, but lookalikes accumulate.",
  "ui.tags.policy.propose.label": "needs review",
  "ui.tags.policy.propose.desc":
    "agent proposes; you confirm one by one. Manual gate, good when starting out.",
  "ui.tags.policy.locked.label": "existing only",
  "ui.tags.policy.locked.desc":
    "library locked. Agents can only re-use existing tags; new proposals are blocked.",
  "ui.tags.policy.default_badge": "default",
  "ui.tags.policy.require_reason_title":
    "require a reason before adopting",
  "ui.tags.policy.require_reason_desc":
    "When proposing a new tag, the agent must explain why existing tags aren't enough.",
  "ui.tags.pending_section_label": "pending / proposed",
  "ui.tags.pending_banner_propose_prefix": "Current mode: ",
  "ui.tags.pending_banner_propose_strong": "needs review",
  "ui.tags.pending_banner_propose_suffix":
    " — the proposals below need your confirmation to enter the library.",
  "ui.tags.pending_banner_auto_prefix": "Current mode: ",
  "ui.tags.pending_banner_auto_strong": "auto add",
  "ui.tags.pending_banner_auto_suffix":
    " — agent-created tags landed directly; this is just for review.",
  "ui.tags.pending_banner_locked_prefix": "Current mode: ",
  "ui.tags.pending_banner_locked_strong": "existing only",
  "ui.tags.pending_banner_locked_suffix":
    " — these proposals were blocked. You can grant an exception, or just leave them on record.",
  "ui.tags.pending_no_reason": "(no reason given)",
  "ui.tags.pending_targets": " · planned for {count} target(s)",
  "ui.tags.pending_action_confirm": "adopt",
  "ui.tags.pending_action_reject": "reject",
  "ui.tags.library_section_label": "tags in use",
  "ui.tags.library_section_hint":
    "click swatch to recolor · hover for actions",
  "ui.tags.library_empty":
    "no tags yet — tags that the agent identifies during /stele:feature show up here.",
  "ui.tags.row_recolor_title": "recolor",
  "ui.tags.row_count": " in use",
  "ui.tags.row_kind_fallback": "scope",
  "ui.tags.row_origin_agent": "agent",
  "ui.tags.row_origin_you": "you",
  "ui.tags.row_action_rename": "rename",
  "ui.tags.row_action_archive": "archive",
  "ui.tags.row_action_restore": "restore",
  "ui.tags.rename_prompt": "new name",
  "ui.tags.archive_confirm":
    "archive \"{name}\"? existing taggings are preserved.",
  "ui.tags.archived_summary": "archived · {count}",
  "ui.tags.no_date": "—",

  // Toast messages
  "ui.tags.toast.policy_changed": "policy → {label}",
  "ui.tags.toast.policy_change_failed": "policy change failed · {reason}",
  "ui.tags.toast.require_reason_on": "agent must give a reason",
  "ui.tags.toast.require_reason_off": "reason no longer required",
  "ui.tags.toast.setting_change_failed":
    "setting change failed · {reason}",
  "ui.tags.toast.confirmed": "adopted · {name}",
  "ui.tags.toast.confirm_failed": "adopt failed · {reason}",
  "ui.tags.toast.rejected": "rejected · {name}",
  "ui.tags.toast.reject_failed": "reject failed · {reason}",
  "ui.tags.toast.renamed": "renamed · {name}",
  "ui.tags.toast.rename_failed": "rename failed · {reason}",
  "ui.tags.toast.recolored": "swatch updated",
  "ui.tags.toast.recolor_failed": "recolor failed · {reason}",
  "ui.tags.toast.archived": "archived · {name}",
  "ui.tags.toast.archive_failed": "archive failed · {reason}",
  "ui.tags.toast.restored": "restored · {name}",
  "ui.tags.toast.restore_failed": "restore failed · {reason}",
  "ui.tags.loading": "loading tags…",
  "ui.tags.load_failed": "failed to load tags · {reason}",

  // ---------------------------------------------------------------------------
  // ui.projects.* — Projects page (/ — multi-project overview)
  // Page-specific labels live here even when overlapping with ui.states.* —
  // the design mock's vocabulary in this view is independently editable, so
  // we keep the keys local rather than rebinding the shared enums.
  // ---------------------------------------------------------------------------

  "ui.projects.status.active": "in progress",
  "ui.projects.status.winding": "wrapping up",
  "ui.projects.status.dormant": "dormant",
  "ui.projects.status.archived": "archived",
  "ui.projects.ft.draft": "draft",
  "ui.projects.ft.going": "going",
  "ui.projects.ft.winding": "wrapping up",
  "ui.projects.ft.done": "done",
  "ui.projects.ft.paused": "paused",
  "ui.projects.outcome.advanced": "advanced",
  "ui.projects.outcome.resolved": "resolved",
  "ui.projects.outcome.touched": "touched",
  "ui.projects.sort.recent": "most recent",
  "ui.projects.sort.due": "needs attention first",
  "ui.projects.sort.loops": "most open loops",
  "ui.projects.resume.eyebrow": "continue last conversation",
  "ui.projects.resume.last_active": "last active {when}",
  "ui.projects.resume.lead": "last touched on",
  "ui.projects.resume.open_project": "open project →",
  "ui.projects.card.flag_recent": "most recent conversation",
  "ui.projects.card.archived": "archived project",
  "ui.projects.card.missing_db": ".stele/decisions.db unreadable",
  "ui.projects.card.missing_path":
    "{path} · .stele/ missing or unreadable",
  "ui.projects.card.no_feature": "no feature yet",
  "ui.projects.card.section_features":
    "feature · each accumulated from multiple conversations",
  "ui.projects.card.section_archived": "archive destination",
  "ui.projects.card.section_status": "status",
  "ui.projects.card.foot_open": "open",
  "ui.projects.card.foot_due": "due",
  "ui.projects.card.foot_features": "feature",
  "ui.projects.card.foot_done": "done",
  "ui.projects.card.cta": "enter →",
  "ui.projects.feature_row.last_label": "last",
  "ui.projects.shelf.heading": "projects on file",
  "ui.projects.shelf.sub":
    "{live} in progress · {total} on file",
  "ui.projects.tuck.collapse": "collapse dormant / archived",
  "ui.projects.tuck.expand": "dormant / archived ",
  "ui.projects.shelf_foot.projects": "projects on file",
  "ui.projects.shelf_foot.loops": "open loops",
  "ui.projects.shelf_foot.due": "items needing attention",
  "ui.projects.shelf_foot.tagline":
    "Every view is queried live from the graph — change the graph, this view follows.",
  "ui.projects.empty.eyebrow": "No projects",
  "ui.projects.empty.heading": "no projects on file yet",
  "ui.projects.empty.hint_p1": "in any project root, run ",
  "ui.projects.empty.hint_p2": " to register it in ",
  "ui.projects.empty.hint_p3":
    ". Registered projects show up here.",
  "ui.projects.date.today": "today",
  "ui.projects.date.yesterday": "yesterday",
  "ui.projects.date.last_week": "last week",
  "ui.projects.date.days_ago": "{count} days ago",
  "ui.projects.date.weeks_ago": "{count} weeks ago",
  "ui.projects.date.months_ago": "{count} months ago",
  "ui.projects.date.unknown": "—",
  "ui.projects.loading": "loading projects…",
  "ui.projects.load_failed":
    "failed to load /api/projects · {reason}",

  // ---------------------------------------------------------------------------
  // ui.project.* — single Project page (/<slug>/)
  // Reuses ui.projects.status.* / ui.projects.ft.* / ui.projects.outcome.*
  // for the shared enum vocabulary.
  // ---------------------------------------------------------------------------

  "ui.project.node_state.decision": "decided",
  "ui.project.node_state.deferred": "deferred",
  "ui.project.node_state.open": "open",
  "ui.project.node_state.resolved": "resolved",
  "ui.project.node_state.superseded": "superseded",
  "ui.project.source.agent_live": "agent · live",
  "ui.project.source.session_extract": "agent · post-hoc",
  "ui.project.source.manual": "manual",
  "ui.project.rail.heading": "feature",
  "ui.project.rail.count": "{count}",
  "ui.project.rail.empty_filtered":
    "no feature matches these tags",
  "ui.project.rail.empty_unfiltered":
    "no feature — try running /stele:feature in this project",
  "ui.project.rail.tag_filter_label": "filter by tag",
  "ui.project.rail.tag_filter_clear": "clear",
  "ui.project.rail.tag_more": "more {count}",
  "ui.project.rail.tag_collapse": "collapse",
  "ui.project.rail.feature_sessions": "{count} conversations",
  "ui.project.rail.feature_last_activity": "· last {when}",
  "ui.project.main.no_selection_heading": "no feature selected",
  "ui.project.main.no_selection_hint":
    "pick one on the left, or run /stele:feature to create one.",
  "ui.project.main.rolling_summary_lead": "rolling summary",
  "ui.project.main.stat_sessions": "conversations accumulated",
  "ui.project.main.stat_decisions": "decisions",
  "ui.project.main.stat_last": "last {when}",
  "ui.project.timeline.eyebrow": "conversation timeline",
  "ui.project.timeline.hint":
    "· this feature accumulated across {count} conversations",
  "ui.project.timeline.sub":
    "Each conversation pushes forward a bit; decisions settle below. Click a decision to open its trace.",
  "ui.project.timeline.empty":
    "no sessions yet — run /stele:feature under this feature to start.",
  "ui.project.source_filter.label": "filtering by source: ",
  "ui.project.source_filter.clear": "clear filter ✕",
  "ui.project.resume.eyebrow": "continue last conversation",
  "ui.project.resume.when": "session #{n} · {when} · {ago}",
  "ui.project.resume.lead": "last touched on",
  "ui.project.resume.no_ccid": "no source session id",
  "ui.project.session.label": "session #{n}",
  "ui.project.session.latest_badge": "most recent",
  "ui.project.decisions.label":
    "decisions from this conversation · {count}",
  "ui.project.decision.source_title":
    "source: {label}{conf}",
  "ui.project.decision.confidence_suffix": ", confidence{conf}",
  "ui.project.empty.eyebrow": "No features yet",
  "ui.project.empty.heading": "this project has no feature yet",
  "ui.project.empty.hint_p1": "in the project root, run ",
  "ui.project.empty.hint_p2": " to install the hooks, then use ",
  "ui.project.empty.hint_p3":
    " to draft your first decision — features will appear automatically.",
  "ui.project.loading": "loading project…",
  "ui.project.load_failed": "failed to load project · {reason}",
};
