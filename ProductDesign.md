# 实录 · Stele · 决策溯源

一个个人用的本地工具,把"决策是怎么发生的"留下来——为什么这么定、否决了什么、推迟了什么、还有什么悬着。primary interface 是一个本地 MCP server,Claude Code 连上去就能读写,无云。

---

## 为什么有这个东西

决策会蒸发。

Git 记录**改了什么**,不记录**为什么改**。Jira / Linear 记录 task,不记录 task 背后的 reasoning——那些被否决的方案、那句"我们先不做 X,等 Y 再说",埋在 comment thread 或者干脆只活在一个聊天窗口里,窗口一关就没了。事后补写的 feature report 是一种**考古**:从有限的对话残渣里把决策刨出来。考古天然有损——跨了几个 session 的决策刨不全,被双方默认敲定的决策残渣最少,而那往往是最重要的那个。

这个工具的前提是:**别考古,在决策发生的当下就记下来。**

而且记录的单位不是"报告",是"决策"本身。

---

## 一个核心的视角转变

**原子是 decision,不是 feature report。**

一个 feature 是一串 decision 串起来的 thread。"推迟做 X" 本身是一个 decision;"X 还没定" 是一个 pending decision;一个 decision 也可能横跨好几个 feature。所以底层存的是一张**决策的图**——节点是 decision,边是它们之间的关系。

report、backlog、resume 这些,**全都是这张图的 projection(投影 / 查询结果),不是独立存储**。这一条是整个设计的支点:

> 因为每个视图都是从图里实时查出来的,所以它们永远不会 stale。

一个具体的例子能说清这件事的价值。假设三周前某次工作里,你记了一条"DEF-02:entity 级联删除,先不做"。三周后另一次工作,你做了个新决策 D-07 把它解决了。你只需要记一条边 `D-07 resolves DEF-02`,然后:

- 那份三周前的旧报告**重新渲染**时,会显示 DEF-02 已解决,并带一条指向 D-07 的链接;
- "还有什么在等我"的列表里,DEF-02 **自动消失**;
- 从 D-07 往回 trace,能看到完整弧线:raised → deferred(理由 + 触发条件)→ resolved by D-07。

没有任何一步需要你手动去翻旧报告改状态。图变了,所有投影跟着变。

---

## 图里有什么

**节点 = 决策。** 每个决策有一个稳定 id,一个用问句表述的标题("worktree 隔离用 per-session 还是 per-feature?",不是"我们选了 per-feature"),触发它的上下文,以及一个状态。状态有六种:

- **open** — 真正还没答案的未知。
- **decided** — 定了。带**所有**权衡过的方案(每个标了选/拒 + 为什么),以及"为什么是这个方案"的 rationale。
- **deferred** — 显式决定**先不做**。带推迟理由,和一个**结构化的**重新审视触发条件(某个指标超阈值 / 某个事件发生 / 依赖另一个决策)——不是一句自由文本,否则系统永远不知道"触发了"。
- **superseded** — 曾经定过,被后来的决策取代。
- **resolved** — 一个曾经 open 或 deferred 的节点,被后来的决策回答了。
- **conflicted** — 两个意图在打架、还没人调和。这是一个 typed 的状态,会自动落进 backlog(当前个人版用不到,但模型里留着)。

**边 = 决策之间的关系。** 主要是 `resolves`(后来的决策解决了一个 pending 的)、`supersedes`(取代)、`relates`(相关)、`reconciles`(调和冲突,云端多人场景才用得上)。

每个决策还可以 `affects` 一组 entity——一个文件、一个 feature、一个 skill。这给了第二种 trace 的入口:不是按时间、而是按"物"来追溯(见下文 resume / trace)。

> **关于 IntentDelta**:模型里每个决策可以带一个 delta,描述它对某个 intent bundle 的具体变更(绑到决策那一刻的 bundle 版本)。当前版本里 delta 是 **captured-but-inert**——记下来,但不做 fold、不做冲突检测(那需要一个 bundle 层,本版本没有)。而且 delta 是 **optional**:只有"修改 intent bundle"的决策才带它;纯代码 / 工具类决策不带,它们的变更全在 `affects` + artifacts 里。别给没有 bundle 的决策硬塞 delta。

---

## capture:你只标记时刻,agent 起草

记录决策不该是填表。

`/decision` 这个命令(给 Claude Code 用)做的事是:你在一个决策刚敲定时输入它,**agent 从当前对话上下文把整条记录草拟出来**——方案、约束、rationale、affects、推迟触发条件,全都从刚才的讨论里抽,然后你只 confirm 或改。

这一点对 ADHD 工作流是刻意的设计:"记得去记录"是最不该依赖的那种 prospective memory。所以 authoring 的劳动全压在 agent 身上,你只负责标"就是这儿"。

捕获时系统还会跑一遍 consolidate:拿新决策去和所有 pending(open / deferred)的节点比,**提议**可能的边——"这条看起来 resolve 了 DEF-02,要不要连?"。注意是**提议、不自动连**,你确认了才生效。所以即使提议错了,也不会污染图。

---

## 两个最重要的视图

这俩是这个工具真正每天在用的东西,尤其对 ADHD 的 re-entry(每次回来重建"我在哪、为什么")。

**resume —— 什么在等我。** 所有 open + 所有还没被 resolve 的 deferred,一次性倒出来。可能到期的(推迟触发条件或已满足)排在最前。这是把脑子里那些悬着的 open loop 全部外化,你不用再靠记。

**trace —— 这件事是怎么发生的。** 给一个东西(一个决策 id,或者一个 entity——某个文件、某个 feature),系统沿图往回走,给你那条 thread:谁提的、当时什么约束、否决了什么、为什么这么选。关键是它是 **associative 的,不是 chronological 的**——你不用从头读流水账,你指着眼前这个东西问"它怎么来的",系统就给你这一条线。按"物"切入比按"时间"切入对 ADHD 友好得多。

---

## 怎么用

**环境**:Node ≥ 22.6(用到 `node:sqlite` 和 TypeScript type stripping)。

**装依赖**:MCP server 用官方 `@modelcontextprotocol/sdk` + `zod`,`npm install` 即可。其余零依赖。

**连 Claude Code**:配置一个 MCP server,command 指向 server 入口。建议在 `NODE_OPTIONS` 里带上 `--experimental-strip-types`——这样任何 Node ≥22.6 都能跑(type stripping 默认开是 22.18 / 23.6 之后的事,带上 flag 就不挑版本)。大致长这样:

```jsonc
{ "mcpServers": { "stele": {
  "command": "node",
  "args": ["/绝对路径/stele/src/mcp.ts"],
  "env": { "NODE_OPTIONS": "--experimental-strip-types --no-warnings" }
}}}
```

**数据落在哪**:默认 `~/.stele/decisions.db`,用环境变量 `STELE_DB` 可覆盖(从 provenance-poc 时代迁来的话,`PROV_DB` 也认,作 back-compat)。别写死任何绝对路径——这是个真踩过的坑。

**四个 MCP tool**:

- `decision_capture` —— 记一个决策。agent 起草全字段。返回 consolidate 提议的边。
- `decision_resume` —— "什么在等我"。可选输出一个 HTML digest。
- `decision_trace` —— 按决策 id(看它在图里的邻域),或按 entity(看所有碰过这个文件 / feature 的决策)。
- `decision_resolve` —— 连一条边。`resolves` 会把目标翻成 RESOLVED(这就是那个跨 session 缝合的动作),`supersedes` 翻成 SUPERSEDED,`relates` 只是连上。

**典型流程**:在 Claude Code 里讨论完一个设计,敲 `/decision` → agent 起草并 capture → 它告诉你它识别的决策、以及有没有 resolve 旧的 deferred 项,你确认 → 下次回来先 `decision_resume` 看有哪些开放回路。

**冷启动**:如果你已经有旧的 feature report,可以一次性 seed 进来当种子节点(把报告里的 D-xx / DEF-xx / OQ-xx 解析成图节点),不用从零累积。

---

## 架构,一句话

**一个 store,多个 adapter,投影都是查询。**

决策图存在 SQLite 里,是唯一的 source of truth。MCP server、命令行、将来可能的本地 app,都只是这个 store 上的 adapter——core(图的读写、consolidate、projection)不知道也不关心自己是被谁调的。这意味着将来如果真要上云,**只换一个 store 实现**,上层一行不动。

图里那个把 `affects` 的 entity 解释成人类可读标签的地方,是唯一一个将来会耦合到外部 ontology 的点。当前是个 stub(直接显示裸 id)。功能完整,只是标签朴素;接了 ontology 就能"指着任何 entity 问它怎么来的"。

**约束几条**(实现时注意):stdout 只走 MCP 协议消息,任何日志走 stderr,否则会污染协议流;DB 默认走 home 目录;consolidate 只提议不自动连边。

---

## 这个工具刻意**不是**什么

定位是**个人工具、本地、无云**。下面这些是显式推迟的——不是忘了,是判断现在做没收益。每条都带重新审视的触发条件(这个工具也吃自己的狗粮,这些就是它自己的 deferred 决策):

- **IntentDelta 的 fold + 冲突检测** —— delta 现在只记不算。触发:有了 bundle 层之后。
- **云 / 多租户 / governance 分层 / 读 ACL** —— 全部砍掉,这是个人工具。触发:真有多人 / 机构记忆需求时(那会是一个区教育局一个隔离实例的形态,不是现在)。
- **本地 ↔ 云 sync** —— 单人单机,不存在并发 merge。触发:有人要离线编辑 + 回连合并。(注意:别拿图里的 reconcile 机制去做 sync 的 merge——sync 是 row 级冲突,reconcile 是 intent 级,混在一起会把两个系统都搞脏。)
- **更聪明的 consolidate** —— 当前提议边用的是关键词重叠,糙。触发:误报率高到你嫌烦时,换成一个独立的 Evaluator agent 来判 resolves / relates。

---

## 一条验收路径

实现完了,这条端到端能跑通就算成立:

1. seed 一份现有 report → 图里有了一批 decided / deferred / open 节点。
2. capture 一个新决策,带一条 `resolves` 边指向某个旧的 deferred 项。
3. `decision_resume` —— 那个 deferred 项**自动从列表里消失了**。
4. `decision_trace` 那个 deferred 项 —— 显示完整弧线:raised → deferred → resolved by(新决策)。
5. `decision_trace` 按某个文件 entity —— 拉出所有碰过它的决策,**包括来自不同 session 的**。