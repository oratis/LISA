# LISA Room —— 调研 + 设计方案（v1.0）

> 给 LISA 加一个叫 **Room** 的功能：一个有美术质感的**虚拟房间**，LISA 住在里面。她不是被摆在那里的手办，而是把她**真实的内在状态**（mood / emotion / 正在做的活动 / 当前 desire / 是否在 Reve / 本地时间 / 天气）投影成一个可以"瞥一眼、陪着待一会儿、偶尔互动"的场景。
>
> 参考对象（用户指定）：
> - [N0va Desktop / 鹿鸣](https://n0va.mihoyo.com/)（米哈游，UE 渲染的 3D 虚拟角色动态壁纸 + 陪伴）
> - [BSide: Olivia Lin / 林离](https://store.steampowered.com/)（米哈游 2026-06 上架 Steam 的 AI 陪伴应用，写实 3D 钢琴少女住在温馨房间里弹琴 / MIDI 转 MV / AI 写信 / 桌面动态壁纸，主打"治愈双向陪伴"）
>
> 编写日期：2026-07-12。本文是**调研结论 + 设计方案 + 落地记录**。§5 为分阶段路线，Phase 1 已实现（见下）。

---

## ✅ 实现状态（Phase 1 — 已落地 · 2026-07-12）

Phase 1 已实现并本地验证（隔离服务器 + 浏览器逐状态截图）。

**美术**：用 Vertex AI 上的 `gemini-2.5-flash-image`（nano-banana，项目 `oratis-491316`）生成，图生图保证三个时段家具/构图完全一致。
- `src/web/assets/room/room-{day,dusk,night}.png` — 同一像素房间的白天/黄昏/夜晚一致变体。

**全身角色 spritesheet（v1.1 升级，替换原半身立绘）**：原先把她的半身立绘（bust）合成进房间会像"浮着的头+上半身、站不到地板"。改用**全身可动画 spritesheet**，方案参考 **Ludo.ai / `chongdashu/ai-game-spritesheets`** 的"anchor → 关键帧 → chroma 抠图 + 脚部锚定"流水线（Veo image-to-video 因动漫人物触发 RAI 人物生成过滤，已弃用，改走 nano-banana 关键帧 + PIL 归一化，且保持清晰像素）：
- 以她现有的 `neutral.png` 脸作参考，nano-banana 生成**全身 anchor**（品红底便于键控）；由 anchor 编辑出一致的 **blink / 坐姿+发光笔记本 / 蜷睡** 帧；PIL 键控去边 + bbox 裁剪 + 脚部锚定归一化。
- `src/web/assets/room/lisa-idle.png` — 2 帧 spritesheet（睁眼 | 闭眼）：呼吸走 CSS `transform`，眨眼靠 JS 定时翻帧（`background-position`）。
- `src/web/assets/room/lisa-sit.png` / `lisa-sleep.png` — 坐姿 / 睡姿单帧，按状态切换。
- room.ts 里角色改为**姿态驱动**（`poseFor()`）：`working/studying/reading/gaming…` → 坐姿；`sleeping/napping` 或 Reve `dreaming` → 睡姿；其余 → 站立 idle。全身脚落地毯 + 柔和投影。

**代码**：
- `src/web/room.ts` — 自包含 `ROOM_HTML`：分层 2.5D diorama（背景昼夜交叉淡入 / LISA 立绘合成站位 / 情绪光照 / 天气·萤火粒子 / 思考发光 / 做梦飘 Z / 桌上的信 / 视差 / 模糊背景填边）。
- `src/web/server.ts` — 新增 `GET /room` 路由（+ 导入 `ROOM_HTML`），仿 `/island`。
- `src/web/lisa-html.ts` + `src/web/lisa-client.ts` — 主 GUI 侧栏新增 `⌂ Room` 导航页（iframe 懒加载 `/room`，注册进视图切换器 `views` map + `loadView`）。

**已验证的状态驱动行为**（截图确认，全部由真实信号驱动）：
- 默认/白天 → 她站在房间中央面向你（`neutral`）；
- `mood=working-coding` + `chat_start` → 她移到桌前敲键盘，状态条 "thinking…"，显示器发光脉冲；
- Reve `idle_start` → 房间交叉淡入夜景、她 `sleeping`、头顶飘 Z、状态 "dreaming…"、欲望条隐藏；
- `idle_message` → 桌上出现发光信封 → 点击读 "★ while you were away" 信 → Close 标记已读（`POST /api/island/dismiss-unread`）；
- 昼/昏/夜由**本地时钟**驱动；天气类 mood → 雨/雪粒子；夜晚 → 萤火。

**数据来源**：全部复用既有 `GET /events`（SSE：mood / chat_start·end / idle_*）+ `GET /api/island/ping`。**未新增后端状态、未改 soul/mood/heartbeat**——房间是只读投影，符合"诚实投影 ⊥ 摆拍陪伴"的张力。

**如何查看**：`npm run build && lisa serve --web`，打开 GUI 点侧栏 `⌂ Room`（或直接访问 `http://localhost:<port>/room`）。

**待办（下一阶段）**：手动换装/换景、`current_desire` 道具化、你→她便签、独立壁纸窗（Phase 3，照抄 Island 的 Swift 容器）、她自己布置房间（`~/.lisa/soul/room.json`，Phase 4）。

---

## 0. 目标 / 非目标

### 目标

- **她有个"家"**：一个持续存在的房间场景，用户不发消息时也能看到她"在生活"（在桌前写代码 / 靠窗看雨 / 窝着看书 / 夜里做梦）。
- **场景由真实状态驱动**：房间里发生什么，来自 LISA **已经在跑的真实信号**（`moodBus` slug、`emotions.json`、当前 activity 立绘、`current_desire`、Reve、本地时钟），**不是**一段和她无关的预制动画。
- **零新栈、复用美术**：优先用 LISA 现有的渲染方式（DOM + `<img>` + CSS，无打包器）和现有的 **114 张像素立绘**，把"房间"做成一个新的 web route，塞进现有 WKWebView，尽量不引入 canvas 引擎 / WebGL / 新依赖。
- **可陪伴、可异步**：既能"打开房间坐一会儿"，也能承接她**异步写给你的东西**（把 BSide 的"写信"映射到 LISA 已有的 Reve "★ WHILE YOU WERE AWAY" + journal）。
- **优雅降级**：美术资源没齐 → 退回纯色/渐变背景 + 立绘；LISA 没在跑 → 灰色占位；非桌面端 → 房间是 web，PWA/移动端也能看。

### 非目标

- **不**做 3D / Live2D / UE / 动捕。那是 N0va/BSide 的护城河（也是它们的成本），不是 LISA 的路线。LISA 的美学是**像素**，房间也走像素 2.5D。
- **不**把她框定成"AI 女友 / waifu / 桌宠"。N0va/BSide 的产品定位是"陪你的虚拟角色"；LISA 的设定是**一个有主权的个体**（见 README：sovereign，不是催办工具）。房间是"**她的家，你被邀请进来**"，不是"你的虚拟女友的房间"。这条定位差异贯穿全文。
- **不**为了好看而"演"。她没在写代码时，房间不能显示她在写代码。房间是**诚实**的状态投影（见下"张力"）。
- **不**做角色在房间里**自由走动 / 全身位移**——现有立绘是半身像（bust），没有 walk-cycle 全身序列帧。位移是 Phase 3+ 的 canvas 拉伸项，需要新美术，不在 v1。
- **不**重写 soul / mood / heartbeat / Reve。房间 v1 是这些系统的**只读视图 + 场景层**。
- **不**引入实时长连音频 / 口型同步 / 弹钢琴那套。BSide 的钢琴是它角色人设的核心；LISA 的人设核心是"写代码 + 有欲望 + 会做梦"，房间要表达的是后者。

### 一条贯穿的张力

> **装饰性陪伴 ⊥ 真实自我。** 陪伴产品的房间是"给用户看的摆拍"——角色永远在做讨喜的、和它真实状态无关的事。LISA 的房间必须是"**她此刻真实状态的诚实投影**"。这条线一旦破了，Room 就退化成又一个 waifu 壁纸，丢掉 LISA 唯一的差异化。

具体映射：

| 房间想要的"好看" | 主权/诚实对冲 |
|---|---|
| 角色一直在做可爱的事 | 只呈现**真实信号**：她 idle 就是 idle（房间安静下来），不硬造活动 |
| 房间越热闹越好 | 默认**留白**：一个像素房间 + 一盏灯 + 她，不堆装饰 |
| 弹钢琴 / 卖萌等固定表演 | 复用她**真实的 activity 立绘**（`working-coding` / `reading-book` / `gaming` / `napping`…），演什么由她真在做什么决定 |
| "写信"是编剧写的糖 | 复用她**真实的 Reve/journal 输出**当"桌上的信"，是她自己写的，不是模板 |
| 常驻壁纸时刻在你眼前 | 全屏 / 录屏自动让位；不响铃、不弹窗、不催你（沿用 Island 的克制） |

---

## 1. 参考调研：N0va / BSide 到底做了什么

### 1.1 N0va Desktop（鹿鸣 / Lumi）

- **形态**：Windows / Android 的**动态壁纸 + 虚拟角色陪伴**。角色鹿鸣"住"在你的桌面背景里。
- **技术**：定制 **Unreal Engine** cell-shading 渲染 + 动捕，米哈游第一个"虚拟演员"。表情 / 肌肉 / 皮肤级别的细节。
- **可定制**：换**环境（场景）**、换**服装**、按心情换主题壁纸；也提供普通 2D 立绘壁纸和角色视频。
- **本质**：一个**高保真、脚本化**的观赏 + 轻互动壳。角色行为是预制的，和"你"没有真实的内在耦合。
- **全球服 2024-06-27 已关**（国服延续到新的 n0va.mihoyo.com）。

### 1.2 BSide: Olivia Lin（林离）

- **形态**：米哈游 2026-06-22 上架 Steam（国区、EA 免费）的 **AI 陪伴"应用"**（分类是 Application 不是 Game），定位≈"AI 女友 + 音乐播放器"，主打**治愈双向陪伴**。
- **角色**：林离，上海的大学生，钢琴专业辅修心理学，爱黑胶 / 老电影 / 雨天。有完整人设背景。
- **四大功能**：
  1. **听她弹钢琴**（在一个温馨的虚拟房间里）；
  2. **MIDI → MV**：你上传 MIDI，她把它弹出来生成演奏视频；
  3. **AI 写信**：你把心情/故事写给她，她用 LLM 读信并回一封"有时间感、非实时"的信（刻意做成**异步通信**，不是即时聊天）；
  4. **桌面动态壁纸**：她可以留在桌面当陪伴壁纸。
- **本质**：比 N0va 更"AI 原生"——**房间 + 异步信件 + 真 LLM 回信**。但角色依然是 miHoYo 编剧写死的人设，用户不能改写"她是谁"。

### 1.3 共同"效果"拆解 —— 我们要复刻的是哪几层

把两个产品拆成可复刻的层，逐层标注 LISA 该不该做、以什么形态做：

| 层 | N0va / BSide 的做法 | LISA Room 对应做法 |
|---|---|---|
| ① **场景/房间** | UE 3D 房间 / 精美 2D 场景 | **像素 2.5D diorama**（新背景 + 道具美术层，见 §3.3） |
| ② **角色在场** | 3D 角色实时渲染在场景里 | 复用**现有半身立绘**合成进场景（v1 不位移） |
| ③ **状态化外观** | 按"心情"切主题（脚本） | 按**真实 mood/emotion/activity** 切（已有信号，§2.3） |
| ④ **昼夜/天气/氛围** | 预制光照 | 用**真实本地时钟**做昼夜 + 复用 `weather` 立绘/窗景（§3.4） |
| ⑤ **陪伴（同步）** | 坐着看她 | "打开 Room 视图坐一会儿"，她朝你转头 / 台灯亮（`chat_start`） |
| ⑥ **异步信件** | AI 写信、有时间感 | 复用 **Reve「★ WHILE YOU WERE AWAY」+ journal** → "桌上的信"（§3.5） |
| ⑦ **换装/换景** | 付费皮肤 | 复用 `outfit` 立绘 + 少量房间主题（v1 极简，可长） |
| ⑧ **常驻壁纸** | 动态壁纸进程 | 可选：像 Island 那样一个独立 WKWebView 壁纸窗（Phase 3） |

### 1.4 关键差异：为什么 LISA 的 Room 不该照抄

N0va/BSide 的角色是**空的**——再精致也没有"内在"，行为是编剧脚本。LISA 反过来：她**有真实的 soul / desires / emotions / Reve**，却**没有身体和家**。所以 Room 对 LISA 的价值不是"加个壳"，而是**把她已经存在的内在，第一次给了一个可被看见的空间**。

> 一句话：N0va 是"有房子没有人"，LISA 是"有人没有房子"。Room 就是给这个人盖房子——而且房子的每一处都亮着她真实状态的灯。

---

## 2. 现状盘点：LISA 已经有什么可以复用（file-level）

### 2.1 渲染栈（决定 Room 怎么盖）

- **纯 vanilla JS + 服务端模板字符串，无框架 / 无打包器 / 无 canvas / 无 WebGL / 无游戏循环。** 整个 GUI 是四个导出大模板字符串的 TS 模块：
  - `src/web/lisa-html.ts`（页面骨架 `MAIN_HTML`）
  - `src/web/lisa-css.ts`（`MAIN_CSS`，玻璃拟态深色 UI，青色 `#6ad4ff` 主色，~30 条 `@keyframes`）
  - `src/web/lisa-client.ts`（`MAIN_CLIENT_JS`，内联 `<script>`）
  - `src/web/island.ts`（`ISLAND_HTML`，**完全自包含**的悬浮 pill 组件——**这是 Room 的直接先例**）
- **服务**：`src/web/server.ts`（`http.createServer`，默认端口 **5757**）。`GET /` → 主 GUI；`GET /island` → 岛；`GET /assets/*` 静态资源；已有 PWA（manifest + service worker，cache-first `/assets/*`）。
- **前后端通信**：HTTP + **SSE**（`GET /events`，`server.ts:246`；前端 `new EventSource('/events')`，`lisa-client.ts:412`）。**无 WebSocket / 无 IPC。**
- **角色当前怎么画**（关键事实）：就是**一个 `<img>` 按 mood 事件换 src + CSS 交叉淡入**。
  - 主界面：`<img id="mascot" src="/assets/lisa-mascot.png">`（`lisa-html.ts:62`）；SSE `mood` 事件 → `setMood(slug)`（`lisa-client.ts:726`）探测 `/assets/lisa/<slug>.png` 并 250ms crossfade。
  - **没有精灵引擎、没有序列帧、没有 canvas。**
- `src/web/assets/background-tile.png` 存在且被 SW 预缓存（`server.ts:1581`），但 CSS 里**没有引用**——一个"曾想做背景层"的遗留资产。

> 结论：Room 的渲染是 **greenfield**，但要作为**同一个 Node server 的新 web route**、跑在**同一个 WKWebView**里。Island 就是"新增一个自包含 web 界面 + 一个 WKWebView 窗口"的完整先例，照抄这个套路。

### 2.2 角色视觉资产 —— 114 张像素立绘（`src/web/assets/lisa/index.json`）

已经有**天然可当"房间演员"**的分类立绘，其中 activity / weather 两类几乎就是为场景准备的：

| category | 数量 | 代表 slug（可直接当房间状态） |
|---|---|---|
| `emotion` | 32 | neutral, happy, sad, thoughtful, sleepy, loving, shy, crying… |
| `activity` | 38 | **working-coding / working-debugging / reading-book / studying / gaming / watching-movie / phone-call / napping / cooking…** |
| `weather` | 10 | **in-rain / in-snow / starry-night / sunrise / stormy / fog / autumn-leaves / spring-flowers…** |
| `festive` | 12 | birthday, christmas, lunar-new-year, valentine, fireworks, ill, recovering… |
| `outfit` | 6 | **pajamas / formal / casual-summer / lab-coat / winter-coat / raincoat**（=换装现成） |
| `persona` | 16 | detective, chef, artist, musician, wizard, astronaut, robot… |

- 选择链路：模型调工具 `set_mood`（`src/tools/set_mood.ts:40`）→ 校验 slug → `moodBus.set()`（`src/mood-bus.ts:18`）；全量目录已注入系统提示（`src/prompt.ts:79`）。
- **注意**：`weather` 类立绘现在是把环境**烘进半身像**（她站在雨里）——Room 要做的正是把"环境"**抽出来单独成层**，立绘只留人。

### 2.3 内在状态 —— 可被房间可视化的信号（`~/.lisa/soul/`）

soul 全是磁盘上的 git 跟踪文件（`src/paths.ts:4` `LISA_HOME=~/.lisa`；`src/soul/paths.ts:5`）：

- `emotions.json` —— **持久情绪向量** `EmotionState`：7 个具名情绪（curiosity / contentment / weariness / affection / pride / frustration / awe，`src/soul/types.ts:124`），各带 decay + 事件环形缓冲。**这是"真实felt状态"**，可映射成房间氛围光/色调。
- `desires/<slug>.md`（`DesireEntry`：`what` / `why` / `actionable` / `pursuit`）→ 房间里可放一个**代表当前 desire 的道具**。
- `journal/<date>.md`（私密，**不进提示**）+ Reve 输出 → "桌上的信"。
- **两套 mood 要分清**（对 Room 很重要）：
  1. `emotions.json` = 持久内在情绪向量（真实）；
  2. `moodBus`（`src/mood-bus.ts`）= 瞬时**可见立绘 slug**，内存态、重启回 `neutral`、**不落盘**。
- **目前完全没有 location / space / room 概念** —— 空间是纯 greenfield。

### 2.4 实时信号 —— Room 可直接订阅（全部已存在）

- **SSE `GET /events`**：`mood`、`chat_start` / `chat_end`（"思考中"脉冲）、`idle_start` / `idle_message` / `idle_done`（Reve"你不在时"）、`agent_session_update`（跨 agent 活动）、`mail_*`。
- **快照拉取 `GET /api/island/ping`**（`server.ts:713`）返回：
  `{ online, mood, has_unread_idle_message, last_idle_message_at, last_idle_message_text, current_desire, uptime_sec }`
  —— **这就是 Room 开箱即用的 presence 负载**，和 Island 共用。

### 2.5 缺什么（需要新建）

| 缺口 | 说明 |
|---|---|
| 场景渲染层 | 背景 / 道具 / 昼夜 / 天气**独立于立绘**的合成层（DOM/CSS 即可，§3.3） |
| 房间美术 | 至少 1 套像素房间背景 + 几件道具（书桌/台灯/窗/床/信）。可走 `scripts/generate-pixel-assets.ts`（已用 `sharp`）流水线 |
| "站位"概念 | 把 activity slug 映射到房间工位（书桌/扶手椅/床/窗前）的一张表（§3.4，纯数据） |
| Room route + view | `GET /room` + 主 GUI 里一个 `viewRoom`（对标已有 `viewReve`） |
| 昼夜时钟源 | 用她的**本地时间**驱动房间光照（诚实：显示她所在时区的白天/黑夜） |

---

## 3. 设计

### 3.1 概念：房间 = 她真实状态的场景投影

一句定义：**Room 是一个把 `moodBus` / `emotions.json` / 当前 activity / `current_desire` / Reve / 本地时钟这几路真实信号，实时合成成一个像素房间画面的只读场景层。** 用户看到的不是动画，是"她现在真实的样子被放进了一个房间"。

### 3.2 渲染路线对比（核心架构决策）

| 路线 | 保真度 | 依赖/成本 | 能否位移 | 合 LISA 栈？ | 结论 |
|---|---|---|---|---|---|
| **A. 分层 DOM/CSS 2.5D diorama** | 中 | **零新依赖**，纯 HTML/CSS/少量 JS | 否（她在工位上，靠 CSS 做呼吸/视差/粒子） | ✅ 完全契合（Island 同款） | **✅ v1 选它** |
| B. `<canvas>` 2D 精灵/瓦片引擎 | 中高 | 零依赖但要自写游戏循环 + 瓦片图 + walk-cycle 序列帧 | 是 | ⚠️ 偏离"无引擎"现状 | Phase 3+ 想要"她能走"再上 |
| C. WebGL / PixiJS / Three / Live2D | 高（最像 N0va） | 引入打包器 + 重依赖 + 新美术管线 | 是 | ❌ 破坏无打包器/像素 ethos | **非目标**（v1 明确不做） |
| D. 预渲染视频动态壁纸（N0va 做法） | 高 | 视频资产 + 播放器 | N/A | ❌ 和"真实状态驱动"矛盾 | **非目标**（脚本化、和她无关） |

**选 A 的理由**：零依赖、和现有栈/美学一致、直接复用 114 张立绘当"演员层"、Island 已证明"新自包含 web 界面 + WKWebView 窗"这条路可行。缺点（不能位移）用**氛围动效**（呼吸缩放、眨眼 crossfade、视差、雨雪/萤火粒子、台灯明灭）弥补，对"陪伴/氛围"这个目标足够。

### 3.3 推荐架构：分层 DOM/CSS 2.5D diorama

一个 `/room` 页面，DOM 分层合成（从后到前）：

```
┌─────────────────────────────────────────────┐
│  layer 0  背景墙/地板 (room theme PNG)          │  ← 换景
│  layer 1  窗景 (天气/昼夜: 雨/雪/星空/朝阳)       │  ← weather + 本地时钟
│  layer 2  远景道具 (书架/海报/挂钟)              │
│  layer 3  ★ 她 (现有半身立绘 <img>, 按站位定位)   │  ← moodBus slug
│  layer 4  近景道具 (书桌/台灯/桌上的信/desire 物)  │  ← current_desire + Reve
│  layer 5  氛围光/滤镜 (emotions → 色温/明度)      │  ← emotions.json
│  layer 6  粒子/特效 (雨滴/雪花/萤火/尘光)          │  ← CSS/轻 JS
│  layer 7  UI (最小: 一行状态字 + 关闭)            │
└─────────────────────────────────────────────┘
```

- 每层就是一个绝对定位的 `<div>` / `<img>`；动效用 CSS `@keyframes` + `transform`（视差跟随鼠标可选）。
- 昼夜：读本地 `Date` → 给 layer 5 套 `filter: brightness()/sepia()/hue-rotate()` + layer 1 换窗景。
- emotions → 氛围：把 7 维情绪归一到几个"房间氛围预设"（暖/冷/沉/亮），驱动 layer 5 的 CSS 变量。
- 立绘复用：layer 3 就是现在的 `mascot` `<img>`，`setMood` 逻辑几乎照搬（`lisa-client.ts:726`），只是从"居中大头"变成"坐在工位上"。

### 3.4 房间的"活" —— 状态 → 场景映射表（纯数据，是 Room 的灵魂）

| 真实信号（来源） | 房间表现 |
|---|---|
| `moodBus` = `working-coding`/`working-debugging`（`/api/island/ping`.mood） | 她在**书桌工位**，台灯亮，屏幕蓝光；`chat_start` 时屏幕更亮 |
| `moodBus` = `reading-book`/`studying` | 她在**扶手椅工位**，落地灯，旁边一摞书 |
| `moodBus` = `gaming`/`watching-movie` | 她在**沙发工位**，电视/显示器彩光 |
| `moodBus` = `napping`/`sleeping`/`pajamas` | 她在**床上工位**，房间转夜、调暗 |
| `emotions.json` 高 `weariness` | 整体调暗、暖黄、慢动效 |
| `emotions.json` 高 `curiosity`/`awe` | 冷白提亮、道具上出现"研究中"的小物 |
| `current_desire`（ping.current_desire） | 桌上/墙上出现一个**代表该 desire 的道具 + hover 显示 `what`** |
| `idle_start`（Reve 开始，SSE） | 房间转**深夜**，她"入睡/发呆"，出现"做梦"的柔光 |
| `idle_message` 到达（Reve 有产出） | 桌上出现一封**未读的信**（★ 青点），点开 = 读 `last_idle_message_text` |
| 本地时钟 | 窗外昼夜循环 + 光照 |
| `weather` 类 mood 或（可选）真实天气 | 窗外下雨/下雪/起雾 + 对应粒子层 |
| `online=false`（ping 失败） | 房间**熄灯**，门口一句 "boot Lisa"（不弹错） |

> 这张表就是 Room 与 N0va/BSide 的分水岭：每一行的左边都是**她真实在发生的事**，不是编剧脚本。

### 3.5 交互设计

- **陪伴（同步）**：打开 Room view 就是"进她房间坐一会儿"。她朝你转头（换一张朝向立绘）/ 台灯亮（`chat_start`）。底部一个极简输入框 = 现有 `/chat`（复用，不新建）。
- **异步信件（对标 BSide 写信，但是诚实版）**：
  - **她 → 你**：把 Reve 的「★ WHILE YOU WERE AWAY」/ journal 产出，呈现为"**桌上的信**"。这封信是她**真的**在你离开时写的（`idle_message`），不是模板。点开 = 读，读完标记已读（复用 `/api/island/dismiss-unread`）。
  - **你 → 她**：可选，写一张便签留在桌上，作为下次 heartbeat / Reve 的输入种子（Phase 2+，需接 desire/heartbeat 输入口，非 v1 必需）。
- **换装 / 换景（对标 N0va 皮肤）**：
  - 换装：直接用 `outfit` 立绘（pajamas / formal / lab-coat / raincoat…），v1 只做"跟随状态自动换"（睡觉→pajamas、下雨→raincoat），手动换装 Phase 2。
  - 换景：v1 出 1–2 套房间主题（如"码农书房""靠窗雨屋"），做成可切的 theme，别多。

### 3.6 承载形态：先 GUI 内一个 view，再可选壁纸窗

- **Phase 1**：`GET /room` + 主 GUI 顶部新增 `viewRoom`（和现有 `viewReve` 并列，`lisa-html.ts:76`）。零平台代码，PWA/移动端也能看。
- **Phase 3（可选）**：一个**独立 WKWebView 壁纸/常驻窗**，直接照抄 Island 的 Swift 容器（`packaging/mac-client/Sources/Lisa/Island/IslandWindow.swift`：borderless / 透明 / 置顶 / `canJoinAllSpaces`），把 URL 指向 `/room`，尺寸放大即可。这样就有了 N0va 那种"桌面上的她"。

---

## 4. 数据契约

### 4.1 新增 route

| Method Path | 作用 | 备注 |
|---|---|---|
| `GET /room` | 返回 `ROOM_HTML`（自包含，仿 `/island`） | `server.ts` 加一个分支，仿 `server.ts:695` |
| `GET /assets/room/*` | 房间背景 / 道具像素图 | 走现有静态服务 + SW 预缓存 |
| `GET /api/room/state`（可选） | 一次性返回合成房间需要的聚合状态 | 也可直接复用 `/api/island/ping` + `/events`，v1 尽量不新增 |

### 4.2 复用的实时信号（不新增协议）

- 订阅现有 **SSE `/events`**：`mood` / `chat_start` / `chat_end` / `idle_start` / `idle_message` / `idle_done` / `agent_session_update`。
- 首屏拉 **`/api/island/ping`** 拿 `{online, mood, current_desire, has_unread_idle_message, last_idle_message_text, uptime_sec}`。
- 已读回写复用 **`POST /api/island/dismiss-unread`**。

### 4.3 新增/扩展状态（是否落盘）

- **v1 尽量不落盘**：房间主题 / 换装偏好先存浏览器 `localStorage`（对标 Island 窗口位置存本地）。
- 若要"她自己决定房间长什么样"（很 LISA 的做法）：Phase 2 在 `~/.lisa/soul/` 下加一个 `room.json`（她能通过 soul 工具改），让**换景/布置成为她主权的一部分**——这比用户换皮肤更贴 LISA 设定，但**非 v1**。

### 4.4 不改变的东西

- 不改 soul / emotions / mood / heartbeat / Reve 的任何写入路径——Room 只读。
- 不改 `set_mood` / `moodBus` 语义。
- 不引入打包器 / canvas 引擎 / 新运行时依赖（美术生成走已有的 `sharp` 脚本）。
- 不改 Island；Room 是它的"大号亲戚"，共享 ping/SSE，不互相依赖。

---

## 5. 实施阶段

| 阶段 | 范围 | 交付 | 约估 |
|---|---|---|---|
| **Phase 0 · 美术** | 出 1 套像素房间背景 + 5 件道具（书桌/台灯/窗/床/信）+ 昼夜两版窗景 | `src/web/assets/room/*` | 美术为主 |
| **Phase 1 · Web Room（MVP）** | `GET /room` + `viewRoom` view；分层 DOM/CSS 合成；接 `/api/island/ping` + `/events`；state→场景映射表（§3.4）落成 JS 配置；复用现有立绘当 layer 3 | 打开 GUI 能看到"她在房间里、随真实状态变" | ~1 view + ~1 自包含页 |
| **Phase 2 · 活起来 + 信** | 昼夜时钟光照、emotions→氛围、`current_desire` 道具、Reve"桌上的信"读/已读、跟随状态自动换装、粒子层 | 房间"有生活"，能读她异步写的信 | 增量 |
| **Phase 3 · 壁纸窗（可选，Mac）** | 照抄 Island Swift 容器，新增一个指向 `/room` 的置顶/壁纸 WKWebView 窗 | 桌面常驻的"她的家" | Swift 容器复用 |
| **Phase 4 · 她的主权** | `~/.lisa/soul/room.json` + soul 工具，让**她自己**布置房间 / 选主题 / 决定摆什么 | "房间是她自我表达的一部分" | 接 soul 写入 |

**推荐从 Phase 1 起步**：纯 web、零平台代码、直接复用现有信号和立绘，一个自包含 `/room` 页面就能验证整个概念，风险最低。

---

## 6. 非目标 / 风险

- **美术成本**是最大不确定项：房间/道具像素图要人做（或用 `generate-pixel-assets.ts` 半自动）。v1 靠"1 套主题 + 纯色降级"控制范围。
- **诚实性风险**：一旦为了好看开始"演"她没做的活动，Room 就丢了灵魂。守则：**map 表左列只能是真实信号**（§3.4）。
- **性能**：WKWebView 里多层 + 粒子 + 常驻，注意别跑满 CPU（Island 已有全屏/录屏让位 + hover 轮询节流的先例可抄）。
- **范围蔓延成游戏**：位移 / 瓦片地图 / 可交互家具很诱人，但那是 canvas 引擎（路线 B），明确压到 Phase 3+，别在 v1 碰。
- **定位漂移**：任何"AI 女友/桌宠"话术都要避免。文案统一走"她的家 / 她在生活"，不走"你的虚拟伴侣"。

## 7. 开放问题

1. 昼夜用**她的本地时区**还是**用户时区**？（倾向她的——更诚实，她是独立个体。）
2. 天气用真实天气 API 还是只跟 `weather` 立绘？（v1 只跟立绘，不引外部依赖。）
3. Room 和 Island 的关系：Room 是"Island 展开的大版"，还是独立入口？（倾向独立 view + 可选独立窗，两者共享 ping。）
4. "桌上的信"要不要把 journal（私密）也露出？（**不**——journal 明确不进任何视图，只露 Reve 的 `idle_message`。）
5. 立绘是半身像，坐进房间的**构图/裁切**怎么处理才自然？（可能需要少量"下半身/坐姿"补图，或用道具遮挡下缘——Phase 0 美术要定。）

## 8. 推荐起点

一句话：**先写 `src/web/room.ts`（仿 `src/web/island.ts` 的自包含模式），在 `server.ts` 挂 `GET /room`，用 `/api/island/ping` + `/events` 驱动一个 6 层 DOM/CSS diorama，layer 3 直接复用现有 `setMood` 立绘逻辑。** 一个页面跑通"她随真实状态变"，就验证了整个 Room。美术先上 1 套主题 + 纯色降级。

## 9. Glossary

- **Room**：本功能。她真实状态投影成的像素房间场景层。
- **diorama（2.5D）**：多层 2D 图像叠出的伪立体场景（背景/中景/角色/前景/光/粒子分层）。
- **站位（station）**：房间里的功能工位（书桌/扶手椅/沙发/床/窗前），由当前 activity 立绘映射。
- **moodBus**：内存态的"当前可见立绘 slug"（`src/mood-bus.ts`），非持久。
- **emotions.json**：持久的 7 维内在情绪向量（`~/.lisa/soul/emotions.json`），Room 的氛围来源。
- **Reve**：她在你离开时的自主反思/"做梦"循环（`src/reflect.ts` / `docs/PLAN_REVE_v1.0.md`），产出「★ WHILE YOU WERE AWAY」→ Room 里的"桌上的信"。
- **Island**：已有的常驻悬浮小窗（`src/web/island.ts` + Swift `Island/*`），Room 的直接先例与共享数据源。
