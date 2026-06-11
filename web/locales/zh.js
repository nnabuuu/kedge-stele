// Chinese (zh-CN) translations for stele's web UI.
//
// Keys must mirror src/locales/en.ts and web/locales/en.js exactly.
// Tone: 简练、可读、技术术语保留原样 (Feature / Decision / Session /
// nodeState / Stele / slug — these stay verbatim). Match the
// existing CN-design-mock tone where pre-0.5.0 web SPA already uses
// CN labels — borrow that vocabulary so the UI feels continuous.

export const LOCALES_ZH = {
  // ---------------------------------------------------------------------------
  // ui.topbar.* — 共享外壳
  // ---------------------------------------------------------------------------

  "ui.topbar.projects_link": "项目",
  "ui.topbar.lang_toggle_label": "语言",

  // ---------------------------------------------------------------------------
  // ui.common.*
  // ---------------------------------------------------------------------------

  "ui.common.loading": "加载中…",
  "ui.common.page_failed": "\"{page}\" 页面加载失败 · {reason}",

  // ---------------------------------------------------------------------------
  // ui.states.* — Feature.state (0.3.0 五状态)
  // ---------------------------------------------------------------------------

  "ui.states.feature.draft": "草稿",
  "ui.states.feature.going": "推进中",
  "ui.states.feature.winding": "收尾",
  "ui.states.feature.done": "已完成",
  "ui.states.feature.paused": "暂停",

  // Project.status
  "ui.states.project.active": "活跃",
  "ui.states.project.winding": "收尾",
  "ui.states.project.dormant": "休眠",
  "ui.states.project.archived": "归档",

  // Decision nodeState
  "ui.states.decision.decided": "已决",
  "ui.states.decision.deferred": "搁置",
  "ui.states.decision.superseded": "已被取代",
  "ui.states.decision.resolved": "已解决",
  "ui.states.decision.open": "未决",
  "ui.states.decision.conflicted": "冲突",

  // Session.outcome.type
  "ui.states.outcome.advanced": "推进",
  "ui.states.outcome.resolved": "解决",
  "ui.states.outcome.touched": "触及",

  // ---------------------------------------------------------------------------
  // ui.relations.* — Edge.relation
  // ---------------------------------------------------------------------------

  "ui.relations.depends_on": "依赖",
  "ui.relations.resolves": "解决",
  "ui.relations.supersedes": "取代",
  "ui.relations.relates": "相关",
  "ui.relations.reconciles": "调和",

  // ---------------------------------------------------------------------------
  // ui.sources.* — Decision.source pill labels
  // ---------------------------------------------------------------------------

  "ui.sources.manual": "手动",
  "ui.sources.agent_live": "实时捕获",
  "ui.sources.session_extract": "事后提取",
};
