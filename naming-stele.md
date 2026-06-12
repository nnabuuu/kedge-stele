# 实录 · Stele

> 命名与品牌文档 · 决策溯源工具

---

## 名字

- **中文**:实录
- **英文**:Stele
- **一句话**:为每个决策留下它的实录——定下的那一刻刻下,日后随时溯。

---

## 为什么是这个名字

名字要写进产品的魂。这个产品的第一句话是「决策会蒸发」,所以名字要回答的就是:**怎么让它不蒸发,以及怎么把蒸发掉的找回来。** 中英两半各管一头。

### 实录 —— 记录的体裁

「实录」是真实存在的史学体裁:历代为每一朝修的实录,把君主的决策、言行**在当下**记录在案,作为日后修正史的底本。

它最妙的地方,是它和「起居注」的分工——起居注是当下的原始捕获,实录是事后据此编纂的成品。这正是这个工具的核心结构:

> capture(在决策当下记下)和 projection(report / resume / trace 这些事后视图)是**两件事**。系统是 source of truth,报告只是它的投影。

古人修史那套流程里,这层分工早就分得清清楚楚。用「实录」做名字,等于把这层结构直接写进了名字。而且它端庄、有史官气,对体制内的 decision-maker 是对的气质。

### Stele —— 记录的载体

Stele(碑)是人类为了让记录**不蒸发**而发明的东西:刻在石上,为的就是经得起时间。碑刻历来记的就是诏令、决策、立约——把一件值得留存的事,刻进一个不会因为窗口关闭而消失的介质里。

它直接回击开篇那句「决策会蒸发」:**碑,就是刻下来、不蒸发。** 没有别的词比它更贴这个产品的承诺。

中文резонанс 也厚——「碑」在中文里就是 stele 的精确对译,记的也正是帝王将相的决断。这跟「即见」从《金刚经》借词、用经典概念当入口,是同一个方法。

### 两半合起来

**实录**是体裁(记什么、怎么分 capture 与 projection),**Stele**是载体(刻下来,让它留存)。一个管"记录这件事的结构",一个管"记录这件事的承诺"。叠在一起,正好是这个工具的全部:**把决策当下刻下,日后可溯。**

---

## 命名方案

品牌放在产品 / 包 / 命令这一层;tool 名留给语义,不品牌化(agent 直接读 tool 名,清楚比好听更重要)。

| 用途 | 名称 |
|---|---|
| 产品名 | 实录 / Stele |
| npm package | `stele-mcp`(或挂自有 scope `@xxx/stele`) |
| MCP server identity | `stele` |
| CLI 命令前缀 | `stele capture` / `stele resume` / `stele trace` |
| 四个 MCP tool | `decision_capture` / `decision_resume` / `decision_trace` / `decision_resolve`(**保持不变**) |

---

## 定位语

- **中文**:为每个决策留下它的实录——定下的那一刻刻下,日后随时溯。
- **English**:*Stele — your decisions, carved as they're made, traceable ever after.*

("carved / 刻" 是这套语汇的核心动词,接住碑的意象;capture 一个决策,在语感上就是"刻一笔"。)

---

## 落地页文案

**定位语**是品牌身份 —— 放在文档标题、by-line、对人介绍自己时用,文学/史官气。
**落地页文案**是产品营销的第一接触面 —— visitor 10 秒内决定要不要装。
两个 register 不同,各管各的,不要互相替代。

当前 `web/landing.html` 上的版本:

**sub(主体三句):**
- EN:*Stele carves your decisions. Every choice, every deferral, every rejection. Find the reasoning behind anything you built, whenever you need it.*
- 中文:实录把你的决策刻下来。每一次选择、推迟、否决。你做的任何东西,日后都能溯回它当时是怎么来的。

**CTA:**
- GitHub →(中英共用,极简 dev tool 风,跟 Vercel / Linear / Resend 那一档对齐)
- Open dashboard → / 打开 dashboard →

**title 栏:**
- Stele · Carve your decisions
- 实录 · Stele · 把决策刻下来

**eyebrow:** 无。旧版 *Decision provenance · 决策溯源* 中英同义重复,新版 sub 已经把"做什么"讲清,eyebrow 留着只是垫字,撤。

### 五条设计原则(改 copy 之前复核)

1. **品牌动词「刻 / carves」必须在第一句**。这是品牌资产的核心,丢了就跟任何 SaaS 没区别。
2. **不要写"本地存储"或类似 implementation 细节**。日后要做 remote 分析服务(local detect → 脱敏上传 → cloud analyze),slogan 锁本地会成为日后包袱。`note` 那行可以,sub 不行。
3. **不要绑 Claude**。产品现在 100% 服务 Claude Code 用户,但 brand 要给将来开新口子(Cursor / Codex / 别的 agent)留余地。Eyebrow / sub / CTA 都不提 Claude。
4. **第二句必须是用户收益,不是产品机制**。"captured at decision time" 是机制,"find the reasoning whenever you need it" 是收益 —— 上一版 sub 卡在机制上,这次改稿的核心 learning 就是这一刀。
5. **承诺不许装腔**。CN 版的「日后都能溯回它当时是怎么来的」直接借 `naming-stele.md` 第 84 行 (一句话讲给别人听) 的原话,保史官气,跟"3 倍开发效率"这种 SaaS 营销腔切割。

### 三个反面教材(已经写出来过,以后不要再来)

- ❌ *A local-first decision-provenance store. Agents deliver results; Stele records the decisions behind them…* —— 类别开头 + 生产者口吻 + 形容词堆,三个毛病占齐。
- ❌ *Decision provenance · 决策溯源* —— 中英同义对齐,信息密度=0,垫字。
- ❌ *Stele tracks your decisions* —— 动词换成 track 就跟任意 SaaS 没区别,品牌资产蒸发。这个反面教材的存在是因为它在改稿过程中**真的被提议过**,被打回的理由记在这条里以免再来。

### 什么时候这一版要重写

- 推出 remote 分析服务时(主张变了,sub 必须重做)
- 开始支持 Claude Code 以外的 agent 时(开新口子,可以多一条受众描述)
- 跨过第一个 100 个 active project 时(从"早期工具"切到"成熟工具",voice 可以松一档)
- 任何时候 CTA `Open dashboard` 的 path(`/`) 变了
- 任何时候品牌动词从「刻」改了(动了核心,所有 copy 跟着重做)

---

## 用法与边界

- **品牌 vs 语义分层**:Stele / 实录 出现在产品名、包名、命令、文档标题、landing 这些"对人"的地方;tool 名、字段名、type 名保持语义化的英文,因为那是"对 agent / 对代码"的。
- **核心动词用「刻 / carve」**,不用「写 / record」——它和碑的意象一致,也强调"刻下不可轻易抹除"的承诺感。
- **发音提示**:Stele 英文读 /ˈstiːli/(近 "STEE-lee")。母语者常会念成 "steel"。对个人 / 开发者工具无所谓(主要是打字不是念),但若将来要做口头传播,这是个已知摩擦点。

---

## 占用核查(截至定名时)

- **npm**:裸名 `stele` 已被占(常用词);`stele-mcp` 空闲。→ 发包用 `stele-mcp` 或自有 scope,产品名不受影响。
- **GitHub**:同名仓库零散、低星,且**无一在决策记录 / provenance / MCP 这个领域**——无同 niche 撞车(对比:Acta 已有 `acta-mcp` 同领域产品、Chronicle 撞低延迟交易 + 安全产品,均已排除)。
- **域名 / 商标**:**未查**。对个人开源工具不卡起步;真要做成产品时再过这道门(如 `stele.dev` 之类)。

---

## 一句话讲给别人听

> 它叫实录,英文 Stele——碑。git 记录改了什么,实录刻下为什么:每个决策定下的那一刻就刻进图里,日后指着任何一个文件、任何一个决定,都能溯回它当初是怎么来的。
