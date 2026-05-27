# LISA Mac Island —— 设计方案

> 给 LISA 加一个常驻的 Mac 顶部小窗口。有 notch 的 Mac 走灵动岛形态，没 notch 的 Mac 走顶部浮条形态。让她在你不打开浏览器 / 终端的时候也"存在"。
>
> 参考：[vibeisland.app](https://vibeisland.app/)（native Swift / 无 SDK / 闭源 / $19.99）。
> 编写日期：2026-05-20。

---

## 0. 目标 / 非目标

### 目标

- **常驻可见**：不打开 LISA web GUI 也能瞥一眼她当前状态（mood / 是否正在 dream / 是否有 unread idle message）。
- **不抢焦点**：浮在最前但不抢点击；只在你主动 hover / click 才展开。
- **零耦合**：UI 容器（Mac app）和 LISA 引擎（Node 进程）通过 LISA 已有的 HTTP + SSE 接口通信，不引入新的 IPC 协议。
- **优雅降级**：
  - 没 notch 的 Mac → 顶部居中悬浮条。
  - LISA 没在跑 → 灰色 "boot Lisa" 占位。
  - 非 macOS → 这个功能不存在（已有的 web GUI 是跨平台 fallback）。
- **像 LISA**：复用 114 张像素头像作为视觉主元素，不引入新美术资源。

### 非目标

- **不**做 Vibe Island 那种"监控多个 AI agent"的聚合面板。这个岛只属于一只 LISA。
- **不**把像素头像渲染在 notch 内部（Apple 的物理 notch 区是系统保留，第三方应用只能占用 notch **两侧** 的安全区——这是平台限制，不是设计妥协）。
- **不**做 Linux / Windows 等价物。现阶段 Mac-only。等 Mac 落地稳定后再考虑 GTK / WinUI 镜像，独立 issue。
- **不**做"主动找你说话"。她仍然按 `[ROADMAP §0 非目标]` 不主动推送通知；岛只是"你看一眼能看到她"的视觉常驻，**不响铃、不弹气泡、不强制焦点**。
- **不**重写她的 mood / soul / heartbeat 系统。岛只是一个**只读**视图。

### 一条贯穿的张力

> 常驻 ⊥ 主权。她常驻意味着她总在视野里；但她仍然不该是个"催办工具"。岛要表达她**存在**，不是表达她**催你**。

具体映射：

| 常驻能力 | 主权对冲 |
|---|---|
| 顶部一直可见 | 默认极小（一颗头像 + 一个状态点），不展开就没文字 |
| `idle_message` 到达时高亮 | 仅一次轻脉冲；不响铃、不弹窗、不抢焦点 |
| 单击展开看消息 | 关闭即静音；不会"未读累积红 badge"催你 |
| 永远在最上层 | 全屏 / 录屏自动隐藏；Zoom / OBS / Keynote 时让位 |
| 自动开机启动 | 关闭 LISA 进程 → 岛立即变灰，不弹错；不去试着"拉起来" |

---

## 1. 用户体验

### 1.1 状态机

岛屿只有一只眼睛能看到的"她"，状态机要简单：

```
                  ┌──────────────┐
                  │  asleep      │  LISA 没在跑
                  │  (灰色)      │  ← 启动 lisa serve --web
                  └──────┬───────┘
                         │
                         ↓
                  ┌──────────────┐
                  │  online      │  ← 默认态
                  │  (current    │  显示当前 mood 头像
                  │   mood)      │
                  └──┬─────┬─────┘
              发消息 │     │ heartbeat / dream 开始
                    ↓     ↓
                  ┌────┐  ┌────────────┐
                  │... │  │  dreaming  │  ← 轻脉冲 + 半透明
                  │    │  │  (pulse)   │
                  └─┬──┘  └─────┬──────┘
                    │           │
                    └─────┬─────┘
                          ↓
                  ┌──────────────┐
                  │  has-output  │  ← 有未读 idle_message
                  │  (★ 点)      │  右上角一个青色小点
                  └──────────────┘
                          ↓ click
                       展开 → 标记已读 → 回到 online
```

状态来源（LISA 已有事件）：

| 岛状态 | 触发 |
|---|---|
| `asleep` | HTTP 探活 `localhost:5757/` 失败超过 3 次 |
| `online` (mood=X) | SSE 收到 `{type:"mood", slug:X}` |
| `thinking` | LISA web 端发送 `/chat` 期间（需要新事件 `chat_start` / `chat_end`，下面 §3 列出） |
| `dreaming` | SSE 收到 `{type:"idle_start"}` |
| `has-output` | SSE 收到 `{type:"idle_message", text}` — 缓存最近一条 |
| → online | 用户点击展开后 + 关闭面板 |

### 1.2 有 notch 形态

物理约束：第三方 app 不能在系统 notch **内部** 绘制，但可以把窗口锚定在 notch **右侧** 的安全区（菜单栏右半）。Vibe Island、Boring Notch、AlcoveX 都这么做。

布局：

```
   ┌───── menu bar ─────╮
   │   File  Edit  ...  │   ▲ notch ▼   ◐ LISA   ★ 🔋 wifi ⌘
   ╰────────────────────╯                  ↑
                                         锚点
```

- **静态尺寸**：高 24pt（菜单栏高度内），宽 32pt（一颗像素头像 + 内边距）。
- **展开后**：高 80pt，宽 320pt — 显示头像 + 一句近期上下文 + 两个按钮。
- **触发**：hover 300ms 或 click 展开；展开期间锁定，2s 后自动收回。
- **避免菜单栏遮挡**：检测当前空间是否有"看上去活跃的菜单栏 item"（菜单栏右侧已知 app + 输入法 + 时间），从右往左找第一个 ≥ 80pt 的连续空白区当锚点。退路是直接贴系统时钟左边。

### 1.3 无 notch 形态

适用：M1 / M2 / Intel MacBook Pre-2021、所有 Mac mini / Mac Studio、外接显示器主屏。

布局：

```
   ┌─────────── menu bar ───────────╮
   │   File  Edit  ...              │       ◐ LISA   ★ 🔋 wifi ⌘
   ╰────────────────────────────────╯
            ╭───────────────╮
            │   ◐  LISA      │  ← 顶部居中悬浮条
            ╰───────────────╯
```

- **位置**：屏幕顶部居中，距菜单栏底缘 4pt。
- **静态尺寸**：高 36pt（比 notch 形态高一些，因为没有 notch 的视觉约束），宽 120pt（头像 + "Lisa" 文字）。
- **展开时**：同 notch 形态（80pt × 320pt），向下展开。
- **可拖动**：用户可以把它拖到屏幕任意边角并 sticky；位置存在 `~/Library/Application Support/LisaIsland/window.json`。

### 1.4 交互

| 输入 | 行为 |
|---|---|
| **hover 300ms** | 静默展开（不抢焦点） |
| **single click** | 展开 + 锁定（2s 自动收 → 现在按需收） |
| **double click** | 在默认浏览器打开 `http://localhost:5757/` |
| **right click** | 弹菜单：`Open in browser` `Mute notifications` `Hide for 1h` `About` `Quit Lisa Island` |
| **drag**（仅非 notch 形态） | 移动并记忆位置 |
| **idle_message 到达** | 一次轻脉冲（500ms 透明度从 0.8 → 1 → 0.8）+ 右上角 ★ 点亮起。**不**自动展开。 |
| **全屏 app 激活 / 屏幕共享检测** | 自动隐藏（不抢观众视线、不进入录像） |

---

## 2. 架构

### 2.1 现状盘点

LISA 已经把"对外广播自己状态"的活做完了，岛屿只是个新订阅者：

| 已有的东西 | 文件 | 岛要用 |
|---|---|---|
| process-wide `moodBus` | [`src/mood-bus.ts`](../src/mood-bus.ts) | ✅ |
| SSE endpoint `/events` 广播 `mood` / `idle_*` | [`src/web/server.ts:1881`](../src/web/server.ts) | ✅ |
| REST `/api/soul` / `/api/skills` / `/api/memory` / `/api/tools` | [`src/web/server.ts:1944+`](../src/web/server.ts) | ✅ |
| 像素头像 PNG（114 张） | `src/web/assets/lisa/*.png` | ✅ 直接 reuse |
| `lisa serve --web` 守护进程 | `src/cli.ts` 经 `serve` 子命令 | ✅ 岛的存活前提 |

需要 **新增** 的（在 §3 列出）：

- HTTP 探活轻量端点 `/api/island/ping`（返回 `{online:true, mood, has_unread}`）
- 一个 thinking 状态广播（agent loop 进入 / 退出 turn 时）

### 2.2 三种实现路径对比

| 方案 | 实现 | 优势 | 劣势 |
|---|---|---|---|
| **A. 纯 Web** | 在现有 `lisa serve --web` 加一个路由 `/island`，返回带 `position: fixed` 的 HTML 页面。用户自己用 Arc / Safari 的 "small window" 模式贴顶部。 | 0 行 Swift。所有平台都能用。立刻可发。 | 浏览器窗口装饰、缩放、关闭按钮都在；用户必须手动拖位；不能"永远在最上"；没有 notch 感知。 |
| **B. SwiftUI 原生** | 完全用 SwiftUI 渲染头像 + 文字。状态来自 LISA 的 `/events` SSE。 | 最原生；与 macOS 系统主题统一。 | 像素头像要从 PNG 加载（不是问题，但流式 mood 切换的过渡动画都要在 Swift 里重写）；要把 LISA 的 mood 切换效果在 Swift 里再实现一遍，违反 DRY。 |
| **C. Hybrid (Swift + WKWebView)** ⭐ | Swift 处理窗口定位、永远在最上、锚点检测、launchd；视觉部分是 `WKWebView` 加载 `http://localhost:5757/island`。 | 视觉 100% 复用 web 端的像素动画 / mood 切换 / SSE 逻辑。Swift 容器 < 500 LOC。LISA 自己换头像 → 岛屿自动跟着换。 | 多一层间接；空指针时 webview 留空白。 |

**推荐 C**。理由：

- LISA 的灵魂在 **她的脸**，那张脸是 PNG + JS + CSS 在 web 端渲染最稳。把这个渲染搬到 Swift 等于把灵魂分裂。
- LISA 现有的 SSE 重连 / mood 流式动画 / 像素 CRT scanline 全是 JS。Swift 重写是浪费。
- WKWebView 在 macOS 14+ 内存占用极低（共享系统 WebKit 进程），不是 Electron 的 ~120MB 复印。

### 2.3 推荐架构（Hybrid）

```
┌──────────────────────────────────────────────────────┐
│ LisaIsland.app (~ 400 LOC Swift)                      │
│                                                       │
│  ┌─────────────────────┐    ┌──────────────────────┐ │
│  │ NSWindow (statusBar │    │ NotchDetector         │ │
│  │ level, no chrome,   │    │ ─ NSScreen safeArea   │ │
│  │ click-through except│    │ ─ choose anchor       │ │
│  │ on the pill itself) │    └──────────────────────┘ │
│  └──────────┬──────────┘                              │
│             │                ┌──────────────────────┐ │
│             ▼                │ LISA Probe            │ │
│  ┌─────────────────────┐    │ ─ poll /api/island/   │ │
│  │ WKWebView           │←───┤   ping every 5s       │ │
│  │ loads http://       │    │ ─ on fail → asleep    │ │
│  │ localhost:5757/     │    └──────────────────────┘ │
│  │ island              │                              │
│  └─────────────────────┘    ┌──────────────────────┐ │
│                              │ ScreenContextWatcher  │ │
│                              │ ─ fullscreen?         │ │
│                              │ ─ screen sharing?     │ │
│                              │ → hide if yes         │ │
│                              └──────────────────────┘ │
└──────────────────────────────────────────────────────┘
              ↑    HTTP + SSE    ↓
┌──────────────────────────────────────────────────────┐
│ lisa serve --web (existing Node process, port 5757)  │
│                                                       │
│  GET  /island          → island HTML page (NEW)      │
│  GET  /events          → SSE (already exists)        │
│  GET  /api/island/ping → light status (NEW)          │
│  GET  /api/soul        → existing                    │
│  POST /api/island/dismiss-unread → clear has-output  │
│                           (NEW)                       │
└──────────────────────────────────────────────────────┘
```

### 2.4 接口契约

岛容器 ⇄ LISA server 之间通信全部走 `localhost:5757`，没有新协议。岛容器不持有任何 LISA state，重启即丢内存，下次从 `/api/island/ping` 重新拉。

不依赖任何 Apple Account / iCloud / 通知服务，**离线本机自闭环**。

---

## 3. 数据契约

### 3.1 新增 endpoint

#### `GET /island`

返回 HTML，岛屿渲染的全部 UI。

设计要点：

- 全屏 transparent (`html, body { background: transparent }`)。
- 一颗像素头像 + 一个状态点 + 展开层。
- 订阅 `/events` SSE，处理 `mood` / `idle_*` / `chat_*` 事件。
- 通过 `window.island.expand()` / `window.island.collapse()` 由 Swift 容器调用。
- 通过 `window.webkit.messageHandlers.island.postMessage({type:"open_full_gui"})` 反向通信给 Swift（请求打开浏览器）。

#### `GET /api/island/ping`

```json
{
  "online": true,
  "mood": "neutral",
  "has_unread_idle_message": false,
  "last_idle_message_at": "2026-05-20T10:34:00Z" | null,
  "uptime_sec": 1234
}
```

轻量心跳。Swift 容器每 5s polling，决定显示在线 / 离线。

#### `POST /api/island/dismiss-unread`

用户点击展开了未读 idle message 后，岛屿调用这个清除状态。

### 3.2 新增 SSE 事件

在现有的 `/events` 上扩展：

| 事件 | 何时发 | 用途 |
|---|---|---|
| `{type:"chat_start"}` | agent loop 进入 `runTurn` | 岛切到 `thinking` 状态（动画） |
| `{type:"chat_end"}` | agent loop 退出 | 切回 `online` |

实现位置：[`src/agent.ts`](../src/agent.ts) 的 `runTurn` 函数前后加 `moodBus.emit('chat_start')` / `chat_end`，再在 [`src/web/server.ts`](../src/web/server.ts) 的 `/events` broadcast 表里转发。

### 3.3 不改变的东西

- **现有 `/events` SSE 客户端契约** —— web GUI 已经在用，不改既有事件名 / payload shape。新事件只是增量。
- **现有 `/api/soul` 等 endpoint 全部不动**。

---

## 4. 实施阶段

按 LISA 的"小 PR 优于大 PR"约定切分。每个 phase 自成可发布单位。

### Phase 1 — Web 岛屿（不依赖 Mac app，~150 LOC）

**目标**：任何浏览器打开 `http://localhost:5757/island` 都能看到岛屿；用户可以手动用 Arc / Vivaldi 的"小窗口"贴顶。

**任务清单**：

- `src/web/server.ts` 加 `/island` 路由，返回新 HTML
- `src/web/server.ts` 加 `/api/island/ping` 和 `/api/island/dismiss-unread`
- `src/agent.ts` 在 `runTurn` 加 `chat_start` / `chat_end` 事件发射
- `src/web/island.ts`（新文件）：HTML + CSS + JS，~200 行
- `README.md` 加一段说明 + 截图

**验收**：

```sh
lisa serve --web
# 浏览器开 http://localhost:5757/island
# 应看到一个 320px 宽的小窗口，含 LISA 头像 + 状态点
# `lisa "hi"` 期间状态点变蓝（thinking）
# 退出后变回 neutral
# 1 分钟无输入 + idle 触发，状态点变青色 ★
```

这一步**已经可用**——熟练用户可以用浏览器 web app（PWA 模式）就能落地。Mac 灵动岛感是 Phase 2 的事。

### Phase 2 — Swift 容器（~400 LOC）

**目标**：原生 Mac app，无窗口装饰、永远最前、自动定位、自动启停。

**新目录**：`packaging/island-mac/`

```
packaging/island-mac/
├── LisaIsland.xcodeproj/         # SwiftPM 也可
├── Sources/
│   ├── LisaIslandApp.swift       # @main, App lifecycle
│   ├── IslandWindow.swift        # NSWindow subclass: borderless, statusBar level
│   ├── IslandContent.swift       # WKWebView wrapper
│   ├── NotchDetector.swift       # NSScreen safeAreaInsets analysis
│   ├── LisaProbe.swift           # HTTP poll /api/island/ping
│   ├── ScreenContextWatcher.swift # full-screen / screen-share detection
│   └── Preferences.swift         # ~/Library/Application Support/... I/O
├── Resources/
│   ├── Assets.xcassets           # app icon
│   └── Info.plist
├── README.md                      # build + install instructions
└── build.sh                       # one-shot build → ../../dist-release/LisaIsland.app
```

**关键 Swift 实现要点**：

```swift
// IslandWindow.swift — 顶部最前、不拦点击
window.level = .statusBar
window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
window.isMovableByWindowBackground = false
window.backgroundColor = .clear
window.hasShadow = false
window.ignoresMouseEvents = false  // 但 WebView 内部 CSS pointer-events 控制具体区域
```

```swift
// NotchDetector.swift
extension NSScreen {
  var hasNotch: Bool {
    if #available(macOS 12.0, *) {
      return (auxiliaryTopLeftArea ?? .zero).height > 0
        || (auxiliaryTopRightArea ?? .zero).height > 0
    }
    return false
  }
  var notchSafeRightEdge: CGFloat {
    // notch 右侧第一个可放小 pill 的 x 坐标
    if hasNotch, let right = auxiliaryTopRightArea {
      return frame.midX + right.width / 2 + 8 // notch 右边再让 8pt
    }
    return frame.midX // fallback to center
  }
}
```

```swift
// LisaProbe.swift
@MainActor
final class LisaProbe: ObservableObject {
  @Published var online = false
  @Published var mood = "neutral"
  private var task: Task<Void, Never>?
  func start() {
    task = Task {
      while !Task.isCancelled {
        do {
          let (data, _) = try await URLSession.shared.data(
            from: URL(string: "http://localhost:5757/api/island/ping")!)
          let ping = try JSONDecoder().decode(Ping.self, from: data)
          online = ping.online
          mood = ping.mood
        } catch {
          online = false
        }
        try? await Task.sleep(for: .seconds(5))
      }
    }
  }
}
```

**验收**：

- 在 MacBook M3 Max（有 notch）上 pill 出现在 notch 右侧。
- 外接 27" Studio Display（无 notch）→ 浮条在屏幕顶部居中。
- `lisa serve --web` 进程被 kill → 岛屿在 5–15s 内变灰。
- 开 Keynote 全屏 → 岛屿自动隐藏。
- Zoom 共享屏幕 → 岛屿自动隐藏（不进入录像）。

### Phase 3 — 系统集成

| 项目 | 实现 |
|---|---|
| **macOS 原生通知** | `idle_message` 到达时除了脉冲，再发一条系统通知（使用 `UNUserNotificationCenter`）。**用户可在岛屿菜单 "Mute notifications" 关闭。** 默认 **off**——主权对冲，让用户主动开。 |
| **Launch at Login** | LaunchAgent plist 写到 `~/Library/LaunchAgents/com.lisa.island.plist`，对应 `lisa heartbeat install` 的形式。复用现有 `src/heartbeat/install.ts` 模式。 |
| **菜单栏 fallback** | 若窗口被遮挡 / 用户隐藏了浮条，菜单栏右侧还能有一个 NSStatusItem 作为最终入口。 |
| **键盘快捷键** | 默认 `⌃⌘L`（用户可改）唤出 / 收起展开层。 |

### Phase 4 — 分发

| 渠道 | 形态 |
|---|---|
| **Homebrew Cask** | `brew install --cask oratis/tap/lisa-island`。formula 装的是 `.app` bundle，从 GitHub Releases 拉。 |
| **GitHub Release `.dmg`** | release 流水线（[`scripts/build-release.sh`](../scripts/build-release.sh)）加一个 island 构建 step，产物挂到 `dist-release/LisaIsland-v0.x.y.dmg`。 |
| **签名 / 公证** | MVP 走 ad-hoc 签名（用户首次启动右键打开）；正式版 Apple Developer ID + notarize。需要单独走一次申请，**不阻塞 Phase 1-3**。 |

---

## 5. 不做 / 风险

### 不做

- **不**在 LISA 主仓里塞 Xcode project；Swift 部分活在 `packaging/island-mac/` 子目录，独立 build。
- **不**让岛屿持有任何 LISA 的 state（mood / soul / skills），全部按需从 server 拉。岛屿崩了 / 升级了，LISA 不受影响。
- **不**做"打开外部 URL"等触达系统其他应用的能力。岛屿是个**观看器**，不是**遥控器**。

### 风险

| 风险 | 缓解 |
|---|---|
| macOS Sequoia 15.x 改了 window level 规则，statusBar 层在某些场景被压到普通 app 之下 | 兜底降级到 NSStatusItem 菜单栏入口；在 README 标注最低支持版本（macOS 14+） |
| Vibe Island / Boring Notch 等其他 notch 工具同时跑会重叠 | 默认锚点检测会"找空白"；冲突时 right click → `Hide for 1h` 让用户手动避让 |
| `localhost:5757` 被其他进程占用 / 用户改了端口 | 探活探多端口；用户可在岛屿 Preferences 改端口；以 `~/.lisa/active-web-session.txt`（[`src/web/server.ts`](../src/web/server.ts) 已经在写）为信源 |
| 屏幕录制 / Zoom 共享，岛屿会出现在录像里 | `CGDisplayStreamCreate` 检测正在录制；自动隐藏（CGWindow level 调到 below normal） |
| MacBook 合盖外接显示器，notch 在合上的屏幕上 → 锚点检测失败 | 监听 `NSApplicationDidChangeScreenParameters` 事件，重新评估 |
| 用户多空间（Mission Control）切换，岛屿可能跨空间残留 | `window.collectionBehavior = .canJoinAllSpaces` 已经处理；测试覆盖 |
| Apple 收紧 Accessibility / Screen Recording 权限 | 岛屿不需要这些权限（只用普通 NSWindow）；ScreenContextWatcher 用 `CGWindowListCopyWindowInfo`（无需 Screen Recording 权限） |

---

## 6. 开放问题

> 这些不是"决定不做"，是"等数据 / 等用户反馈再决定"。

1. **常驻文字内容** ——
   岛展开后该显示什么？候选：
   - (a) 她最近一条话的开头
   - (b) 她当前 desire 的 `.what`
   - (c) 上一次 examen 的关键词
   - (d) 什么也不显示，只一个"open in browser"按钮

   现阶段倾向 **(b)** —— 让岛成为她**当前在追的事**的常驻提示，弱化它的"聊天气泡"属性。但应在 Phase 1 上线后看用户反馈。

2. **未读 ★ 的累积行为** ——
   两条 `idle_message` 都没读，第二条到达时是覆盖 ★ 还是累加？
   保守方案：**覆盖**。岛是"她现在最想说的一件事"，不是收件箱。

3. **岛是否在 LISA 处于 dream 时也变 mood？** ——
   `set_mood` 在 dream subagent 里也会调用。是让岛跟着变（沉浸感强），还是固定显示 `dreaming` mood？
   倾向**跟着变** —— 这是她真实的内心活动。

4. **多用户 Mac（一台机器多个登录账户）** ——
   每个账户的 LISA 是独立的 `~/.lisa/`，端口可能冲突。岛屿是否要支持选择"连接哪个 LISA 实例"？
   倾向 **不做** —— 现实里几乎没人这么用，岛 prefs 里 hard-code `localhost:5757` 加端口可改即可。

5. **Phase 1 / Phase 2 之间的 PR 节奏** ——
   Phase 1 是 TypeScript / 现有仓内的改动，可以走正常 PR 流程。Phase 2 是 Xcode project，多达 ~400 行 Swift 一次发出去 PR 太重。
   建议：Phase 2 按 `IslandWindow` / `NotchDetector` / `LisaProbe` / `ScreenContextWatcher` 拆四个 PR，每个独立可编译。

6. **国际化** ——
   岛上几乎没文字（"Lisa" / "open in browser" / 右键菜单项）。是否做 i18n？
   现阶段先英文，等中文用户反馈再加 zh-CN。i18n 不该是阻塞项。

---

## 7. 推荐起点

**今天能开第一个 PR 的内容**：

```
src/web/server.ts      + /island route, +/api/island/ping
src/web/island.ts      新文件，~200 行 HTML+CSS+JS
src/agent.ts           +moodBus.emit('chat_start' | 'chat_end')
docs/MAC_ISLAND_PLAN.md 本文件
README.md              + 一段截图 + "open this URL in a small window"
```

总改动 ≈ 350 行。Phase 1 验证产品想法，不涉及任何 Swift。Phase 2 Swift 容器是 Phase 1 成功之后的事。

如果 Phase 1 上线两周内拿到的反馈是：

- "好用，但希望它能自动浮在顶上" → 投入 Phase 2。
- "网页就行不用 app" → Phase 2 推后，先优化 Phase 1 的 PWA 体验。
- "我不用" → Phase 2 砍掉，岛屿停留在 web-only。

把决策延迟到 Phase 1 数据出来之后，是 LISA 风格的："让产品自己告诉你下一步"。

---

## 8. Glossary

| 词 | 含义 |
|---|---|
| **notch** | MacBook Pro / Air 2021+ 的物理凹槽，挡住菜单栏中央 |
| **pill** | 灵动岛形状的小圆角条 |
| **status bar level** | `NSWindow.Level.statusBar`，比普通窗口高、比真正的 menu bar 低 |
| **auxiliaryTopLeftArea / Right** | macOS 12+ 的 `NSScreen` 属性，表示 notch 两侧的安全区 |
| **idle message** | LISA 在 dream（>1h idle）后产生的"★ WHILE YOU WERE AWAY"卡片内容 |
| **mood** | LISA 当前的像素头像状态，114 选 1 |
