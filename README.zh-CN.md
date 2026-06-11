# 实录 · Stele

[English](./README.md) · **中文**

> *决策定下时即刻刻入,日后皆可追溯。*

> **当前版本: 0.5.0** —— CLI 和 Web UI 双语化 (中英文 + topbar 切换器 +
> 从环境自动检测),在 0.4.x 三层自动捕获之上。Schema 相对 0.3.0 仅做
> 增量(老库可直接打开);agent 调用面已稳定。锁定版本用
> `npm install -g stele-mcp@0.5.0`。

为 Claude Code 提供的本地决策溯源仓库。当一个决策在对话中成形 ——
你选了什么、否决了什么、暂缓了什么、还有什么悬而未决 —— 它会落到一张
结构化的图里:要么 agent 在对话中实时捕获,要么你用 slash 命令显式触发。
之后再问"还有什么在等我?",未结的循环几秒钟内就回到眼前。

原子是**单个 decision**,不是某份 report。三周前的 `deferred` 项被后来的
某个 decision resolve 掉,所有视图里都会自动更新 —— 因为每个视图都是对图
的实时查询,而非冻结的快照。

Decision 归到 **session** (一次 Claude Code 对话) 之下,session 归到
**feature** (像"上线 multi-tenant daemon"这样的一段工作) 之下,feature
归到一个 **project** (一个 `.stele/` 目录) 之下。这个归类工作 agent 替你
做,你不用手动管理某个 decision 属于哪个 feature 或 session。

---

## 安装

要求 **Node ≥ 22.6** (任意现代 Node 即可;不依赖 Python,不依赖 Docker)。
Claude Code 需要 ≥ **2.1.0** 以正确注册 SessionStart / SessionEnd 钩子 ——
`stele init` 会把这个最低版本钉死在项目的 `settings.json` 里,
让过旧的客户端直接拒启动,而不是悄悄跑出奇怪的行为。

```bash
npm install -g stele-mcp@0.5.0
```

这会在 PATH 上放两个命令:
- `stele` —— 用于查看和编辑 decision 仓库的 CLI
- `stele-mcp` —— Claude Code 对接的 MCP server

> **Windows 用户**:SessionStart 钩子是 bash 脚本。可以装 WSL 来用,
> 或者给 `stele init` 加 `--skip-hooks` 跳过钩子,手动用 `/stele:feature`
> slash 命令也可以。(原生 Windows 支持在 roadmap 上。)

## 项目初始化

在任何你想跟踪决策的项目里:

```bash
cd /path/to/your-project
stele init
```

这一条命令把整个读写回路搭起来:

- **`.stele/`** —— 这个项目的 decision 仓库 (SQLite)
- **`.mcp.json`** —— 让该目录下的 Claude Code 看到 `stele` MCP server
- **`.gitignore`** —— 把 `.stele/` 加进去,避免不小心把 DB 提交进 git
- **常驻的浏览器 UI** —— launchd (macOS) 或 systemd-user (Linux) 把
  multi-tenant daemon 一直跑在 `http://127.0.0.1:3939`,重启也不掉
- **SessionStart 钩子 + capture skill + slash 命令** —— 下次你在这个项目
  打开 Claude Code,它会自动接上 (见下方"捕获是怎么工作的")

跳过部分:

```bash
stele init --skip-daemon                       # 不装常驻浏览器 UI
stele init --skip-hooks                        # 不装 SessionStart 钩子,也不装 skill
stele init --enable-session-end-auto-extract   # 顺便装上可选的第三层钩子
stele init --port 4000                         # daemon 用别的端口
```

重启 Claude Code 之后,MCP 工具 (`decision_capture` / `decision_resume` /
`decision_trace` / `decision_resolve`,以及 `feature_*` / `tag_*`) 就都
可用了。

## 捕获是怎么工作的 —— 三层

Stele 通过三层互相托底的机制来捕获 decision。三层共享一个 **dedup key**
(对 `featureId | normalized-title | sorted-affects` 做 sha256),所以
同一个 decision 不会被刻两次 —— 两层同时观察到同一刻,第二次调用会静默
去重。

| 层 | 触发 | 保真度 | 成本 | 默认 |
|---|---|---|---|---|
| 1 · 实时 | agent 在对话中通过 `stele-capture` skill 自治判断 (skill 在 agent 思考"要不要 capture"时自动加载)。 | **最高** —— 拿到完整对话上下文。 | 每轮零开销。 | **开** |
| 2 · 读侧 | SessionStart 钩子在 session 开启时把 `cc_session_id`、活动 feature、tag 策略、活跃 tag、待办循环摘要,以陈述句形式注入。 | 不适用 —— 只读不写。 | session 开启时跑一次 shell 调用。 | **开** |
| 3a · 事后自动 | SessionEnd 钩子启动一个隔离的 Claude,MCP 调用面被严格限定;它读刚结束的 transcript,把第 1 层漏掉的 decision 补抓上。 | 中 —— 文本考古,没有实时上下文。 | session 关闭最多堵塞 60 秒。**不走 `claude -p` 计费** —— 用 Claude Code 的 `agent` 类型钩子,对话直接走你已有的 plan。 | **关** (需手动开启) |
| 3b · 手动 | `/stele:scan` slash 命令 —— 扫历史源 (CC transcript、git log、文件)。任意时刻可再跑。 | 同 3a (文本考古)。 | 一轮对话 + 你的复核。 | **按需** |

开第 3 层自动:

```bash
stele hooks enable session-end-auto-extract     # 打开
stele hooks disable session-end-auto-extract    # 关闭
stele hooks status                              # 看现在装了什么
```

### 两个 slash 命令

`stele init` 会装两个项目级 slash 命令:

- **`/stele:feature`** —— 对**当前** session 做一次对账。
  幂等,任意时刻可调。它会找到当前 going 的 feature (或新开一个),
  把已捕获的 decision 对照实时 transcript 做 diff,补抓遗漏的,
  并刷新 feature 的滚动 summary。任何时候你觉得自动捕获可能漏了什么,
  就跑这个。

- **`/stele:scan`** —— 对**其他**源做一次对账。
  扫 `~/.claude/projects/<sanitized-cwd>/*.jsonl` 下的历史 Claude Code
  transcript,可选地扫 `git log --since=<date>` 和指定文件。把候选
  decision 列给你确认再 capture。第一次安装回填是最常见的场景,但它
  是可重跑的:你在别的工具里有一段长 planning 对话之后、合了一个大
  feature 分支之后、或单纯想审计图的完整度时,都能再跑。

```
/stele:scan                       默认:扫历史 CC transcript
/stele:scan --last N              只扫最近 N 条 transcript
/stele:scan --git-since 2026-01-01  也扫这之后的 commit
/stele:scan --files <path>...     也扫指定文件
/stele:scan --dry-run             只展示候选,不写入
```

两个命令都跑在**你当前的 Claude Code 对话里** —— 不走无头的
`claude -p`,不引入另一个计费面。

## 常驻浏览器 UI

`stele init` 装的是一个 multi-tenant daemon,所有注册的项目都从同一个
URL 提供服务:

```
http://127.0.0.1:3939/                ← 所有项目总览
http://127.0.0.1:3939/<slug>/         ← 该项目视图 (feature 轨 + decision 列表)
http://127.0.0.1:3939/<slug>/trace/   ← decision 图谱追溯
http://127.0.0.1:3939/<slug>/tags/    ← tag 管理
```

一个 daemon、一个 URL 加书签、一个进程要管。你在更多项目里 `stele init`
之后,每个项目都会落到 `~/.stele/registry.json` (slug 默认取目录 basename;
撞名了加 `-2`/`-3` 后缀),并自动在总览页出现一张新卡,daemon 不用重启。

- macOS → `~/Library/LaunchAgents/com.stele.daemon.plist` (launchd)
- Linux → `~/.config/systemd/user/stele-daemon.service` (systemd user)

管理:

```bash
stele daemon status                   # 装了没?跑了几个项目?
stele daemon install                  # 幂等 —— 还会顺带清理老的 plist
stele daemon uninstall                # 卸载并 unload
stele projects list                   # 看 registry 里有啥
stele projects remove <slug>          # 让 registry 忘掉某项目 (不删它的 .stele/)
```

日志在 `~/.stele/daemon.log` 和 `daemon.err.log`。

> **Linux**: user service 只在你登录期间跑。想真正常驻就一次性来一句
> `sudo loginctl enable-linger <你>` (系统级)。
> **从 0.0.2 升级**: `stele daemon install` 会自动移除老的按项目 plist /
> unit,并把它们的工作目录注册到全局 registry,不会丢任何 decision。

## 日常使用

```
在 Claude Code 里讨论一个设计
   ↓
agent 识别出 decision 成形 → 自己 capture
(第 1 层 · 实时;你能在 dashboard 看到这条 capture)
   ↓
觉得有遗漏 → /stele:feature
   ↓
想补抓历史 transcript → /stele:scan
```

隔几天回来,开一个新 session 问:

> 什么在等我?

agent 会调 `decision_resume`。所有 open + 未 resolve 的 deferred 节点会
按"最该被复核"的次序回到你眼前。挑一个让 agent **trace** 它 —— 你能看到
完整的来龙去脉:是谁提的、为什么暂缓、什么触发条件该把它带回来。

核心动词是**刻**。Capture 一个 decision 就是把它刻入实录 —— 此刻进行、
落定、难以擦除。

## 浏览器 UI 一览

`stele serve` 在本地开一个 web UI (或者直接用 `http://127.0.0.1:3939`
上的常驻 daemon)。加书签 —— 它是个你能反复回来的入口,不是一次性的
HTML 导出。

```bash
stele serve                    # http://127.0.0.1:3939 (单项目模式)
stele serve --multi            # multi-tenant 模式 (daemon 用的就是这个)
stele serve --port 4000        # 别的端口
stele serve --open             # 顺便用默认浏览器打开
```

你会用到的页面:

- **Projects** (`/`) —— 所有注册项目总览。
- **Project** (`/<slug>/`) —— 左边 feature 轨,右边选中 feature 的 session
  时间线和 decision 卡片。每张 decision 卡片有一颗有色 source 小章:
  `agent-live` 是暖色、`session-extract` 是琥珀色、`manual` 不显示。
  在 URL 加 `?src=session-extract` 可以筛出来批量复核事后捕获的。
- **Trace** (`/<slug>/trace/<id>`) —— 焦点 decision 卡片 + 它在图里的近邻
  (depends_on / relates / resolves / supersedes / reconciles)。
- **Tags** (`/<slug>/tags/`) —— tag 策略面板、待确认提案、活跃 / 归档 tag。
  支持改名、改色、归档、恢复。
- **Decision Graph** (`/<slug>/graph/`) —— 整项目的交互式图谱视图。

server 只监听 `127.0.0.1` —— 不对外。三个界面 (CLI、MCP、web) 读写的是
同一个 `.stele/decisions.db`,所以 Claude Code 里 capture 的内容刷新一下
浏览器就能看到。

## 跨项目视图

Stele 沿 cwd 向上查找 `.stele/` 目录来定位 decision 仓库 (类似 git 找
`.git/`)。如果你把多个项目放在同一个父目录下,在父目录 `stele init` 就
能给它们一个统一的仓库:

```bash
cd ~/projects        # 里面有 foo/、bar/、baz/
stele init           # 这里只有一个 .stele/
claude               # 任何子目录里 capture 的 decision 都汇到这里
```

向上的查找在 `$HOME` 处停下来,所以 `~/projects/foo/` 下的项目永远不会
悄悄拾起 `~/.stele/` —— 必须显式 opt-in。

## CLI 速查

```
stele --version                                  打印版本

# 项目初始化
stele init [--port N] [--skip-daemon] [--skip-hooks]
           [--enable-session-end-auto-extract]
                                                 一条命令搭好一个项目

# 后台 daemon
stele daemon <install|uninstall|status>          常驻 multi-tenant serve

# 钩子 + skill
stele hooks <install|uninstall|status>           SessionStart 钩子 + skill + slash 命令
stele hooks enable session-end-auto-extract      启用第 3 层自动捕获
stele hooks disable session-end-auto-extract     停用第 3 层自动捕获

# 项目 registry
stele projects <list|remove <slug>>              查看 / 管理全局项目 registry
stele project <show|set-status>                  当前项目的元数据

# 领域实体
stele features <list|open|show|set-state|report>
                                                 feature (0.3.0 把 "milestone" 改名为这个)
stele sessions <list|start|end|resume|continue>  session 生命周期 (session 也会在 decision_capture
                                                 里自动归桶)
stele tags <list|propose|apply|confirm|reject|recolor|rename|archive|restore|proposals>
                                                 跨切面的标签
stele config <list|get|set>                      项目级偏好 (例如 tag_policy)

# 查询
stele resume [--for-context] [--html out.html]   什么在等我
stele trace <id>                                 一个 decision + 它在图里的近邻
stele trace-entity <kind> <id>                   触碰过某个实体的所有 decision (file/feature/skill...)
stele list                                       按 nodeState 列所有 decision

# 边 (edge)
stele resolve <byId> <defId> [note]              手动把后来的 decision 缝合为对老 deferred 的 resolve
stele relate <a> <b> [note]                      连两个 decision
stele depends-on <from> <to> [note]              写一条 depends_on 边

# 其他
stele serve [--multi] [--port N] [--open]        浏览器 UI (默认 http://127.0.0.1:3939)
stele add                                        从 stdin 读 JSON 来 capture (字段同 decision_capture)
```

## 标签

Tag 是跨切面的标签 (`security` / `backend` / `perf` / ...),既可以挂在
decision 上也可以挂在 feature 上。它和 feature 是并存的关系,不是替代 ——
feature 是"这是哪段大推进的一部分?",tag 是"它触碰了哪些跨切面议题?"。

agent 没有完全自由的命名权。项目级 `tag_policy` 决定 agent 提到一个还
不存在的 tag 名时怎么处理:

| 策略     | agent 提议的新 tag 怎么处理                                              |
| -------- | ------------------------------------------------------------------------ |
| `auto`   | 立刻创建,`origin='agent'`,记审计日志                                    |
| `propose` | 排到 `tag_proposals` 队列,等你 `stele tags confirm` (默认)              |
| `locked` | 直接拒绝;尝试被记为 `blocked`                                           |

已存在的 tag 不管策略如何都可以被复用 —— 关卡只在"创建",不在"复用"。

```bash
stele config list                                # 看当前策略
stele config set tag_policy auto                 # 完全信任 agent
stele tags list                                  # 所有活跃 tag
stele tags proposals                             # 看 agent 提了什么
stele tags confirm tp-abc12345                   # 接受一个提案 → 变成活跃
stele tags reject  tp-abc12345                   # 否决一个提案
stele tags propose security --reason "OWASP" --target decision:F-01/D-9
```

`decision_capture` 里 agent 可以传 `tags: [{name, reason?}, ...]`,
一次往返就把新 decision 打上标签。每个名字会过一遍策略引擎,capture 的
返回结果会告诉你哪些落了、哪些 pending、哪些被 blocked。

## 主语言

如果你希望不管你和 agent 用什么语言聊,每条 capture 都用某个特定语言
书写,设置:

```bash
stele config set main_language 中文
stele config set main_language English
stele config set main_language "中文,专有名词保留英文"   # 自由文本,agent 自己读
```

下一次 Claude Code 在这个项目里开 session,SessionStart 钩子会把这个值
连同规则一起注入:

> 自由文本字段 (title / context / detail.* / summary / rationale) 一律用此语言;
> technical terms, IDs, file paths, code identifiers, proper nouns —— preserve as-is.

所以 `title` 和 `context` 会按你选的语言落地,而文件路径、schema 字段名、
命令名和 id 保持原样。不设置 (默认) 就是 agent 用对话当时的语言 —— 行为
和以前一样。

清空:

```bash
stele config set main_language ""
```

## 显示语言

Stele 自己的界面 —— CLI 输出和浏览器 UI —— 都支持中英文。默认从你的
环境自动检测 (CLI 看 `$LANG`,浏览器看 `navigator.language`);要把
某个项目钉死成某个语言:

```bash
stele config set display_language zh   # 或 `en`
```

临时覆盖:

- **CLI**: `STELE_LANG=zh stele hooks status` 单次切换。
- **浏览器 UI**: 任意 URL 加 `?lang=zh`,或者点 topbar 上的 `中文 | EN`
  切换器。切换器会把选择存到 localStorage,**同时** POST 到项目的
  config,这样别的浏览器下次打开也会跟上。

这跟上面的 `main_language` 是两回事:

| | `main_language` | `display_language` |
|---|---|---|
| 控制什么 | **agent 往图里写的内容** | **stele 自己给你看的东西** |
| 类型 | 自由文本 | 严格 enum `zh | en` |
| 影响 | `title`、`context`、`detail.*`、summary | CLI 输出、UI 标签 |
| 不设时的默认 | 对话当时的语言 | 从环境 / 浏览器自动检测,fallback 到 `en` |

清空:

```bash
stele config set display_language ""
```

## 备份

`.stele/decisions.db` 是普通的 SQLite 文件。没有 MCP server 连着时
直接 `cp` 是安全的。要做热备份:

```bash
sqlite3 .stele/decisions.db ".backup /backup/path.db"
```

## 显式指定 DB 位置

如果你想不管 cwd 在哪都用某个特定的 DB:

```bash
STELE_DB=/abs/path/decisions.db stele resume
```

或者在 `.mcp.json` 里:

```jsonc
{ "mcpServers": { "stele": {
  "command": "stele-mcp",
  "env": { "STELE_DB": "/abs/path/decisions.db" }
}}}
```

## 从 0.3.x 升级

- DB schema 是增量的 —— 老 0.3.x 仓库直接打开。新写的行会有
  `source` / `confidence` / `dedupKey` 字段;老行解码时隐式当作
  `source='manual'`。
- 在从 0.3.x 升上来的项目里重跑 `stele hooks install`,以装上
  SessionStart 钩子,并把 `requiredMinimumVersion: "2.1.0"` 钉到
  `.claude/settings.json` 里。
- 老的 `/decision` / `/milestone-report` / `/resume` slash 命令会被
  自动清理 —— 项目级和 `~/.claude/commands/` 的用户级都会扫,用户级
  会做内容指纹比对 (含 stele / 实录 才删),所以别的工具同名的命令
  不会被误删。
- 老的 Stop 钩子已被移除。如果项目里还残留 `.claude/hooks/stele-stop.sh`,
  重跑 `stele hooks install` 会把它删掉,并把 `.claude/settings.json`
  里对应的条目擦干净。

---

## 还想看

- **为什么有这个东西**、设计 rationale —— [ProductDesign.md](./ProductDesign.md)
- **品牌和命名** —— [naming-stele.md](./naming-stele.md)
- **参与贡献 / 从源码运行** —— [DEVELOPING.md](./DEVELOPING.md)
- **完整发布历史** —— [CHANGELOG.md](./CHANGELOG.md)
