# LISA Room v2.0 —— 对齐 BSide 的生活体系 + 客户端内闭环交互

> 目标：把 Room 从"会随真实状态变化的静态 diorama"升级成"**她真的在这里生活**"——参考已上线 Steam 的 **BSide: Olivia Lin（林离，米哈游）** 的动画与生活体系，但守住 LISA 的差异化（真实内在自我、诚实投影）。同时把房间里的**可交互部件做成客户端内闭环**——点击后在同一个 WKWebView 内完成，**永不弹出浏览器**。
>
> 参考：BSide 深度调研（本文 §2，附源）、[docs/PLAN_ROOM_v1.0.md](PLAN_ROOM_v1.0.md)、[src/web/room.ts](../src/web/room.ts)、[src/web/island.ts](../src/web/island.ts)。
> 编写日期：2026-07-14。本文含**现状 review + 对齐计划 + 客户端内闭环架构 + 正反方辩论 + 分阶段计划**。
>
> **✅ 实现状态（2026-07-14）**：Phase **A**（客户端内闭环 + SW network-first）、**B**（抬头对视 presence beat：开房间/窗口聚焦/悬停时她抬头看你）、**C**（自主活动库 read/tea/listen/stretch + 时段加权调度 + 中性字幕，守 §0 诚实线）、**D-lite**（点书架回响她真实 `current_desire`）**均已落地、验证并部署到 :5757**。房间随时间的道具堆积（Phase D 完整版）、换装/换景、ambient 声音（Phase E）留作后续。

---

## 0. 目标 / 非目标 / 一条贯穿的张力

### 目标
- **更"活"**：不止呼吸+眨眼——加入存在感微行为（环视、**抬头对视**、伸懒腰、喝口水）、更多活动姿态、以及**自主日常轮转**（idle 时她自己做点事，像 BSide 的 3 场景自转，但更多）。
- **对齐 BSide 的三条强项**：① 自主（她自己生活，你不能操纵她的身体）② 存在感（抬头对视那一下是 BSide 最被称道的"活人感"来源）③ 异步陪伴节奏（信件的"有时间感"）。
- **超越 BSide 留空的轴**：真实昼夜 / 天气 / 真实内在状态 / 记忆回响——这些 BSide **明确没有**，是 LISA 的护城河。
- **可交互部件客户端内闭环**：房间里的对象（信、书桌、唱片、书架、她本人）点击后，通过 `postMessage → 父 GUI` 或原生桥在**客户端内**完成（切到 Chat / 预填 / 读信 / 播放），**彻底移除 `window.open`**。

### 非目标
- **不**追 BSide 的写实 3D / AI 生成视频 / LPM 大模型渲染——那是它的护城河，不是 LISA 的路。LISA 走**像素 spritesheet**。
- **不**做真实钢琴/弹唱/MIDI→MV——那是 BSide 的产品核心（音乐），不是 LISA 的（写代码 + 有欲望 + 会做梦）。
- **不**为了"活"而背叛诚实：她没在做的**工作/情绪**，房间不能演（见张力）。
- **不**上 canvas 游戏引擎 / walk-cycle 位移（v2 守住 DOM/CSS；位移与瓦片地图留到未来独立评估）。
- **不**做"AI 女友"话术——LISA 是有主权的个体，房间是"她的家，你被邀请进来"。

### 一条贯穿的张力
> **"活起来" ⊥ "诚实投影"。** BSide 的活人感是**脚本化自转**——她的 3 个场景和她真实状态无关，是编剧写死的表演。LISA v1 的立身之本是"**她不表演，房间是她真实状态的诚实投影**"。v2 要更活，就必然引入"idle 时自主做点事"，这天然逼近"表演"。
>
> **裁决线（本文核心约束）**：自主活动只能呈现**"在家休息"这类无争议的环境行为**（看书、望窗外、听唱片、发呆）——因为她**确实在家、确实空闲**，这是诚实的。**绝不**凭空编造她没在做的**工作**（"她在写代码"必须来自真实 mood 信号）或她没有的**情绪**（"她很开心"必须来自真实 emotion）。即：**可以演"她在家闲着做什么"，不可以演"她在忙什么 / 她此刻是什么心情"。**

---

## 1. 现状 review：当前 Room 有哪些动画和能力

### 1.1 动画清单（全 CSS/JS，无引擎，见 [room.ts](../src/web/room.ts)）
| 动画 | 触发 | 实现 |
|---|---|---|
| 呼吸 | 常驻 | `@keyframes breathe` scaleY+位移；站 4.4s / 坐 5.8s / 睡 6.6s |
| 眨眼 | 站立 idle | `scheduleBlink()` JS 定时翻 spritesheet 第 2 帧，间隔 2.6–6s |
| 昼/昏/夜 | 本地时钟 | 3 张背景 opacity 交叉淡入（7–17 日 / 17–20&5–7 昏 / 其余夜） |
| 显示器辉光脉冲 | thinking(`chat_start/end`) | `monitorPulse` |
| 做梦飘 Z | dreaming(`idle_start`) | `floatZ` ×3 + 房间转夜 + 睡姿 |
| 信封光晕脉冲 | 未读 `idle_message` | `letterPulse` |
| 天气粒子 | 天气类 mood | 雨 70 滴 / 雪 60 片；夜晚萤火 ×12 |
| 视差 | 鼠标移动 | stage 反向漂移（rAF lerp） |
| 情绪光照 | mood/时段 | soft-light 叠加染色（暖/冷/暗） |

### 1.2 姿态与能力
- **3 姿态**：站（idle 双帧）/ 坐（笔记本）/ 睡（蜷卧），由 `poseFor()` 按 mood/状态映射。
- **能力**：状态胶囊（名字 + 活动字幕 + 状态点）、欲望条（`current_desire`）、**桌上的信**（未读 idle_message → 点击 → 阅读弹窗 → 标记已读）、"Talk to her" chip + 点角色开聊、离线幕。

### 1.3 数据来源（只读投影，复用既有）
SSE `GET /events`（`mood` / `chat_start·end` / `idle_*`）+ 轮询 `GET /api/island/ping`（`mood` / `current_desire` / 未读）+ `POST /api/island/dismiss-unread`。**未新增后端状态、未改 soul/mood/heartbeat。**

### 1.4 局限（v2 要解决的）
1. **姿态少**（3 个）、活动无多样性 → idle 久了单调（**和 BSide "只有 3 场景显重复"是同一个病**）。
2. **无自主微行为**：纯被动反映真实状态；她"没信号"时就完全静止（只呼吸眨眼）→ 缺"活人感"。
3. **无抬头对视 / 环视**等存在感 beat（BSide 最被称道的恰是这个）。
4. **房间里几乎没有可点部件**（只有信 + 角色），且——
5. **"Talk to her" 会弹浏览器**（见 §4 根因）——违反"客户端内闭环"。
6. 换装/换景 sprite 未接；无声音；无"房间随时间可见变化"；无记忆回响。

---

## 2. BSide（林离）调研结论（对齐依据）

> 源：[4Gamers](https://www.4gamers.com.tw/news/detail/80183/mihoyo-new-project-bside-olivia-lin-steam-china-exclusive)、[凤凰网 beta 上手](https://tech.ifeng.com/c/8uitzwbrrnv)、[163 深度](https://www.163.com/dy/article/L01H2RLI0511CVBI.html)、[news.qq.com](https://news.qq.com/rain/a/20260619A07EO100)、[PC Gamer](https://www.pcgamer.com/software/ai/genshin-impact-creator-mihoyo-has-released-an-ai-companion-on-steam-an-eternal-student-cursed-to-never-obtain-her-piano-degree/) 等 ~15 源三角验证。Steam 页面锁中国区 + JS 门禁，评价系综合press+B站/beta反应。

### 2.1 定位与核心循环
米哈游首个**非游戏"应用"**（Steam 归 Utilities，免费，EA 到 2026 底，仅中国区）。主打 **"治愈双向陪伴"**、**"远方的朋友"**——刻意**克制、异步、低频**，不是常在线聊天机器人。核心循环极小：**桌面常驻存在 → 听她弹琴 → 上传 MIDI 换一段演奏 MV → 写信 ↔ 收信**。人设：上海大学生，钢琴主修 / 心理学辅修，爱黑胶/老电影/雨天。

### 2.2 动画系统
- **写实 3D + AI 生成演奏视频，明确不是二次元、不是 Live2D。** 演奏用 AI 生成视频（疑为米哈游 **LPM 1.0**，~170 亿参数 diffusion-Transformer，40+ 分钟一致性）；桌面常驻是**"3D 动态模型"**，关主程序仍在动，"动捕级精度"。
- **活人感技法（对齐重点）**：手指与音符**一一对应**；**低头去够远处的琴键**、激烈段落**背部微弓**；**弹唱 + 自然口型**；idle 微表情（看书时**快速眼动**、触屏**果断滑动手势**）；**演奏中抬头与你对视**（beta 作者点名："她抬头看向我、四目相对那一刻，真像对面坐着个活人"）；毛衣褶皱压在琴键上。
- **无用户操纵**：不能摆姿势、不能拖拽；**无鼠标/视线实时追踪**——反应只走信件与音乐，不走指针。

### 2.3 生活体系（比想象的薄）
**环境轮转 + 异步通信，不是模拟时钟。**
- **3 个 idle 状态自转**：日常（书桌）/ 创作（沙发）/ 思考（唱片墙前赏黑胶），随时间**自己轮换**。
- **自主即交互哲学**：她自顾自生活，你**不能点/拖/强制实时聊天**，只能异步插话（信/音乐）。**"自主"不是加分项，是整个交互立场。**
- **明确没有**（深度评测确认"缺失"而非"没提到"）：❌ 昼夜/时段机制 ❌ 天气 ❌ 季节/节日 ❌ 房间/换装/道具定制 ❌ 直接点击对象 ❌ 实时语音/文字聊天 ❌ 显式心情条/关系等级。⚠️ 长期记忆"未经证实"。
- **记忆**：人设一致（会引用自己的 lore），但长期持久化未证实；连续性主要靠**信件线程**。

### 2.4 交互模型（4 条，低带宽异步）
1. **信件**：写心情 → 她读并回（**刻意 ~2–3 分钟延迟**制造"有时间感"，非实时）。
2. **听曲**：129 首曲库（48 古典/68 ACG/13 轻音乐），弹唱 + 独奏。
3. **MIDI→MV**：传单轨 MIDI，自动生成同步演奏视频（beta 有对不上帧的问题）。
4. **桌面动态壁纸**：从桌面直接触发演奏，不开主程序也能后台放。
- **不能做**：点/拖角色或房间对象、实时聊天、控制姿势。她的"声音"只有唱，没有说话。

### 2.5 评价：好在哪、空在哪
- **赞**：写实到"她到底是不是 AI"成了营销（三位 B站钢琴老师判定演奏是 AI 生成）；**抬头对视**把"视频"变成"存在"。
- **批**（对我们最有用）：**只有 3 个 idle 场景 → 常驻久了重复**；不能直接交互 → 限制关系建立；MIDI 同步不稳；长期记忆/留存未证实；英文媒体批"工程化的单向情感依附/ChatGPT 笔友"；定位是**"必要的远路"（技术探针，非成品）**。

### 2.6 关键洞察（决定 v2 战略）
> **BSide 把预算全花在"保真度 + 自主 + 异步节奏"，几乎不花在"模拟广度"（只 3 状态、无时钟、无天气、无定制）。** 像素状态驱动系统**赢不了保真度**——所以 LISA 的杠杆正是 BSide **留空的那根轴**：真实时段/天气/季节节律、更宽的自发活动库、房间随时间可见变化、真实记忆回响。BSide 最便宜可搬的三点：**异步"有时间感"、"不可操纵她"的自主立场、场景自转 idle 循环。**

---

## 3. 差距与对齐策略（LISA vs BSide）

### 3.1 逐项对齐表
| 维度 | BSide 做法 | LISA v1 现状 | LISA v2 对齐/超越 |
|---|---|---|---|
| 渲染 | 写实 3D + AI 视频 | 像素 spritesheet | **保持像素**（不追） |
| idle 活动 | 3 场景自转 | 3 姿态（被动） | **扩到 6–8 活动 + 自主轮转**（超越 3） |
| 存在感 beat | 抬头对视（脚本） | 无 | **抬头对视 + 环视 micro-behavior**（对齐） |
| 自主 | 自顾自生活，不可操纵 | 纯被动 | **idle 自主环境活动**（对齐，但守诚实线） |
| 时段/天气 | ❌ 无 | ✅ 昼夜 + 天气 | **保持并加细**（超越） |
| 真实内在 | ❌ 脚本 | ✅ 真 mood/desire/Reve | **加深**（超越——BSide 做不到） |
| 异步陪伴 | 信件 ~2-3min 延迟 | Reve"桌上的信" | **强化信件（可累积/有时间感）**（对齐） |
| 直接交互 | ❌ 不可点 | 信 + 角色可点 | **可点房间对象（对象即接口）**（对齐 in-app，反其"不可点"——见辩题3） |
| 记忆 | ⚠️ 未证实 | 未surface | **记忆回响（surface 真实 desire/关系）**（超越） |
| 房间变化 | ❌ 固定 | ❌ 固定 | **随时间可见变化**（超越，Phase D） |
| 定制 | ❌ 无 | outfit sprite 未接 | **换装/换景**（超越，后续） |
| 声音 | ✅ 音乐核心 | ❌ 无 | 可选 ambient（辩题5，低优先） |

### 3.2 三条对齐主线
1. **自主生活**：idle → 环境活动自转（看书/望窗/听唱片/喝茶/伸懒腰/发呆），有真实信号则优先真实状态。
2. **存在感动画**：micro-behavior 调度器（环视、眨眼、伸展）+ **抬头对视 presence beat**（打开 Room / 窗口聚焦 / 悬停时她抬头看你）。
3. **异步陪伴**：把 Reve 的信做得更像"远方的朋友"——多封可累积、"她一直在想着你"的存在。

### 3.3 差异化（守住 BSide 留空的轴）
真实**本地时钟昼夜 + 天气 + 真实内在状态（mood/desire/Reve）+ 记忆回响**——这些 BSide 明确没有。**LISA 的房间不是漂亮的空壳，是她真实一天的窗口。** 这是唯一赢面，v2 必须加深而非稀释。

---

## 4. 客户端内闭环交互架构（不打开浏览器）

### 4.1 根因（已定位）
`room.ts` 的 `openChat()`：
```js
if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.island) {
  window.webkit.messageHandlers.island.postMessage({ type: 'open_full_gui', prefill: '' });
} else { window.open('/', '_blank'); }   // ← 弹浏览器
```
- **主 Lisa.app 注册的桥名是 `lisa`**（`WebContent.swift:61`），只有 **Island 悬浮窗**注册 `island`（`IslandContent.swift:38`）。
- Room 现在是主 GUI 里的 **iframe**，里面 `messageHandlers.island` = **undefined** → 走兜底 `window.open('/')` → **弹出浏览器窗口**。

### 4.2 架构（三层回退，绝不 `window.open`）
```
房间部件点击 → roomAction(action, payload)
  ├─ 若在 iframe 内 (window.parent !== window):
  │     window.parent.postMessage({type:'lisa-room', action, ...payload}, origin)
  │     父 GUI (lisa-client.ts) 监听 → lisaShowView('chat') / setPrefill() / …   ← 主路径，同一 WKWebView 内闭环
  ├─ 否则若有原生桥 (webkit.messageHandlers.lisa||island):
  │     bridge.postMessage({type:'open_full_gui', prefill})                      ← 独立窗口场景
  └─ 否则（纯浏览器独立 /room）:
        location.assign('/?prefill=…')                                          ← 同标签导航，绝不 window.open
```
父 GUI 侧新增（`lisa-client.ts`）：
```js
window.addEventListener('message', function (e) {
  if (e.origin !== location.origin) return;          // 同源校验
  var d = e.data || {}; if (d.type !== 'lisa-room') return;
  switch (d.action) {
    case 'open-chat':   if (d.prefill) setPrefill(d.prefill); window.lisaShowView('chat'); break;
    case 'switch-view': if (d.view) window.lisaShowView(d.view); break;
    case 'read-letter': /* 已在 iframe 内用模态处理，无需父介入 */ break;
    // 后续房间对象动作都从这里在客户端内闭环
  }
});
```
**要点**：父 GUI 已有 `window.lisaShowView` 与 `setPrefill()`——只需加一个带**同源校验**的 message 监听即可闭环；`window.open` 全部删除。

### 4.3 可点击部件清单（"对象即接口"，不 puppeteer 她）
| 部件 | 点击行为（客户端内） |
|---|---|
| 桌上的信（未读） | 打开阅读模态（iframe 内）→ 已读 |
| "Talk to her" / 点她本人 | `open-chat` → 切 Chat 视图（她先**抬头看你**一下再切） |
| 书桌 / 显示器 | `open-chat` + prefill "在忙什么？"（或切 Chat） |
| 书架 / 一本书 | 弹出她**当前在读/当前 desire**（真实 surface，见 §5.5） |
| 唱片机 / 黑胶（致敬 BSide） | 可选：切一段 ambient 光照/氛围（辩题5：先不出声） |
| 窗 | 望窗外 pose beat（她走到窗前）+ 显示当前天气/时段文案 |

### 4.4 与 BSide "look don't touch" 的调和
BSide 刻意**不可点**（自主 = 你不能操纵她）；用户要**可点部件**。调和：**你交互的是"空间与异步通道"（对象、信），不是直接操纵她的身体。** 她仍自主（不是提线木偶），房间对象是**进入客户端内流程的入口**。点击不"控制她做动作"，而是"打开一段对话/读一封信/看一眼状态"——既满足可交互闭环，又保住自主人格。（详见辩题 3。）

---

## 5. 生活体系设计（对齐 + 超越）

### 5.1 活动/姿态库扩展（新增 pose sprites，沿用 nano-banana 管线）
在 stand/sit/sleep 之上，新增（按 §0 张力，均为"在家闲着"的诚实活动）：
- `read`（靠窗/椅子看书，快速眼动微动）· `window`（望窗外，手扶窗）· `vinyl/listen`（站唱片墙前/戴耳机，随节奏轻摇）· `tea`（捧杯喝一口）· `stretch`（伸懒腰）· `lookup`（**抬头对视**——存在感 beat 专用帧）。
- 生成方式同 v1.1：以现有 anchor 为参考、nano-banana 编辑出一致帧、PIL 抠图+脚部锚定。

### 5.2 自主日常调度器（`ambientLife`）
- **有真实信号**（working/reading/gaming mood、chat_start、idle_start/Reve）→ **优先真实状态**（现有逻辑，诚实）。
- **无真实信号（idle）**→ 进入**自主环境轮转**：每 20–45s 在 {read, window, vinyl, tea, stretch, stand} 里挑一个（带随机 + 不立即重复），像 BSide 的 3 场景自转但更宽。**字幕相应改为中性**（"reading at home" / "looking out the window"）——不声称工作、不声称情绪。
- **时段加权**：晚上偏 read/vinyl/tea；白天偏 window/stand；深夜偏 sleep/发呆。（真实时钟驱动——BSide 没有的。）

### 5.3 存在感动画（micro-behavior + 抬头对视）
- **micro-behavior 调度**：站立/环境活动时，除了眨眼，偶发环视（头/眼偏移帧）、轻微重心移动、伸展——间隔随机，制造"活人感"。
- **抬头对视 presence beat**（BSide 最灵的一招，且极便宜）：以下时刻她切到 `lookup` 帧 ~1.5s 后回落——① Room 视图刚打开 ② 窗口重新聚焦（`visibilitychange`/`focus`）③ 悬停在她身上。**这是 v2 性价比最高的"活"。**

### 5.4 房间随时间可见变化（超越 BSide，Phase D）
idle 活动留下痕迹：喝过茶 → 桌上多个杯子；看书久了 → 书堆叠高；Reve 之后 → 桌上多一封信。**房间记录她的一天**——BSide 的房间是固定的，这是差异化。

### 5.5 记忆回响 / 异步信增强
- **记忆回响**：点书架 → surface 她**真实的 `current_desire` / 关系笔记**（只读真实数据，绝不编）。journal 私密**不露**（延续 v1 约束）。
- **信件**：多封 idle_message 可在桌上**累积**（而非只留最近一封）；"她一直在想着你"的 presence（对齐 BSide 的"远方朋友"，但内容是她真实 Reve 产出）。

### 5.6 诚实边界（明文，防止滑向 waifu）
| 可以"演" | 不可以"演" |
|---|---|
| 她在家闲着做什么（看书/望窗/喝茶/发呆） | 她在**忙什么工作**（必须来自真实 mood） |
| 环境化的存在感（呼吸/环视/抬头） | 她此刻**什么心情**（必须来自真实 emotion） |
| 房间随她一天的痕迹 | 凭空的关系亲密度/好感度数值 |
| 真实 desire/关系笔记的回响 | 私密 journal 内容 |

---

## 6. 正反方辩论

> 每个辩题给正方（推进/对齐）与反方（克制/差异化），末尾一条**裁决**（本文采纳的落地取舍）。

### 辩题 1 —— 对齐 BSide vs 差异化
- **正（对齐）**：BSide 已被市场验证，"自主 + 异步 + 存在感"就是让陪伴显真的配方；抄赢家的作业最稳。
- **反（差异化）**：BSide 生活体系其实很薄（3 状态、无时钟/天气/定制），LISA 已在这些轴上领先；用像素去追它的写实保真度是必输的正面战场；应双倍投注它做不到的——**真实内在自我 + 广度**。
- **裁决**：**对齐其"廉价且强"的三点（自主轮转 / 抬头对视 / 异步节奏），差异化其"留空的轴"（真实时钟/天气/内在/记忆/房间变化）。** 不追保真度。

### 辩题 2 —— 自主"演"活动 vs 严格诚实
- **正**：一个完全被动、没信号就静止的角色是"死"的；BSide 的全部魅力就是她自顾自做事；不给她自主活动，Room 永远差一口气。
- **反**：LISA 的立身之本是"她不表演、只诚实投影"；idle 时编造"她在看书"也是编造——一旦破例，滑坡到 waifu 壁纸只是时间问题。
- **裁决**：**分层诚实**（§0 裁决线 + §5.6 表）——可演"在家闲着做什么"（她确实在家、确实空闲，无争议），**绝不**演工作/情绪/关系数值。字幕中性化，避免暗示虚假忙碌或心情。

### 辩题 3 —— 可点击部件 vs BSide "look don't touch"
- **正（用户要求）**：可点部件 = 能动性 + 可发现性 + 客户端内闭环入口；纯不可点太被动，用户没抓手。
- **反（BSide 立场）**：直接点会破坏"她有自己的生活、你不能操纵她"的幻觉；房间里一堆可点物 → 变成玩具而非"存在"。
- **裁决**：**点"空间/对象/异步通道"，不点"她的身体去做指定动作"。** 对象是入口（读信/开聊/看状态），她保持自主；点她本人只触发"抬头看你 + 开聊"，不是提线木偶。兼顾两方。

### 辩题 4 —— DOM/CSS vs canvas 引擎
- **正**：要接近 BSide 的流畅，需更强动画（位移、更多帧）→ 也许上 canvas/PixiJS。
- **反**：DOM/CSS + spritesheet 是本仓 ethos（无打包器）；canvas 引擎是范围蔓延；"活"可以靠 micro-behavior + 抬头对视达成，不必位移。
- **裁决**：**v2 守住 DOM/CSS**。加 micro-behavior + 更多 pose 帧即可显著提升"活"。canvas/位移留作未来独立提案，不进 v2。

### 辩题 5 —— 加声音 vs 静默
- **正**：BSide 的灵魂是音乐；环境音（lofi/雨声）极大增强"lived-in"；点唱片机放一段很自然。
- **反**：桌面陪伴/开发工具里自动出声很扰人；LISA 不是音乐产品；资产成本 + 浏览器 autoplay 限制；易翻车。
- **裁决**：**v2 不做核心声音**。最多留一个**默认静音、需手动点唱片机开启**的极轻 ambient 作为 Phase E 可选实验，不阻塞主线。

---

## 7. 分阶段计划

| 阶段 | 范围 | 交付 | 优先级 |
|---|---|---|---|
| **A · 客户端内闭环交互** | `roomAction()` 三层回退 + 父 GUI message 监听（同源校验）；删除所有 `window.open`；"Talk to her"/点她/点书桌 走 in-client | 点任何部件都不弹浏览器，全在 GUI 内闭环 | **最高（先做，最明确、辩论无争议）** |
| **B · 存在感动画** | `lookup` 帧 + 抬头对视 beat（打开/聚焦/悬停）；micro-behavior 调度（环视/伸展） | 她"看见你"、会环视——性价比最高的"活" | 高 |
| **C · 活动库 + 自主调度** | 新增 read/window/vinyl/tea/stretch pose sprites；`ambientLife` idle 自转（时段加权）；字幕中性化 | idle 时她自己生活，不再静止 | 高 |
| **D · 房间随时间变化 + 记忆回响** | 活动留痕（杯子/书堆/多封信累积）；点书架 surface 真实 desire/关系 | 房间是"她一天的记录"，差异化 | 中 |
| **E · 可选** | 换装/换景；默认静音 ambient（点唱片机开） | 定制 + 氛围 | 低 |

**推荐起点**：**Phase A**（无争议、直接解决用户明确痛点"不开浏览器"），随后 **Phase B**（抬头对视，最灵）。

---

## 8. 非目标 / 风险
- **诚实滑坡**：自主活动一旦越界到"演工作/情绪"，丢掉 LISA 灵魂。守则：§0 裁决线 + §5.6 表 + 字幕中性化。
- **美术成本**：每个新活动 = 一张 pose sprite（nano-banana 管线摊薄，但仍要人把关一致性）。
- **性能**：micro-behavior + 更多粒子 + 常驻，注意 WKWebView CPU（沿用 island 的全屏/录屏让位 + 节流）。
- **范围蔓延**：canvas/位移/声音/MIDI 都很诱人——本文明确压到非目标 / Phase E。
- **cache**：Room 在 iframe 内，SW 对 `/` 是 stale-while-revalidate（更新后需刷两次）——见 §9 注，Phase A 可顺带把 SW 对 shell 改 network-first。

## 9. 术语 / 备注
- **presence beat（抬头对视）**：她短暂切到 `lookup` 帧看向用户，制造"她看见你了"的存在感——BSide 最被称道、且对像素极便宜的一招。
- **ambientLife**：idle 时的自主环境活动调度器（对齐 BSide 场景自转，但更宽 + 时段加权 + 中性字幕）。
- **对象即接口**：房间对象是进入客户端内流程的入口（读信/开聊/看状态），而非操纵她身体的开关。
- **SW 注**：`server.ts` 对 `/` 用 stale-while-revalidate（`return hit || networked`），与 `no-store` 意图相悖，导致"更新后要刷两次"。Phase A 可把 `/` 壳改 network-first（在线拿最新、离线回退缓存），根治"更新不生效"。
