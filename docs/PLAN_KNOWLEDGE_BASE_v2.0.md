# PLAN — 知识库 v2.0：摄取 · 日报 · 链接图

> 目标：把 v1.0 的"能存能搜的三层 KB"升级成"**会自己长大的知识系统**"——
> ① 每天自动抓取并总结成信息日报；② 粘贴任意链接（公众号 / 网站 / B站 / YouTube）
> 一键转成带出处的 Markdown 知识；③ 所有知识用 index 织成链接图，memory 通过 link 调取。
>
> 参考：[docs/PLAN_KNOWLEDGE_BASE_v1.0.md](PLAN_KNOWLEDGE_BASE_v1.0.md)（已 shipped #235–#242）、
> [src/kb/](../src/kb/)、[src/mail/](../src/mail/)（日报调度的现成范式）、[src/prompt.ts](../src/prompt.ts)。
>
> **Status:** ✅ shipped（K-A #278 · K-B #279 · K-C #280 · 交接 #281 · K-D #282 ·
> K-E #283 · K-F #284 · K-G #285 · K-H #286 · K-I #287） · **日期:** 2026-07-23 · **Author:** Claude (for Oratis)
> 本文含**现状 review（含 1 个已确认 bug）+ 完整设计 + 正反方辩论 + 分阶段 PR 计划**。

---

## 0. TL;DR — 三个能力，一句话各是什么

| # | 能力 | 一句话 | 核心新模块 |
|---|---|---|---|
| **K1** | 链接 → Markdown | 粘贴任意链接 → 带出处 frontmatter 的 Layer-1 source | `src/kb/ingest/` |
| **K2** | 抓取 + 信息日报 | 一份 watchlist → 每日拉取 → 分类总结 → 日报（推送 + 落库） | `src/kb/feeds/` |
| **K3** | 索引链接图 | `[[slug]]` 真正被解析成图；index 变 MOC；memory 用 link 调取 | `src/kb/links.ts` |

三者不是三个独立功能，而是**一条流水线**：K2 发现 → K1 摄取 → K3 织网 →
idle 蒸馏（v1.0 已有）→ 长成 wiki。K3 是黏合剂，也是最该先做的（见 §7 排序理由）。

---

## 1. 现状 review — v1.0 留下了什么，缺什么

### 1.1 已经有的（可直接复用）

| 层 | 代码 | 状态 |
|---|---|---|
| 存储 | [src/kb/store.ts](../src/kb/store.ts) | frontmatter 读写、`addSource` / `writeWiki` / `removeEntry`、`withFileLock` + git commit、每次写入重建 `index.md` |
| 路径与越狱防护 | [src/kb/paths.ts](../src/kb/paths.ts) | `~/.lisa/kb/{sources,wiki}`，`entryFile()` 用 `assertSafeSlug` 做唯一收口 |
| 检索 | [src/kb/search.ts](../src/kb/search.ts) | TF-IDF + mtime 指纹缓存 |
| 工具 | [src/kb/tool.ts](../src/kb/tool.ts) | `kb_search` / `kb_read` / `kb_list` / `kb_add` / `kb_write` |
| 常驻上下文 | [src/prompt.ts:158](../src/prompt.ts#L158) | SCHEMA.md（4KB 上限）+ index.md（2.6KB 上限）注入系统提示；`getPromptFingerprint` 含 KB 目录 → 会话内热重载 |
| 自主蒸馏 | [src/idle/runner.ts:148](../src/idle/runner.ts#L148) | idle 时读 index，提示 Lisa 用 `kb_write` 把新 source 蒸馏进 wiki |
| Web | [src/web/server.ts:2567](../src/web/server.ts#L2567) + [lisa-client.ts:2670](../src/web/lisa-client.ts#L2670) | `/api/kb{,/search,/entry,/add,/remove}` + Knowledge 视图 + 聊天选中消息存入 KB |
| 权限子集 | [src/tools/registry.ts:204](../src/tools/registry.ts#L204) | `kb_add`/`kb_write` **remote-blocked、autonomous-allowed** |

### 1.2 五个缺口（每个都对应本次的具体工作）

**G1 · 没有摄取通道。** 现有 [`web_fetch`](../src/tools/web_fetch.ts) 只做**有损纯文本**——
`htmlToText`（[web_fetch.ts:115](../src/tools/web_fetch.ts#L115)）把所有标签、标题层级、
列表、代码块、链接、图片全部抹平成一坨文本。它能防 SSRF（`fetchFollowingSafeRedirects`
逐跳校验，值得复用），但产出**不是 Markdown、没有元数据、没有去重、也不落库**。
"粘贴链接变知识"目前是零。

**G2 · 没有 KB 的定时任务。** 全仓唯一的每日调度是 mail
（[server.ts:606](../src/web/server.ts#L606) 的 30 分钟轮询 + `isDigestDue` 纯函数 +
重启补跑），KB 侧没有任何定时器、没有 watchlist、没有"昨天到今天新增了什么"的概念。

**G3 · slug 铸造是纯 ASCII 的（对中文内容是硬伤）。**
`normalizeSlug`（[src/soul/slug.ts](../src/soul/slug.ts)）执行
`replace(/[^a-z0-9]+/g, "-")` —— 一个中文标题会被整条剃成空串，`addSource`
随即回退到 `entry-<timestamp>`。**今天每一条中文来源都会拿到一个无意义的时间戳
slug**，而本次要灌进来的正是公众号 / B 站这类中文内容。必须先修。

**G4 · index.md 是平铺 TOC，`[[slug]]` 没人解析。**
`regenerateIndexLocked`（[store.ts:192](../src/kb/store.ts#L192)）输出的是
"标题 + 前 100 字"的两段列表。SCHEMA.md 里写着"用 `[[slug]]` 互链"
（[src/kb/schema.ts:20](../src/kb/schema.ts#L20)），但全仓**没有任何代码读它**——
没有反向链接、没有孤儿检测、没有图。`sources:` frontmatter 记了出处却从不被查询。

**G5 · 中文检索实际上是坏的（已实测确认）。** 两处 tokenizer
（[kb/search.ts:45](../src/kb/search.ts#L45) 与 [memory/vector.ts:212](../src/memory/vector.ts#L212)）
逻辑相同：把非 `[a-z0-9一-鿿\s]` 换成空格后**按空白切分**。中文不带空格，所以

```
文档 "这篇公众号文章讲的是知识库的设计"  → tokens: ["这篇公众号文章讲的是知识库的设计"]   ← 一整条
查询 "知识库"                          → tokens: ["知识库"]
交集 = ∅  → 命中 0
```

也就是说**中文文档只能被"一字不差的整段查询"命中**，等于不可检索。
（英文不受影响。）灌入中文内容前这是必修项——见 **K3-a**。

---

## 2. K1 — 链接 → Markdown 知识

### 2.1 流水线

```
URL ─► normalize ─► adapter.fetch ─► extract ─► toMarkdown ─► provenance frontmatter
                                                                     │
                        dedupe(hash) ◄────────────────────────────────┤
                             │                                       │
                             ├─ 已存在 → 返回既有 slug（除非 force）  │
                             └─ 新     → addSource()（Layer 1）───────┘
                                              │
                                              └─►(可选 distill:true) 立即触发一次 kb_write 蒸馏
```

保持 v1.0 的核心不变量：**摄取只写 Layer 1，原样保真；蒸馏是 Layer 2 的活**
（v1.0 §D5 的结论，这里继续遵守）。`distill:true` 只是把 idle 里那一步提前触发。

新目录 `src/kb/ingest/`：

| 文件 | 职责 |
|---|---|
| `index.ts` | `ingestUrl(url, opts)` 编排 + adapter 路由 |
| `adapters/{generic,wechat,bilibili,youtube,rssitem}.ts` | 每站一个提取器 |
| `readability.ts` | 正文抽取（打分选主节点，Readability 精简版） |
| `html-to-md.ts` | HTML → Markdown（标题/列表/代码/表格/引用/链接/图片） |
| `provenance.ts` | canonical URL、hash、frontmatter 字段 |

### 2.2 各站适配器 —— 诚实的能力矩阵

| 适配器 | 匹配 | 能拿到 | 可靠性 | 降级路径 |
|---|---|---|---|---|
| **generic** | 其余 http(s) | 标题/作者/发布时间（og:/JSON-LD）+ 正文 MD | 高 | 抽正文失败 → 全页 MD |
| **wechat 公众号** | `mp.weixin.qq.com/s*` | `#js_content` 正文、`og:title`、`js_name` 公众号名、发布时间、`data-src` 图片 | 中高（单篇文章页服务端可取；频控时会跳验证页） | 命中验证页 → 明确报错并提示"用手机分享→粘贴正文" |
| **bilibili** | `bilibili.com/video/*`、`b23.tv` | 标题/UP主/简介/时长/分P（`x/web-interface/view`，公开） | 元数据高 / **字幕低** | 字幕需 `SESSDATA`（用户可选填）→ 无则 `yt-dlp`（若装了）→ 再无则仅元数据 + 简介 |
| **youtube** | `youtube.com/watch*`、`youtu.be` | 元数据（oEmbed，稳定）+ 字幕（InnerTube player → `captionTracks` → `fmt=json3`） | 元数据高 / **字幕中低** | PoToken / `exp=xpe` 会返回空体 → `yt-dlp` → 仅元数据 |
| **rss-item** | 来自 K2 | 条目正文（`content:encoded`）或回落 generic | 高 | — |
| **paste** | 无 URL | 用户直接贴的正文 | — | — |

**关于视频字幕，必须写在明面上：这是一个持续会坏的依赖。**
YouTube 2025–2026 上线了 PO Token 机制，`youtube-transcript-api` 为此新增了
`PoTokenRequired` 异常；部分视频的 `captionTracks.baseUrl` 带 `&exp=xpe`，
即使带 cookie 也返回 200 空体；云厂商 IP 段还会被直接限流。B 站方面，
`/x/player/v2` 自 2022 起字幕需要登录态（`SESSDATA`），社区已确认未登录取不到。
所以设计上**不把字幕当作成功条件**：拿不到就落"元数据 + 简介 + 显式的
`transcript: unavailable(reason)`"，并在返回值里告诉用户可以补贴文稿。
分层顺序固定为 `内建 API → yt-dlp（可选外部二进制，PATH 上有才用）→ 仅元数据`。
（进一步可选：`yt-dlp` 下音频 → 复用 [src/voice/transcribe.ts](../src/voice/transcribe.ts)
的 Whisper/Scribe 转写。成本高，默认关，`LISA_KB_ASR=1` 才开。）

**不做的事**（写进文档避免以后跑偏）：不做公众号历史文章批量爬取、不做需要登录态的
批量抓取、不内置任何账号 cookie。用户自己填的 cookie 只用于他自己的内容。

### 2.3 HTML → Markdown：自建 vs 依赖

见 §6 D1。**结论：自建 ~350 行零依赖版本**，但把 `extract(html, url) → {title, meta, markdown}`
定成接口，后续可替换 `@mozilla/readability + turndown + linkedom` 或外部 reader，
不改调用方。理由：本仓运行时依赖只有 5 个（`package.json`），
`jsdom` 体量与 `linkedom` 的兼容性坑都不值得为一个可自控的 350 行付出。

### 2.4 中文 slug（G3 的具体修法）

新增 `src/kb/slug.ts`：

```ts
export function kbSlug(input: { title: string; url?: string; date?: string }): string {
  const ascii = normalizeSlug(input.title);              // 复用现有 soft cleaner
  if (ascii.length >= 3) return ascii;                    // 英文标题走原路
  const d = (input.date ?? new Date().toISOString()).slice(0, 10);
  const h = sha256(input.url ?? input.title).slice(0, 8); // 稳定、可去重
  return `${d}-${h}`;                                     // 例：2026-07-23-9f3ac1de
}
```

**slug 保持 ASCII**（真标题永远在 frontmatter 的 `title:`）。理由见 §6 D6：
macOS 的 NFD/NFC 归一化、git 的 `core.precomposeunicode`、URL 编码，三者叠加会让
中文文件名在跨设备同步时变成难查的幽灵 bug；而 slug 只是内部标识符，可读性由标题承担。

### 2.5 出处 frontmatter（store.ts 需要一处小改）

当前 `serializeEntry`（[store.ts:90](../src/kb/store.ts#L90)）字段是硬编码的。
加一个 `extra?: Record<string, string>` 透传，摄取写入：

```yaml
---
title: 某公众号文章标题
tags: [ai, 阅读]
created: 2026-07-23T10:12:00.000Z
origin: web                      # ← 关键：标记"外部不可信内容"，见 §8
url: https://mp.weixin.qq.com/s/xxxx
site: mp.weixin.qq.com
author: 某某公众号
published: 2026-07-21
lang: zh
hash: 9f3ac1de…                  # sha256(canonicalUrl)，去重键
via: paste | brief | share       # 怎么进来的
---
```

### 2.6 去重与重复摄取

`hash` 落在 frontmatter，同时维护 `kb/.ingested.json`（`hash → slug` 映射，
损坏可从 sources 全量重建）。默认**同 URL 不重复写**，直接返回既有 slug；
`force:true` 时写新条目并加 `supersedes: <old-slug>`。这样"来源不可变"
（v1.0 §10）与"文章会更新"两个诉求都不破。

### 2.7 用户界面

| 入口 | 形态 |
|---|---|
| 工具 | `kb_ingest(url, title?, tags?, distill?)` |
| CLI | `lisa kb add <url> [--tag x] [--distill]`（新 `lisa kb` 子命令，照 [src/cli/mail.ts](../src/cli/mail.ts) 的形状） |
| Web · Knowledge 视图 | 顶部一个"粘贴链接"输入框 → 进度 → 成功后直接打开该条 |
| Web · 聊天 | 用户消息里检测到裸 URL → 气泡下方出现"存入知识库"小按钮（复用已有的 `/api/kb/add` 交互模式，[lisa-client.ts:1337](../src/web/lisa-client.ts#L1337)） |
| 移动端分享 | iOS/Mac 分享面板 → `POST /api/kb/ingest`。**本次不做**，但 HTTP 接口按能被分享面板直接调用来设计 |

---

## 3. K2 — 抓取 + 信息日报

整体照抄 mail 模块的形状（它已经在线上跑了一年半的同一个问题：定时拉取 → 分类 →
日报 → 推送），差别只在数据源。**能复用的绝不重写。**

### 3.1 watchlist：`~/.lisa/kb/feeds.json`

```jsonc
{
  "feeds": [
    { "id": "hn",     "kind": "rss",    "url": "https://news.ycombinator.com/rss", "tags": ["tech"], "max": 10 },
    { "id": "karpathy","kind": "youtube-channel", "url": "…/feeds/videos.xml?channel_id=UC…", "tags": ["ai"] },
    { "id": "某公众号", "kind": "rss",   "url": "https://rsshub.example/wechat/…", "tags": ["读物"] }
  ],
  "briefHour": 8,
  "budgetTokens": 120000
}
```

文件不存在或 `feeds` 为空 → **整个能力完全惰性**（与 mail 未连账号时一致，
[server.ts:588](../src/web/server.ts#L588) 的判据）。

**RSS/Atom 是主干**，理由是它零依赖可解析、且覆盖面最广：
YouTube 频道仍开放 `feeds/videos.xml?channel_id=`；绝大多数博客/新闻站有 feed。
**公众号和 B 站没有官方 feed** —— 诚实的答案是支持 **RSSHub 兼容 URL**
（用户自建或公共实例），而不是我们去逆向它们的私有接口。这既是工程上最稳的，
也是唯一不踩 ToS 的路。`kind` 里保留 `site`（无 feed 站点的轻量首页 diff）作为兜底，
但默认不启用（噪声大）。

### 3.2 每日流水线（对照 mail 的每一步）

| 步骤 | mail 的实现 | KB 版 |
|---|---|---|
| 是否该跑 | `isDigestDue(last, now, hour)` 纯函数（[mail/scheduler.ts:19](../src/mail/scheduler.ts#L19)） | `isBriefDue(...)` 同签名 |
| 定时 | 30 分钟 `setInterval` + 20 秒重启补跑（[server.ts:606](../src/web/server.ts#L606)） | 同 |
| 拉取 | IMAP 增量（seen-UID） | 各 feed 增量（`lastSeenId` + 发布时间） |
| 分类 | `classifyMail` 批量小模型 → category + importance | `classifyItems` 同形状：`{category, importance 0–3, oneLine}` |
| 成品 | `buildDigest` 纯函数 → `DailyDigest` | `buildBrief` 纯函数 → `DailyBrief` |
| 投递 | `pushBridge.onMailDigest` + `broadcast(idle_message, source:'mail')` | `onKbBrief` + `source:'kb'` |
| 落盘 | `~/.lisa/mail/digests/<date>.json` | **同时**落 `~/.lisa/kb/feeds/<date>.json`（结构化）**和** `sources/brief-<date>.md`（Layer-1 知识） |

最后一行是关键区别：**日报本身就是一条知识**。它进 Layer 1 之后，
自动获得检索（`kb_search`）、链接（K3 把它链到当天摄取的每篇文章）、
以及 idle 蒸馏（"这周我读了什么" 自然长成一张 wiki 页）。
mail 的 digest 只是通知，KB 的 brief 是**语料**。

### 3.3 日报形态

```markdown
# 信息日报 · 2026-07-23

12 条新内容 · 3 条值得读。

## 值得读
- **[标题]** — 一句话说清它讲了什么。为什么值得你读：… `[[2026-07-23-9f3ac1de]]` ↗原文

## 其余（按主题）
### AI
- 标题 — 一句话 ↗
### 工程
…
```

"值得读"的判定复用 mail 的 importance 分级思路，但**排序信号换成个人化的**：
标签匹配 watchlist 权重 + 与 KB 现有 wiki 页的 TF-IDF 相似度（读者是谁，KB 已经知道了）
+ 与 `MEMORY.md`/`USER.md` 里的兴趣。这是 LISA 相对通用 RSS 阅读器的真正差异点。

**Top-N 自动全文摄取**（默认 N=3，可配 0 关闭）：只有"值得读"的条目才走 K1 拿全文，
其余只留标题+一句话。这样每天的 token 与磁盘开销都是有界的。

### 3.4 成本闸门

抄 heartbeat 的做法（[heartbeat/config.ts:20](../src/heartbeat/config.ts#L20) 的
`budgetTokens` + `DEFAULT_HEARTBEAT_BUDGET_TOKENS`）：`feeds.json` 的 `budgetTokens`
默认 120k/天，超了就跳过剩余条目并**记日志而非静默丢弃**。分类走一次批量调用，
不是一条一个请求。

### 3.5 周报 / 月报

不新增调度器——注册成一条 heartbeat 任务即可（用户自己的
`~/.lisa/heartbeat.json` 保留全量工具集）。周日跑："读过去 7 份 brief +
本周新增 sources，写一页 `wiki/weekly-<date>`"。这条天然接上 Reve/idle 的既有循环。

---

## 4. K3 — 索引把知识连起来，memory 通过 link 调取

### 4.1 真正的链接图

新 `src/kb/links.ts`，输入全部条目，输出：

```ts
interface KbGraph {
  forward: Map<string, string[]>;   // slug → 它指向谁（[[slug]] + sources: + url 引用）
  back:    Map<string, string[]>;   // slug → 谁指向它  ← v1.0 完全没有
  orphans: string[];                // 无入无出
  hubs:    { slug: string; score: number }[];  // 按 入度×新鲜度 排序
  tags:    Map<string, string[]>;
}
```

边的三个来源：正文里的 `[[slug]]` / `[[slug|显示文本]]`、wiki 页的 `sources:` frontmatter
（v1.0 已经在写，只是没人读）、source 的 `url` 与 brief 的引用。
缓存策略直接复用 `search.ts` 那套 mtime+size 指纹（[search.ts:75](../src/kb/search.ts#L75)），
KB 不变时零成本。

### 4.2 index.md 从"平铺 TOC"变成"MOC（内容地图）"

约束没变：注入系统提示时被砍到 2.6KB（[prompt.ts:165](../src/prompt.ts#L165)）。
所以 KB 一大，平铺列表就会被从中间截断——**恰恰是最有价值的枢纽页被切掉**。改成：

```markdown
# 知识库索引
_31 wiki · 214 sources · 更新于 2026-07-23_

## 枢纽（按被引用次数）
- **OAuth 与 PKCE** (`oauth`) ↔7 · #auth #security — 一句话主旨
- **LISA 架构** (`lisa-arch`) ↔5 · #project — …

## 按主题
#ai(12) #auth(4) #reading(9) …

## 最近摄取
- 2026-07-23 · 某公众号文章标题 (`2026-07-23-9f3ac1de`)   ← 只给标题，不给正文摘录（§8）

_3 条孤儿页待整理：… （idle 时处理）_
```

排序由 `hubs`（入度×新鲜度）决定，**截断从尾部发生**，枢纽永远在前 2.6KB 内。
同时产出 `kb/index.json` 给程序用（Web 图视图 / 工具），`index.md` 只服务人和提示词。

### 4.3 工具与界面

- `kb_read` 返回值末尾追加 `**被引用：** [[a]] [[b]]`（反向链接是"顺藤摸瓜"的关键）。
- `kb_read` 接受 `[[slug]]` 原样输入（模型经常直接把 wikilink 抄进参数）。
- 新工具 `kb_links(slug)` → 前向/反向/相关（共享标签 + TF-IDF 近邻）。
- Web Knowledge 视图：条目页底部加"被引用/引用"两列；先做列表，**不做 d3 力导向图**
  （§6 D5：图好看但对导航的边际价值远低于反向链接列表）。

### 4.4 memory ⇄ KB：用户诉求 ③ 的落点

这是三条需求里最容易做偏的一条，说清机制：

1. **memory 里存 link，不存内容。** `MEMORY.md` 只有 4KB 上限
   （[memory/store.ts:5](../src/memory/store.ts#L5)），本来就装不下知识。
   约定 memory 条目可以写 `[[kb:oauth]]`，例如
   `- 用户在做 OAuth 迁移，细节见 [[kb:oauth]]`。
2. **常驻提示里 link 自解释。** 组装系统提示时，把 memory 行里的 `[[kb:slug]]`
   就地补上标题 → `[[kb:oauth]](OAuth 与 PKCE)`。Lisa 因此**在看到 memory 的同一瞬间
   就知道该不该展开**，而不是先猜一次。成本是几十字节。
3. **展开靠既有工具。** `kb_read('oauth')` 就是展开动作，不需要新机制。
4. **反向自动建立。** idle 蒸馏（v1.0 已有的那一步）写完 wiki 页后，若该主题在
   memory 里已有条目而没有 link，就补一条 `[[kb:slug]]` 进去。
   **这一步才是"memory 调取 link"真正闭环的地方**——不靠用户手写。
5. **自动互链（保守版）。** 蒸馏时扫描新页正文里出现的**已有页面标题全词匹配**，
   转成 `[[slug]]`。只做全词、只做标题、只在 wiki 层做——宁可漏不可错，
   错的互链会污染图并让 hubs 排序失真。

### 4.5 K3-a · 先修中文分词（G5，其余全部的前置条件）

`tokenize()` 加 CJK 二元组：遇到连续 CJK 字符串时，既产出整串、也产出所有 2-gram。

```
"知识库的设计" → ["知识库的设计", "知识", "识库", "库的", "的设", "设计"]
查询 "知识库"  → ["知识库", "知识", "识库"]   → 命中 ✓
```

二元组是中文检索里"零依赖 / 无词典 / 召回优先"的标准做法，且对 IDF 友好。
**两处都要改**（[kb/search.ts:45](../src/kb/search.ts#L45)、
[memory/vector.ts:212](../src/memory/vector.ts#L212)），因为 memory_search 面对的
中文对话记录有一模一样的问题。改完索引缓存指纹会自然失效，无需迁移。

---

## 5. 数据与接口汇总

```
~/.lisa/kb/
├── SCHEMA.md              # v1.0（补充摄取/日报/互链三段工作流说明）
├── index.md               # v1.0 → MOC（K3）
├── index.json             # 新：链接图（K3）
├── .ingested.json         # 新：hash → slug 去重表（K1）
├── feeds.json             # 新：watchlist + briefHour + budget（K2）
├── feeds/<date>.json      # 新：结构化日报（K2）
├── sources/               # v1.0；新增 brief-<date>.md 与摄取来的文章
└── wiki/                  # v1.0
```

| 工具 | 权限 | 说明 |
|---|---|---|
| `kb_ingest(url,…)` | remote-blocked；autonomous **受限**（§8） | K1 |
| `kb_brief(date?)` | read-only, remote-safe | 读某天日报 |
| `kb_feeds(action,…)` | remote-blocked | 管 watchlist |
| `kb_links(slug)` | read-only, remote-safe | K3 |

| HTTP | 用途 |
|---|---|
| `POST /api/kb/ingest` | 粘贴链接 / 分享面板 |
| `GET /api/kb/brief?date=` | 日报 |
| `GET,POST /api/kb/feeds` | watchlist CRUD |
| `GET /api/kb/graph` | `index.json` |

---

## 6. 正反方辩论

### D1 — Markdown 提取：自建 / npm 依赖 / 远程 reader？
- **依赖派**：`@mozilla/readability + turndown` 是业界标准，2026 年的横评里
  Readability 84%、Jina Reader 81%，成熟度高于任何自建。
- **远程派**：`r.jina.ai` 前缀即用，零维护。
- **自建派（采纳）**：远程 reader **把用户每一篇要读的东西都发给第三方**，
  直接违背 LISA 的"100% 本地"承诺（v1.0 §10），出局。npm 派需要一个 DOM
  （`jsdom` 体积大、`linkedom` 与部分抽取器不兼容），而本仓只有 5 个运行时依赖。
  自建 350 行拿到 80% 的效果，且**公众号/B站这些站点本来就要写专用适配器**——
  真正决定质量的是适配器，不是通用抽取器。
- **共识**：自建 + 明确的 `extract()` 接口，把升级成本压到"换一个实现"。

### D2 — 来源不可变 vs. 文章会更新
- **正**：Karpathy 三层的根基就是 Layer 1 不可变。
- **反**：同一个 URL 明天内容就变了，硬拒绝会让用户困惑。
- **共识（采纳）**：默认按 hash 去重、返回既有 slug；`force` 时**新增**条目并用
  `supersedes:` 串起来。不可变性未破，历史可追。

### D3 — 自主运行能不能摄取任意链接？（本文最重要的一条）
- **正**：Lisa 主动读、主动补充知识，才是"会长大的知识库"。
- **反**：`AUTONOMOUS_BLOCKED_TOOL_NAMES` 的注释已经点名了这个风险
  （[registry.ts:146](../src/tools/registry.ts#L146)）——"web_fetch 内容里的间接注入
  可能种下恶意 desire"。而 KB 比那更危险一步：摄取内容会进 `index.md`，
  而 `index.md` **每一轮都注入系统提示**。这是一条从"任意网页"到"常驻提示词"的直通路。
- **共识（采纳，三重收口）**：
  1. 自主运行**只能摄取 watchlist 里的 URL**（用户自己配的域），不能摄取模型自选的任意 URL；
  2. `origin: web` 的 source 在 `index.md` 里**只出标题、不出正文摘录**（§4.2 已体现）——
     切断"网页正文 → 系统提示"的通路；
  3. `kb_read` 返回外部来源时用不可信内容围栏包裹，正文里的指令一律当数据。
  用户手动粘贴的链接不受限制（那是用户的明确意图）。

### D4 — 抓取要不要新开一个 consent signal？
- **正**：定时对外发网络请求，形态上接近 mail（mail 有 `mail` consent）。
- **反**：consent 框架管的是**敏感的环境采集**（屏幕/麦克风/剪贴板/邮件内容）
  （[consent/store.ts:31](../src/consent/store.ts#L31)）。抓取的是**用户自己填进
  watchlist 的公开 URL**，既不涉他人隐私也不涉本机环境；多一个开关是仪式感不是安全。
- **共识（采纳）**：不新增 consent signal。`feeds.json` 缺失/为空即完全惰性，
  这已经是与 mail 完全同构的"默认关"。但 UI 上必须显示"每日 N 点会去拉这 M 个源"。

### D5 — index.md：平铺 TOC vs. 排序 MOC
- **正**：平铺简单、可预期。
- **反**：2.6KB 硬截断意味着 KB 一大就随机丢内容，而丢掉的可能正是枢纽页。
- **共识（采纳）**：按 `入度×新鲜度` 排序的 MOC，截断只发生在尾部。
  代价是要维护图（K3 本来就要做）。

### D6 — 中文 slug 用中文还是 ASCII 哈希？
- **正（中文 slug）**：`wiki/知识库.md` 一眼可读，`assertSafeSlug` 也允许非 ASCII。
- **反**：macOS 存储用 NFD、Linux/git 用 NFC，跨设备同步会出现"看起来一样但打不开"的文件；
  URL 里还要 percent-encode。而 slug 是内部标识符，可读性由 `title:` 承担。
- **共识（采纳）**：ASCII slug（`<日期>-<8位hash>`），标题保留原文。
  **顺带修掉 G3** —— 今天中文标题拿到的是无意义时间戳，改完至少日期+稳定哈希可去重。

### D7 — 日报存哪：像 mail 那样单独 JSON，还是进 KB？
- **正（单独）**：结构化、好渲染、不污染 sources。
- **反**：日报不进 KB 就搜不到、链不上、蒸馏不到，等于每天生产完就扔。
- **共识（采纳）**：**两份都写**——`feeds/<date>.json` 给 UI，
  `sources/brief-<date>.md` 给知识系统。冗余几 KB 换来"日报本身是语料"。

### D8 — 公众号/B站：自己抓，还是靠 RSSHub？
- **正（自己抓）**：不依赖外部服务。
- **反**：公众号无公开列表接口、B 站空间接口已 wbi 签名且随时会变，
  自建等于长期维护一个反爬军备竞赛，且踩 ToS。
- **共识（采纳）**：**单篇文章的摄取自己做**（K1，用户给了链接就是明确授权），
  **订阅发现交给 RSSHub 兼容 URL**（K2）。这条分界线同时是工程上和合规上的最优点。

---

## 7. 分阶段 PR 计划

每个 PR 独立可合、`typecheck` + `test` 全绿。预计从 **#278** 起。

| PR | 内容 | 关键测试 |
|---|---|---|
| **K-A** | 本文档（设计定稿） | — |
| **K-B · 地基** | ① CJK 二元组分词（`kb/search.ts` + `memory/vector.ts`）；② `kb/slug.ts` 中文 slug；③ `store.ts` frontmatter `extra` 透传 | 中文查询能命中中文文档（G5 回归）；中文标题产出稳定 slug（G3）；frontmatter 往返稳定 |
| **K-C · 链接图** | `kb/links.ts`（前向/反向/孤儿/枢纽）+ `index.json` + `index.md` 升级为 MOC + `kb_links` 工具 | `[[slug]]`/`sources:` 双向解析；截断后枢纽仍在；孤儿检出 |
| **K-D · memory ⇄ link** | `[[kb:slug]]` 在系统提示里补标题；`kb_read` 接受 wikilink；idle 蒸馏回写 link；`kb_read` 附反向链接 | 提示里 link 带标题；蒸馏后 memory 出现 link |
| **K-E · 摄取引擎** | `readability.ts` + `html-to-md.ts` + `provenance.ts` + generic 适配器 + `kb_ingest` 工具 + 去重 | HTML→MD 结构保真（标题/列表/代码/表格）；SSRF 复用测试；同 URL 去重 |
| **K-F · 站点适配器** | wechat / bilibili / youtube / b23 短链 + `yt-dlp` 可选分层 + 降级路径 | 用**离线 HTML 固件**测提取（不打真实网络）；字幕缺失时的降级断言 |
| **K-G · 摄取界面** | `POST /api/kb/ingest`、Knowledge 视图粘贴框、聊天 URL "存入知识库"按钮、`lisa kb add <url>` CLI | HTTP 契约测试；快照测试（[lisa-html-snapshot.test.ts](../src/web/lisa-html-snapshot.test.ts)） |
| **K-H · 日报** | `kb/feeds/`（RSS/Atom 解析、增量、分类、`buildBrief` 纯函数、`isBriefDue`）+ server 定时器 + push + brief 落 Layer 1 + Brief 视图 | 纯函数全覆盖（照 [mail/digest.test.ts](../src/mail/digest.test.ts)）；空 watchlist 完全惰性；预算超限跳过并记日志 |
| **K-I · 收尾** | SCHEMA.md 补三段工作流；`kb_ingest` 自主受限（D3 三重收口）；周报 heartbeat 模板；本文状态改 shipped | 自主子集里 `kb_ingest` 受 watchlist 限制；`origin: web` 不进 index 摘录 |

**排序理由**：K-B/K-C/K-D 先行看着"不出活"，但它们是另外两条的地基——
在中文检索坏着、slug 是时间戳、链接没人解析的状态下先灌内容，等于制造
一堆事后要迁移的数据。**先修管道，再开闸。**
最小可用切片是 **K-B + K-E + K-G**（粘贴链接就能用），
**K-H** 单独就能交付日报，**K-C/K-D** 让整个东西从"文件堆"变成"知识网"。

---

## 8. 隐私 · 安全 · 成本

- **SSRF**：所有出站抓取走既有的 `fetchFollowingSafeRedirects`
  （[web_fetch.ts:75](../src/tools/web_fetch.ts#L75)，逐跳校验私网/回环），不另起 fetch。
- **提示注入**（最需要盯的面）：外部内容 → `index.md` → 系统提示是一条真实通路。
  三重收口见 D3：自主摄取限 watchlist、`origin: web` 不进索引摘录、
  `kb_read` 外部内容加不可信围栏。
- **越狱**：摄取仍然只经 `addSource()` → `entryFile()` → `assertSafeSlug()` 这条唯一收口
  （[paths.ts:48](../src/kb/paths.ts#L48)），不新增写路径。
- **凭据**：B 站 `SESSDATA` 之类由用户自愿填入 `feeds.json`，`0600`，**不进 git、不进提示词、
  不随 KB 仓库提交**（`kb/.gitignore` 排除 `feeds.json`）。
- **ToS 与礼貌**：尊重 `robots.txt`、每站串行 + 退避、真实 UA 标识 `Lisa/…`；
  不做登录态批量抓取；不做公众号历史全量爬取。
- **成本**：日报每天一次批量分类调用 + 至多 N 篇全文；`budgetTokens` 硬闸门；
  磁盘上每篇文章几十 KB，且 KB 有独立 git 仓（v1.0 §D4）不会拖累 soul。
- **本地性**：全部落 `~/.lisa/kb/`，除了抓取目标站点本身，不向任何第三方发送内容
  （这条直接否掉了远程 reader 方案，见 D1）。

---

## 9. 开放问题 / 非目标

**开放问题**
1. 图片怎么办？公众号图片有 referer 校验，外链在 KB 里大概率显示不出来。
   选项：（a）只留链接（本次默认）；（b）下载到 `kb/assets/`（占空间但离线可读）。倾向 (b) 但放到 K-F 之后单独评估。
2. `sources/` 会长很大之后，`listEntries()` 每次全量读盘重解析（[store.ts:163](../src/kb/store.ts#L163)）
   会变慢——需要一个元数据缓存。**过千条再做**，别提前优化。
3. 语义检索：v1.0 就留了口子（复用 [memory/embedding.ts](../src/memory/embedding.ts) 的
   可选 Ollama 嵌入）。CJK 二元组修完后先看 TF-IDF 够不够，不够再上。
4. 日报的"值得读"判定要不要让用户反馈（👍/👎）来调权重？这会把它从静态规则变成
   会学习的东西——很诱人，但先跑两周静态版本看真实噪声率再定。

**非目标（本轮明确不做）**
- 公众号/B站的账号级批量爬取与历史归档。
- 浏览器扩展 / 分享面板客户端（HTTP 接口预留，客户端另开）。
- 知识图谱可视化（力导向图）——先做反向链接列表。
- 多人协作 / KB 共享——KB 是单用户本地资产。

---

## 附:研究来源

摄取可行性部分基于以下公开资料（2026-07 核对）：

- YouTube 字幕/PO Token 现状：[youtube-transcript-api releases](https://github.com/jdepoix/youtube-transcript-api/releases)、[issue #592 `exp=xpe` 空响应](https://github.com/jdepoix/youtube-transcript-api/issues/592)、[YouTube timedtext endpoint](https://grokipedia.com/page/YouTube_timedtext_endpoint)、[SkipTheWatch: API not working](https://skipthewatch.com/blog/youtube-transcript-api-not-working)
- B 站字幕需登录：[bilibili-API-collect issue #778](https://github.com/SocialSisterYi/bilibili-API-collect/issues/778)、[播放器接口文档](https://socialsisteryi.github.io/bilibili-API-collect/docs/video/player.html)
- 公众号正文结构（`#js_content` / `data-src`）：[codex 抓取公众号 skill](https://zhuanlan.zhihu.com/p/2044899985758614857)、[Python 抓取公众号文章内容](https://zeeklog.com/python-pa-chong-shi-zhan-cong-ling-dao-yi-zhua-qu-wei-xin-gong-zhong-hao-wen-zhang-nei-rong)
- 提取器横评（Web2MD 94% / Trafilatura 87% / Readability 84% / Jina 81%）：[Best Web to Markdown Tools 2026](https://web2md.org/blog/best-web-to-markdown-tools-2026)、[Readability 抽取实践](https://webcrawlerapi.com/blog/how-to-extract-article-or-blogpost-content-in-js-using-readabilityjs)
