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

  // ---------------------------------------------------------------------------
  // ui.graph.* — Decision Graph 页面 (/<slug>/graph)
  // ---------------------------------------------------------------------------

  "ui.graph.aria_label":
    "决策图 · {nodes} 个节点 · {edges} 条边",
  "ui.graph.filter_feature_label": "Feature",
  "ui.graph.filter_all": "全部",
  "ui.graph.legend_label": "关系",
  "ui.graph.eyebrow": "Decision graph",
  "ui.graph.heading": "决策图",
  "ui.graph.stat_decisions": "决定",
  "ui.graph.stat_edges": "边",
  "ui.graph.stat_features": "feature",
  "ui.graph.empty_heading": "这片图是空的",
  "ui.graph.empty_filtered":
    "试试清掉过滤器,或选别的 feature。",
  "ui.graph.empty_unfiltered_prefix":
    "还没有决策在记录 —— 在项目里跑 ",
  "ui.graph.empty_unfiltered_suffix":
    " 起草第一条。",
  "ui.graph.highlight_label": "选中",
  "ui.graph.highlight_hint": "再点一次进溯源",
  "ui.graph.highlight_clear": "清除",
  "ui.graph.loading": "加载决策图…",
  "ui.graph.load_failed": "加载决策图失败 · {reason}",

  // ---------------------------------------------------------------------------
  // ui.tags.* — Tags 页面 (/<slug>/tags)
  // ---------------------------------------------------------------------------

  "ui.tags.eyebrow": "Tag library",
  "ui.tags.heading": "标签",
  "ui.tags.count_active": "在用",
  "ui.tags.count_pending": "待确认",
  "ui.tags.count_archived": "已归档",
  "ui.tags.policy_section_label": "本地策略 · 谁能建新标签",
  "ui.tags.policy_section_hint":
    "存在 .stele/decisions.db · 不出本机",
  "ui.tags.policy.auto.label": "自动新增",
  "ui.tags.policy.auto.desc":
    "agent 提的新标签自动生效,事后能看到。最轻松,但容易积出近义标签。",
  "ui.tags.policy.propose.label": "提议待确认",
  "ui.tags.policy.propose.desc":
    "agent 提议,你逐条确认。手动把关,适合开始阶段。",
  "ui.tags.policy.locked.label": "仅用现有",
  "ui.tags.policy.locked.desc":
    "标签库锁定。agent 只能用已有标签,新提议被拦下。",
  "ui.tags.policy.default_badge": "默认",
  "ui.tags.policy.require_reason_title":
    "采用前要 agent 说明理由",
  "ui.tags.policy.require_reason_desc":
    "提议新标签时,agent 必须附上「为什么现有标签不够用」。",
  "ui.tags.pending_section_label": "待确认 / 提议",
  "ui.tags.pending_banner_propose_prefix": "当前是",
  "ui.tags.pending_banner_propose_strong": "「提议待确认」",
  "ui.tags.pending_banner_propose_suffix":
    ": 下面的新标签需要你逐个确认才进标签库。",
  "ui.tags.pending_banner_auto_prefix": "当前是",
  "ui.tags.pending_banner_auto_strong": "「自动新增」",
  "ui.tags.pending_banner_auto_suffix":
    ": agent 建的标签直接生效,这里只是回看。",
  "ui.tags.pending_banner_locked_prefix": "当前是",
  "ui.tags.pending_banner_locked_strong": "「仅用现有」",
  "ui.tags.pending_banner_locked_suffix":
    ": 这些是被拦下的提议。你可以破例采用,或让它们就这么记着。",
  "ui.tags.pending_no_reason": "(没有附上理由)",
  "ui.tags.pending_targets": " · 计划应用到 {count} 个目标",
  "ui.tags.pending_action_confirm": "采用",
  "ui.tags.pending_action_reject": "驳回",
  "ui.tags.library_section_label": "在用的标签",
  "ui.tags.library_section_hint":
    "点色块改色 · 悬停看操作",
  "ui.tags.library_empty":
    "还没有标签 —— agent 在 /stele:feature 流程里识别到的标签会出现在这里。",
  "ui.tags.row_recolor_title": "改色",
  "ui.tags.row_count": " 处在用",
  "ui.tags.row_kind_fallback": "scope",
  "ui.tags.row_origin_agent": "agent",
  "ui.tags.row_origin_you": "你",
  "ui.tags.row_action_rename": "改名",
  "ui.tags.row_action_archive": "归档",
  "ui.tags.row_action_restore": "恢复",
  "ui.tags.rename_prompt": "新名字",
  "ui.tags.archive_confirm":
    "归档 \"{name}\"? 已经打过的标记不会被清除。",
  "ui.tags.archived_summary": "已归档 · {count}",
  "ui.tags.no_date": "—",

  // Toast 消息
  "ui.tags.toast.policy_changed": "策略 → {label}",
  "ui.tags.toast.policy_change_failed": "改策略失败 · {reason}",
  "ui.tags.toast.require_reason_on": "要求 agent 附上理由",
  "ui.tags.toast.require_reason_off": "不强制理由",
  "ui.tags.toast.setting_change_failed":
    "改设置失败 · {reason}",
  "ui.tags.toast.confirmed": "采用 · {name}",
  "ui.tags.toast.confirm_failed": "采用失败 · {reason}",
  "ui.tags.toast.rejected": "驳回 · {name}",
  "ui.tags.toast.reject_failed": "驳回失败 · {reason}",
  "ui.tags.toast.renamed": "重命名 · {name}",
  "ui.tags.toast.rename_failed": "改名失败 · {reason}",
  "ui.tags.toast.recolored": "色块已更新",
  "ui.tags.toast.recolor_failed": "改色失败 · {reason}",
  "ui.tags.toast.archived": "已归档 · {name}",
  "ui.tags.toast.archive_failed": "归档失败 · {reason}",
  "ui.tags.toast.restored": "已恢复 · {name}",
  "ui.tags.toast.restore_failed": "恢复失败 · {reason}",
  "ui.tags.loading": "加载标签…",
  "ui.tags.load_failed": "加载标签失败 · {reason}",

  // ---------------------------------------------------------------------------
  // ui.projects.* — Projects 页面 (/ — 多项目总览)
  // ---------------------------------------------------------------------------

  "ui.projects.status.active": "推进中",
  "ui.projects.status.winding": "收尾中",
  "ui.projects.status.dormant": "搁置中",
  "ui.projects.status.archived": "已归档",
  "ui.projects.ft.draft": "草稿",
  "ui.projects.ft.going": "进行中",
  "ui.projects.ft.winding": "收尾",
  "ui.projects.ft.done": "已完成",
  "ui.projects.ft.paused": "搁置",
  "ui.projects.outcome.advanced": "推进",
  "ui.projects.outcome.resolved": "解决",
  "ui.projects.outcome.touched": "补充",
  "ui.projects.sort.recent": "最近的对话",
  "ui.projects.sort.due": "待关注优先",
  "ui.projects.sort.loops": "未闭合最多",
  "ui.projects.resume.eyebrow": "继续上次的对话",
  "ui.projects.resume.last_active": "最近活跃 {when}",
  "ui.projects.resume.lead": "上次聊到",
  "ui.projects.resume.open_project": "进入项目 →",
  "ui.projects.card.flag_recent": "最近一次对话",
  "ui.projects.card.archived": "已归档项目",
  "ui.projects.card.missing_db": ".stele/decisions.db 不可读",
  "ui.projects.card.missing_path":
    "{path} · .stele/ 不存在或不可读",
  "ui.projects.card.no_feature": "还没有 feature",
  "ui.projects.card.section_features":
    "feature · 各自由多次对话累积",
  "ui.projects.card.section_archived": "归档去向",
  "ui.projects.card.section_status": "状态",
  "ui.projects.card.foot_open": "未闭合",
  "ui.projects.card.foot_due": "待关注",
  "ui.projects.card.foot_features": "feature",
  "ui.projects.card.foot_done": "完成",
  "ui.projects.card.cta": "进入 →",
  "ui.projects.feature_row.last_label": "上次",
  "ui.projects.shelf.heading": "在记录的 project",
  "ui.projects.shelf.sub":
    "{live} 个在推进 · {total} 个在记录",
  "ui.projects.tuck.collapse": "收起搁置 / 归档",
  "ui.projects.tuck.expand": "搁置 / 归档 ",
  "ui.projects.shelf_foot.projects": "个 project 在记录",
  "ui.projects.shelf_foot.loops": "个未闭合回路",
  "ui.projects.shelf_foot.due": "项待关注",
  "ui.projects.shelf_foot.tagline":
    "视图都是当场从图里查的 —— 图一变,这屏就跟着变。",
  "ui.projects.empty.eyebrow": "No projects",
  "ui.projects.empty.heading": "还没有项目在记录",
  "ui.projects.empty.hint_p1": "在任意项目根目录跑 ",
  "ui.projects.empty.hint_p2": " 把它注册到 ",
  "ui.projects.empty.hint_p3":
    "。装好的项目会出现在这里。",
  "ui.projects.date.today": "今天",
  "ui.projects.date.yesterday": "昨天",
  "ui.projects.date.last_week": "上周",
  "ui.projects.date.days_ago": "{count} 天前",
  "ui.projects.date.weeks_ago": "{count} 周前",
  "ui.projects.date.months_ago": "{count} 个月前",
  "ui.projects.date.unknown": "—",
  "ui.projects.loading": "加载项目中…",
  "ui.projects.load_failed":
    "加载 /api/projects 失败 · {reason}",

  // ---------------------------------------------------------------------------
  // ui.project.* — 单项目 Project 页面 (/<slug>/)
  // ---------------------------------------------------------------------------

  "ui.project.node_state.decision": "已定",
  "ui.project.node_state.deferred": "已推迟",
  "ui.project.node_state.open": "悬而未决",
  "ui.project.node_state.resolved": "已解决",
  "ui.project.node_state.superseded": "被取代",
  "ui.project.source.agent_live": "agent · live",
  "ui.project.source.session_extract": "agent · post-hoc",
  "ui.project.source.manual": "manual",
  "ui.project.rail.heading": "feature",
  "ui.project.rail.count": "{count} 个",
  "ui.project.rail.empty_filtered":
    "没有匹配这些标签的 feature",
  "ui.project.rail.empty_unfiltered":
    "没有 feature —— 试试在这个项目里跑 /stele:feature",
  "ui.project.rail.tag_filter_label": "按标签筛选",
  "ui.project.rail.tag_filter_clear": "清除",
  "ui.project.rail.tag_more": "更多 {count}",
  "ui.project.rail.tag_collapse": "收起",
  "ui.project.rail.feature_sessions": "{count} 次对话",
  "ui.project.rail.feature_last_activity": "· 最近 {when}",
  "ui.project.main.no_selection_heading": "没有选中 feature",
  "ui.project.main.no_selection_hint":
    "在左边选一个,或者跑 /stele:feature 创建。",
  "ui.project.main.rolling_summary_lead": "rolling summary",
  "ui.project.main.stat_sessions": "次对话",
  "ui.project.main.stat_decisions": "个决定",
  "ui.project.main.stat_last": "最近 {when}",
  "ui.project.timeline.eyebrow": "对话时间线",
  "ui.project.timeline.hint":
    "· 这个 feature 由 {count} 次对话累积而成",
  "ui.project.timeline.sub":
    "每一次对话推进一点,沉淀出下面的决定。点决定可进溯源图看它的来历。",
  "ui.project.timeline.empty":
    "还没有 session —— 在这个 feature 下跑 /stele:feature 开始。",
  "ui.project.source_filter.label": "正在按来源筛选: ",
  "ui.project.source_filter.clear": "清除筛选 ✕",
  "ui.project.resume.eyebrow": "继续上次的对话",
  "ui.project.resume.when": "第 {n} 次 · {when} · {ago}",
  "ui.project.resume.lead": "上次聊到",
  "ui.project.resume.no_ccid": "no source session id",
  "ui.project.session.label": "第 {n} 次",
  "ui.project.session.latest_badge": "最近",
  "ui.project.session.block_label": "第 {n} 次对话",
  "ui.project.session.latest_tag": "最近一次",
  "ui.project.session.core_latest": "上次聊到",
  "ui.project.session.core_label": "这次聊定的核心",
  "ui.project.bucket.dec": "决定",
  "ui.project.bucket.def": "推迟",
  "ui.project.bucket.oq": "待解的问题",
  "ui.project.dd.trigger": "触发",
  "ui.project.dd.constraint": "约束",
  "ui.project.dd.axis": "沿「{axis}」权衡 · {count} 个方案",
  "ui.project.dd.why": "为什么这么选",
  "ui.project.dd.lock_in": "Locked in · 锁进了",
  "ui.project.dd.lock_out": "Locked out · 锁出了",
  "ui.project.dd.overridden": "已被后面的决定覆盖,详情从略。",
  "ui.project.dd.unarchived": "这条决定的完整取舍还没归档。",
  "ui.project.dd.trace_link": "在溯源图看它的来历",
  "ui.project.dd.trace_link_short": "溯源图",
  "ui.project.decisions.label":
    "这次对话产出的决定 · {count}",
  "ui.project.decision.source_title":
    "源: {label}{conf}",
  "ui.project.decision.confidence_suffix": ", 置信度{conf}",
  "ui.project.empty.eyebrow": "No features yet",
  "ui.project.empty.heading": "这个项目还没有 feature",
  "ui.project.empty.hint_p1": "在项目根目录跑 ",
  "ui.project.empty.hint_p2": " 装好钩子,然后用 ",
  "ui.project.empty.hint_p3":
    " 起草第一个决策 —— feature 会自动出现。",
  "ui.project.loading": "加载项目中…",
  "ui.project.load_failed": "加载项目失败 · {reason}",

  // ---------------------------------------------------------------------------
  // ui.trace.* — Trace 页面 (/<slug>/d/<fid>/<localId>)
  // ---------------------------------------------------------------------------

  "ui.trace.node_state.decided": "已决",
  "ui.trace.node_state.deferred": "推迟",
  "ui.trace.node_state.resolved": "已解决",
  "ui.trace.node_state.superseded": "已被取代",
  "ui.trace.node_state.open": "待决",
  "ui.trace.node_state.conflicted": "有冲突",
  // Relation table
  "ui.trace.rel.resolves.label": "解决了",
  "ui.trace.rel.resolves.section": "这条决定关闭了",
  "ui.trace.rel.resolves.hint": "本条把它们闭合",
  "ui.trace.rel.resolvedBy.label": "被解决",
  "ui.trace.rel.resolvedBy.section": "被这条收尾",
  "ui.trace.rel.resolvedBy.hint": "这些决定关闭了本条",
  "ui.trace.rel.depends_on.label": "依赖",
  "ui.trace.rel.depends_on.section": "依赖",
  "ui.trace.rel.depends_on.hint": "本条建立在它们之上",
  "ui.trace.rel.depended_on.label": "被依赖",
  "ui.trace.rel.depended_on.section": "被依赖",
  "ui.trace.rel.depended_on.hint": "这些决定建立在本条之上",
  "ui.trace.rel.relates.label": "相关",
  "ui.trace.rel.relates.section": "相关",
  "ui.trace.rel.relates.hint": "话题相关的决定",
  "ui.trace.rel.supersedes.label": "取代了",
  "ui.trace.rel.supersedes.section": "取代",
  "ui.trace.rel.supersedes.hint": "本条把它们替换掉",
  "ui.trace.rel.supersededBy.label": "被取代",
  "ui.trace.rel.supersededBy.section": "被取代",
  "ui.trace.rel.supersededBy.hint": "这些决定取代了本条",
  "ui.trace.rel.reconciles.label": "调和",
  "ui.trace.rel.reconciles.section": "调和",
  "ui.trace.rel.reconciles.hint": "把它们的冲突调和",
  // Focal card
  "ui.trace.focal.trigger_label": " 触发: ",
  // Why section
  "ui.trace.why.eyebrow": "为什么这么定",
  "ui.trace.why.sub":
    "不只是结论,还有当时权衡过哪几个方案、选了哪个、拒了哪个。",
  "ui.trace.why.summary":
    "取舍全文 · 触发 / 方案 / 理由 / 锁进锁出",
  "ui.trace.why.k.trigger": "触发",
  "ui.trace.why.k.constraint": "约束",
  "ui.trace.why.k.options": "方案",
  "ui.trace.why.k.reasons": "理由",
  "ui.trace.why.k.locks": "锁进 / 锁出",
  "ui.trace.why.option_axis":
    "沿「{axis}」权衡 · {count} 个选项",
  "ui.trace.why.lock_in_k": "锁进了",
  "ui.trace.why.lock_out_k": "锁出了",
  // Picker + section headers (rebuild)
  "ui.trace.picker.label": "选一条决定",
  "ui.trace.picker.ty.decision": "决定",
  "ui.trace.picker.ty.deferred": "推迟",
  "ui.trace.picker.ty.open": "待问",
  "ui.trace.sec.lifecycle": "状态变化",
  "ui.trace.sec.tradeoffs": "取舍",
  "ui.trace.sec.related": "相关决定",
  "ui.trace.sec.affects": "牵动到的",
  // Stitch
  "ui.trace.stitch.eyebrow": "跨对话缝合",
  "ui.trace.stitch.sub":
    "在另一次对话里被接上的那条边",
  "ui.trace.stitch.older": "原本悬挂",
  "ui.trace.stitch.newer": "在这次会话里被收掉",
  "ui.trace.stitch.arrow_tip": "resolves",
  "ui.trace.stitch.days_after": "{count} 天后",
  "ui.trace.stitch.note_prefix": "记下:",
  "ui.trace.stitch.self": "本条 · {id}",
  "ui.trace.stitch.rel_resolved_by": "被解决于",
  "ui.trace.stitch.rel_resolves": "解决了",
  "ui.trace.stitch.say_resolved_by":
    "这条当时<b>没就地解决</b>,后来在另一次对话里被下面这条决定收掉 —— status 翻成「<mark class=\"good\">已解决</mark>」。",
  "ui.trace.stitch.say_resolves":
    "这条决定回头收掉了之前挂起的悬案 —— 它们的 status 因此翻成「<mark class=\"good\">已解决</mark>」。",
  // Arc
  "ui.trace.arc.eyebrow": "状态变化",
  "ui.trace.arc.sub": "按时间排开,每一步都来自一次对话",
  "ui.trace.arc.stage.raised": "提出",
  "ui.trace.arc.stage.decided": "定下",
  "ui.trace.arc.stage.deferred": "推迟",
  "ui.trace.arc.stage.open": "悬而未决",
  "ui.trace.arc.stage.resolved": "解决",
  "ui.trace.arc.resolver_prefix": "被 ",
  "ui.trace.arc.resolver_suffix": " 解决",
  "ui.trace.arc.date_session": "{date} · 第 {n} 次",
  "ui.trace.arc.span": "悬 {from} → {to}",
  "ui.trace.arc.seg_hung": "悬了 {days} 天",
  // Neighbors
  "ui.trace.neighbors.empty":
    "这条决定还没有连接到别的决定 —— 没有传入/传出的边。",
  // Affects
  "ui.trace.affects.eyebrow": "相关文件",
  "ui.trace.affects.count_suffix": "· {count} 个实体",
  // Page-level
  "ui.trace.loading": "加载决策中…",
  "ui.trace.missing_url": "URL 中缺少 decision id",
  "ui.trace.load_failed": "加载决策失败 · {reason}",
  "ui.trace.not_found_eyebrow": "Not found",
  "ui.trace.not_found_heading": "决定 {fid}/{did} 不存在",
  "ui.trace.not_found_hint":
    "可能是 id 拼错了,或者它还没在本地库里。",
  "ui.trace.back_to_projects": "← 项目",

  // ---------------------------------------------------------------------------
  // ui.resume.* — 共享的 ResumeLauncher 组件
  // ---------------------------------------------------------------------------

  "ui.resume.btn": "继续这次对话",
  "ui.resume.loading": "…",
  "ui.resume.fetch_failed": "无法获取恢复命令",
  "ui.resume.label_jump": "回到正在运行的会话",
  "ui.resume.label_rebuild": "复制并运行以继续这次对话",
  "ui.resume.copy": "复制",
  "ui.resume.copied": "已复制 ✓",
  "ui.resume.copy_failed": "复制失败",
};
