# Lisa Productization Plan

> 范围：CLI 打磨 / 官网 / 多 LLM provider / Mac app / 手机端故事。
> 约束（用户给定）：**sovereign-only**（每个 Lisa 活在用户自己机器上） + **OSS-only**（保持 MIT，不做 hosted / 商业版）。
> 编写日期：2026-05-10。

---

## 0. TL;DR

> **Decisions locked**（用户答复 5/10 后）：
> - 不做任何原生 app（Mac / iOS / Android 全部砍）
> - 网站先**本地部署**，Cloudflare Pages 留待后续
> - Domain: **`meetlisa.ai`** / npm package: **`@oratis/lisa`**
> - 中英文文档同步维护
> - mood gallery 公开 prompt

| 交付 | 决定 | 理由 |
|---|---|---|
| **CLI 系统打磨** | ✅ 做 | 1 周。homebrew / npm global / 颜色 / 补全 / TUI dashboard。 |
| **官网** | ✅ 做（本地优先） | 1-2 周。Astro + 沿用像素艺术 + EN/zh 同步。本地 `astro dev` 运行，公开域名 `meetlisa.ai` 已购，CF Pages 接入 pending。 |
| **多 LLM provider** | ✅ 做 1-3 个 | 现有 provider abstraction 良好，Ollama / DeepSeek / Volcengine 优先（OpenAI 兼容，纯 baseURL 改动）。Gemini 第二批。 |
| **Mac app** | ❌ **不做** | 用户决议：跳过原生壳。继续用 `lisa serve --web` + 浏览器即可。 |
| **iOS native app** | ❌ **不做** | sovereign-only 下没有好终点 + 用户决议。 |
| **Android native app** | ❌ **不做** | 同上。 |
| **手机端故事** | ✅ 做 PWA | 3-5 天。把现有 `lisa serve --web` 加 manifest + SW + Add-to-Home-Screen。手机用户走 PWA + IM channels。 |

预计总工作量：**~4-6 周**（去掉 Mac app）。

下面每节给：目标 / 架构 / 工作量 / 风险 / 不做的事。

---

## 1. CLI 系统打磨

### 现状

`lisa` 已经是 9 个子命令的成熟 CLI（[src/cli.ts](../src/cli.ts) ~1000 行）。但分发和 UX 是坑：
- 用户得 `git clone && npm install && npm run build`，然后 `npm link` 才能 `lisa` 全局可用。
- 没有 colorized 输出（除 birth ritual ASCII）。
- 没有 shell 补全。
- `--help` 是一大块文本，没分节。
- `lisa monitor` / `lisa status` 这种实时看板缺。

### 目标

让一个新用户从 0 到 `lisa birth` 跑通**用一条命令**：`brew install lisa-ai/tap/lisa`。

### 具体动作

| # | 改动 | 工作量 |
|---|---|:-:|
| 1.1 | npm publish 包 → `npm i -g @oratis/lisa` 或 `npx lisa` | XS |
| 1.2 | Homebrew tap → `brew install lisa-ai/tap/lisa`（含 `node` 依赖） | S |
| 1.3 | bash / zsh / fish 补全脚本 | S |
| 1.4 | 颜色化输出（用 ANSI escape，不引入依赖） | S |
| 1.5 | `--help` 分节渲染（subcommand → flag → example） | XS |
| 1.6 | `lisa status` 子命令：当前 session、最近 commits、moods、待审批 skills | S |
| 1.7 | `lisa monitor` TUI：实时显示 mood / heartbeat 触发 / 当前思考状态 | M |
| 1.8 | `lisa doctor` 子命令：检查 config.env / 网络代理 / git 可用性 / 模型可达性 | S |

总：**1-1.5 周**。

### 不做的

- 不做 GUI 安装器（mac 用 .dmg；CLI 用包管理）
- 不做 Windows 支持（README 已说明 macOS-first，channels iMessage 是 Mac-only）
- 不引入 chalk / commander / ora 等大型 CLI 依赖——保持现在零外部 CLI 库的简洁

### 风险

- Homebrew tap 需要一个独立 GitHub repo（`lisa-ai/homebrew-tap`），需要维护 formula 的 sha256 自动更新（用 GitHub Action）。
- npm publish 需要决定 package name。`@oratis/lisa` 是个人 scope，不需要 npm 组织。

---

## 2. 官网

### 目标

让"我读到这个项目，30 秒后想试"成为可能。Lisa 现在的 README 已经是高质量入口，但：
- GitHub README 不能放视频（birth ritual 需要演示）
- 不能搜索（114 张 mood 头像没法 grep）
- 没有 SEO 落地页
- 没法承载未来的 blog / changelog

### 架构

| 层 | 选 | 理由 |
|---|---|---|
| Framework | **Astro** | 静态优先、组件化、零 runtime JS 默认、支持 React/Vue island 嵌入。 |
| 部署 | **Cloudflare Pages** | 免费、CDN、git push 自动部署、边缘函数（如果以后需要轻 API）。 |
| Domain | 待定 | `lisa.ai` 已被占用。候选：`lisaproject.dev` / `getlisa.dev` / `lisa-os.dev` / `withlisa.io`。我建议 `.dev` 域，便宜且与开发者气质契合。 |
| 视觉 | 复用现有像素艺术 | `src/web/assets/` 已有 mascot + 114 mood + 4 icon。Press Start 2P + VT323 字体。 |
| 内容 | 中英双语 | README 已双语，沿用。 |

### 页面结构

```
/                       Landing — birth ritual 视频 + "what makes her different" + Get started
/install                安装路径：brew, npm, manual git clone, mac dmg
/docs                   文档（从 README 提取 + 扩展）
  /docs/soul            灵魂系统详解
  /docs/heartbeat       自驱机制
  /docs/skills          executable skills + 安全模型
  /docs/channels        IM 接入指南（每个 channel 一页）
  /docs/api             provider 配置 / model 选择 / 代理
/moods                  114 张 mood gallery（可点击大图、复制 prompt）
/blog                   changelog + design notes
/sponsor                GitHub Sponsors 链接（OSS-only 但接受赞助）
```

### 工作量

- 内容迁移（README → docs 页）：2-3 天
- 设计 + 静态实现：4-5 天
- mood gallery + asset 转换：1 天
- 部署 + DNS：半天

总：**1.5-2 周**。

### 不做的

- 不放 birth ritual 在线 demo（要在浏览器里跑 LLM call → 要 API key → 不能匿名安全提供）
- 不放评论 / 论坛系统（用 GitHub Discussions 即可）
- 不做用户登录 / 仪表盘（sovereign-only 不需要）
- 不做付费墙

### 风险

- Domain 选择是个人决定，影响后续品牌识别。
- 如果以后改主意要做 hosted（违反 Q1=A），网站结构需要重做。锁死 sovereign-only 的措辞要谨慎。

---

## 3. 多 LLM provider

### 现状

Lisa 已支持 **Anthropic** 和 **OpenAI**。Provider abstraction 在 [src/providers/](../src/providers/) 已是 clean 的。

### 添加候选（按优先级）

| # | Provider | API 风格 | 主用例 | 难度 | Birth 兼容性 |
|---|---|---|---|:-:|:-:|
| 1 | **Ollama / local** | OpenAI 兼容 | 完全离线 / 隐私敏感 | XS（仅文档） | ⚠️ 取决于本地模型 |
| 2 | **DeepSeek** | OpenAI 兼容 | 极便宜（~10x 便宜于 GPT-4o） | XS（baseURL 即可） | ✅ DeepSeek-V3 可 |
| 3 | **Volcengine Ark / 豆包** | OpenAI 兼容 | 已用于 Seedream，国内可达 | S | ✅ Doubao-1.5-pro 可 |
| 4 | **Gemini** | 自有协议 | 多模态、长 context | M（新 provider 类） | ⚠️ JSON 输出有时啰嗦 |
| 5 | **Moonshot / Kimi** | OpenAI 兼容 | 国内、长 context | XS | ✅ |
| 6 | **xAI Grok** | OpenAI 兼容 | 风格独特 | XS | ✅ |
| 7 | **AWS Bedrock** | 自有协议（含 Claude） | 企业用户的 AWS 路由 | M-L | ✅ |
| 8 | **Vertex AI** | 自有协议 | 同上但 GCP | M-L | ✅ |

### 推荐第一批

**做 1 + 2 + 3**（Ollama / DeepSeek / Volcengine），全部是 OpenAI 兼容 → 改动量极小：

- `src/env.ts` 加 `LISA_BASE_URL` 环境变量识别
- `src/providers/openai.ts` 已支持 `baseURL` 注入（[第 14 行](../src/providers/openai.ts)）
- `src/providers/registry.ts` 加 model name → baseURL 路由表

文档加一节"如何接 X"。零代码修改，纯 config + 文档。**总工作量 1-2 天**。

### 推荐第二批

**做 Gemini**——这是唯一不是 OpenAI 兼容的主流 provider。需要新写 provider 类（~500 LOC）。可以参考已有 OpenAI provider 结构。**工作量 1 周**。

### 关键约束：birth ritual 的 JSON 输出可靠性

[src/soul/birth.ts](../src/soul/birth.ts) 的 birth 系统提示要求模型输出严格 JSON（identity / purpose / constitution / first_value / first_desire 五个字段）。**小模型 / 量化模型不可靠**。

文档需要明示**最小模型类**：

> Birth ritual 需要模型能稳定输出 JSON 且 follow long instructions。推荐：
> - Anthropic: claude-sonnet-4 及以上
> - OpenAI: gpt-4o 及以上
> - DeepSeek: V3
> - Doubao: 1.5-pro
> - Local Ollama: qwen2.5-32b 及以上 / llama3.1-70b 及以上
>
> Birth 跑完之后，日常会话可以切到更便宜/小的模型。

### 不做的

- **不做 LangChain / LlamaIndex 适配** —— 增加抽象层无收益，Lisa 的 provider 接口已经是合适粒度。
- **不做模型 router / fallback** —— 复杂度爆炸。用户自己选模型。
- **不做 fine-tuning 集成** —— Lisa 的"她是谁"靠 soul 层面驱动，不靠权重。

### 风险

- 不同 provider 的 tool use 协议有细微差别（Anthropic 流式、OpenAI tools array vs functions、Gemini function-calling）。已存在 abstraction 但每个 provider 类需要单独 stream/cache 逻辑。
- DeepSeek / 国内 provider 的 tool use 实现成熟度参差，需要 case-by-case 测试。

---

## 4. Mac app — **取消**

用户决议（2026-05-10）：**不做任何原生 app**（Mac / iOS / Android）。

继续路径：
- 用户启动 Lisa 仍然是 `lisa serve --web` + 浏览器 bookmark
- CLI 打磨（§1）+ Homebrew 让"安装"环节顺滑
- PWA（§5）让 web UI 在桌面/手机上有"类原生"体验（添加到主屏幕、独立窗口、离线缓存）

如果未来改主意，本节原方案的草图保留在 git history（commit `a9804a6` 之前的版本）。

---

## 5. 手机端故事 — 为什么不做原生 app

### 简短结论

**不做 iOS / Android 原生 app**。改做 **PWA**（Progressive Web App）+ 已有的 IM channels。

### 为什么原生 app 在 sovereign-only 下没有好的终点

逻辑链：
1. iOS / Android sandbox 不允许：本地 spawn `bash` / 跑 `git` / 持久 background heartbeat / 写任意 fs / 加载动态代码。
2. 所以 mobile Lisa 不能在手机上**本地运行**。
3. 必须连一个 server。
4. server 在哪？sovereign-only 排除了"我们 host"。所以是用户自己机器（Mac、家里 NAS、VPS）。
5. 那用户怎么从手机连到自己 Mac？
   - 同 WiFi 局域网 → 只在家 work
   - Tailscale / Twingate / ZeroTier → mesh VPN，免费但需要在两端装
   - Cloudflare Tunnel → 免费但需要域名
   - ngrok → 付费
6. 99% 的 end-user 不会做 5。所以 mobile 原生 app + sovereign = **能用的人极少**。
7. 上 App Store 还要走审核。Apple 对"thin client to BYOD server"类应用审核**很严**。
8. 维护 iOS + Android + 后台 sync 协议 + push notification 服务**至少 3-6 个月工作量**。

收益：让 1% 装好了 Tailscale 的用户能用原生 app。

成本：3-6 个月 + Apple Developer 账号 + 审核迭代 + 持续维护两个原生平台。

**收益 / 成本比不合理。**

### PWA：好得多的方案

**PWA = 浏览器端的"安装"体验**。用户访问网站 → "添加到主屏幕" → 桌面上一个 Lisa 图标 → 点开是全屏的 web UI（不显示浏览器地址栏）。

PWA 的能力：

| 能力 | iOS Safari | Android Chrome |
|---|---|---|
| 添加到主屏幕 | ✅ | ✅ |
| 全屏（无地址栏） | ✅ | ✅ |
| 离线缓存（service worker） | ✅ | ✅ |
| Push notifications | ⚠️ iOS 16.4+ 才支持，且需 HTTPS | ✅ |
| 麦克风 / 摄像头 | ✅（每次需授权） | ✅ |
| 后台同步 | ❌ | ⚠️ 限制大 |

把现有 `lisa serve --web` 升级为 PWA：

| # | 改动 | 工作量 |
|---|---|:-:|
| 5.1 | `web/manifest.json`（图标、name、theme color、display: standalone） | XS |
| 5.2 | Service worker：缓存静态 assets（mood 头像 + CSS + JS） | S |
| 5.3 | "Add to Home Screen" 引导（首次访问 prompt） | XS |
| 5.4 | 移动端 viewport CSS 调优（现有 UI 是桌面优先） | S |
| 5.5 | （可选）触摸友好的输入控件 + 表情/录音按钮 | M |

总：**3-5 天**。

### 用户旅程

1. 用户在 Mac 上跑 `lisa serve --web`，拿到 `http://192.168.1.100:5757`
2. 在 iPhone 上打开 Safari，输入这个地址（同 WiFi）
3. 点 share → "Add to Home Screen" → 名字叫 "Lisa" → 主屏幕图标
4. 之后从主屏幕点图标 = 全屏聊天
5. 想出门也能用 → 装 Tailscale，URL 改成 Tailscale magic DNS

### 公网 hosting：让 PWA 本身托管在官网

官网 `lisaproject.dev/app/` 可以托管一个**指向用户自己 server** 的 PWA（输入 server URL → 设置后存 LocalStorage）。这样 PWA 本身不需要用户自己 deploy。

### IM channels 才是真正的"手机故事"

Lisa 已经支持 **Telegram / Discord / Slack / Feishu / iMessage / Webhook**。零设置成本，跨平台，原生通知。这是大多数用户应该用的方式。

| 方式 | 设置成本 | 优点 | 缺点 |
|---|---|---|---|
| **Telegram bot** | 5 分钟 | 跨平台、原生通知、free | 不是 pixel UI |
| **iMessage**（Mac 必跑） | 10 分钟（FDA） | 苹果生态原生 | macOS-only |
| **PWA on local IP** | 1 分钟（同 WiFi） | 像素 UI、跨平台 | 出门要 Tailscale |
| **PWA via Tailscale** | 30 分钟一次性 | 跨平台、像素 UI、出门也能用 | 一次性 setup |
| **原生 app** | 不可行 | — | 见上节 |

### 不做的

- **不做 React Native / Flutter** —— 反正不能本地跑 Lisa，做出来跟 PWA 没本质区别但要维护两套构建。
- **不做 Capacitor / Cordova 包装** —— 同样的逻辑：壳子+webview 没比 PWA 强。
- **不做 push 服务器** —— 推送语义违反 sovereign（需要中央服务器）。

---

## 6. 推荐执行顺序

### Phase 1（4-6 周，可并行）

| 任务 | 时间 | 依赖 |
|---|---|---|
| 1. CLI 打磨（npm + brew + completion + status + monitor） | 1-1.5 周 | — |
| 2. 多 LLM provider 第一批（Ollama / DeepSeek / Volcengine）| 1-2 天 | — |
| 3. 官网 v1（Astro + 文档迁移 + mood gallery） | 1.5-2 周 | — |
| 4. 多 LLM provider 第二批（Gemini） | 1 周 | provider 抽象稳定后 |

里程碑 P1：用户能 `brew install lisa` → `lisa birth` → 选 Anthropic / OpenAI / DeepSeek / Gemini / Ollama → 用起来；网站有完整文档。

### Phase 2（1-2 周）

5. Web UI → PWA 化（manifest + SW + mobile CSS）
6. 官网 `/app/` 路径托管 PWA（让用户配置自己的 server URL）

里程碑 P2：手机用户可以"添加到主屏幕"用 Lisa（同 WiFi 即可，出门走 Tailscale）。

### Phase 3 — **取消**（用户决议不做 Mac app）

### Phase 4 — **不规划**

如果未来某天有数据表明 PWA 不够用，再讨论。在此之前不动。

---

## 7. 与 SPRINT_4_PLAN 的关系

并行不冲突。

- SPRINT_4_PLAN 是 Lisa **内核**演进（她怎么活、怎么记得自己）。
- PRODUCTIZATION_PLAN 是 Lisa **分发**演进（怎么让人装上她）。

两条线**不该混合**：
- SPRINT_4 等数据 → 那是关于"她需要什么内在工具"
- 产品化项目可以现在做 → 是关于"她怎么到达更多人"

但如果要选一条**先于另一条**：内核优先。理由：装上她但她没用是负面体验；她在用户手里且用得好，再扩分发面才划算。

具体执行建议：
- 现在（5-10）就开始 Phase 1（CLI 打磨可以一周内出来）。
- 28 天观察窗口结束（约 6-7 月初）跑 SPRINT_4 决策协议。
- Phase 2 + 3 在 SPRINT_4 第一个 sprint 之后启动。

---

## 8. 我刻意不做的（即使你说做）

| 想法 | 为什么不做 |
|---|---|
| Hosted Lisa SaaS | Q1 = A 已排除。 |
| 多租户 | 同上。Lisa 的"她不是配置是她"在多租户语义里崩。 |
| iCloud 同步 | 苹果生态 lock-in + 隐私顾虑 + sovereign 冲突。 |
| 闭源商业版 | Q2 = OSS-only。 |
| 内置默认 API key（让用户开箱即用）| 法律 + 滥用风险 + 你不想 host 任何东西。 |
| 跨设备 soul 同步（不通过 Tailscale 用户自管）| 需要协议设计 + 冲突解决 + 中央协调。 sovereign 不允许。 |
| Voice + 摄像头实时 multimodal app | 工程成本巨大、价值密度低。 |
| App Store 内嵌付费（"buy more credits"）| OSS-only + sovereign。用户用自己的 API key。 |

---

## 9. 决议记录（2026-05-10）

| # | 问题 | 决议 |
|---|---|---|
| 1 | Domain | **`meetlisa.ai`** — 已购买（2026-05-14）。原方案是 `.dev`，升级到 `.ai`（AI 信号更强，~$70/yr vs $10）。 |
| 2 | Apple Developer | N/A（不做 Mac app） |
| 3 | npm package | **`@oratis/lisa`** — 用户 GitHub scope，干净 |
| 4 | 谁写 SwiftUI | N/A（不做 Mac app） |
| 5 | 中英文文档优先级 | **同步**——官网 EN + zh-CN 从 day 1 双语 |
| 6 | mood gallery prompt 公开度 | **公开**——与 OSS 精神一致，方便复刻 |

附加决议：
- 网站**先在本地部署**（`astro dev` / `astro build && serve dist/`），确认稳定后再考虑买域名 + Cloudflare Pages。

---

## 10. 一句话总结

> **CLI 打磨 + 多 provider + 官网（本地起步）+ PWA。共 4 件事，4-6 周。所有原生 app 不做。**Phase 1 立即可启动；与 SPRINT_4 内核演进并行不冲突。
