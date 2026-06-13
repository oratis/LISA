# PLAN · FOUNDATIONS — 横切基础（v1.0）

> 展开 [ROADMAP_v1.0.md §7](./ROADMAP_v1.0.md) 的横切关注点为可执行计划。基线 v0.9.1。
> 这些是**四支柱共同依赖的地基**：consent 框架是 [Sense](./PLAN_SENSE_v1.0.md) 的前置，
> 安全地板是 [Dispatch](./PLAN_DISPATCH_v1.0.md) 的红线，测试欠账是所有新能力的门禁。
> **不先把地基打牢，上面四根柱子越高越危险**（[PRODUCT_REVIEW_v0.9.md](./PRODUCT_REVIEW_v0.9.md) 的核心教训）。

---

## 0. 范围

5 块横切：
1. **隐私与同意**（Sense 的头号前置）
2. **安全**（守住 v0.9.1 地板，新能力不得推回）
3. **测试**（核心循环仍裸奔 + 新能力自带测试）
4. **可观测性**（Reve/Dispatch/Sense 都要"给人看"）
5. **常驻进程 footprint / 向后兼容 / 叙事诚实**

---

## 1. 隐私与同意（master constraint）

### 1.1 统一 Consent 框架
Sense 的常驻采集让隐私从"功能"上升为"产品成立前提"。建一个**单一 consent 入口**，所有敏感信号源都从它取授权：

```ts
// src/consent/store.ts  (NEW) — 单一事实源，~/.lisa/consent.json
interface ConsentState {
  // 每类信号一个独立授权；默认全 false（presence/git 除外）
  grants: Record<string, { granted: boolean; grantedAt?: string; options?: object }>;
}
// API: isGranted(signal) / grant(signal, opts) / revokeAll()
```

原则（每条都要可测）：
- **默认全关**（新/敏感信号）；开启走**一次性 consent 卡**（说明采什么、存哪、保留多久）。
- **随时可见 + 一键全停**：island 顶栏 SENSE 指示灯 + popover 列出"现在在采什么"，一键 `revokeAll()`。
- **本地优先**：raw 截图/音频/剪贴在本地完成判定/蒸馏，命中且必要才送模型；落盘永远是结构化摘要。
- **黑名单**：app 级（密码/银行/隐私窗口）、路径级、PII 模式级（`*.env`/`*.key`/`*.pem`/邮箱/卡号）。
- **保留期**：`retentionDays` 到期清理；raw 即用即删。

### 1.2 落地与验收
- 每个 source `start()` 前查 `isGranted()`，未授权直接 no-op（绝不"先采后问"）。
- 验收：
  - [ ] 全新安装默认零敏感采集（截图/语音/剪贴/选区/shell 全关）。
  - [ ] 黑名单 app 在前台 → 对应 source 零捕获（测试）。
  - [ ] `revokeAll()` 后所有 source 立即停且 UI 反映。
  - [ ] raw 字节流绝不进结构化事件 / 不默认落盘（planted-secret 测试，每 source 一条）。

> consent 框架是 [Sense S3/S4](./PLAN_SENSE_v1.0.md)（ambient vision/voice、剪贴/选区）的**硬前置**——这些阶段不得先于本节落地。

---

## 2. 安全（守住 v0.9.1 地板）

### 2.1 已是地板（v0.9.1 已关，1.0 不得推回）
- `serve --web` 默认绑 127.0.0.1；非 loopback 需 `--host` + `LISA_WEB_TOKEN`。
- 渠道默认 remote-safe 工具集（`REMOTE_BLOCKED_TOOL_NAMES`）；`unsafeFullTools` 显式开。
- 自主循环 `autonomousSubset`（无 shell/fs-mutation/dispatch）。
- 飞书验签；soul 写锁一批。

### 2.2 1.0 新能力的红线
| 新能力 | 攻击面 | 控制 |
|---|---|---|
| Sense 常驻采集 | 隐私面（最危险） | §1 consent 框架；本地优先；黑名单；保留期 |
| Sense 新端点（若有） | LAN-RCE 回潮 | 一律 loopback/token 闸 + approval + hook（沿用 0.9.1 web 鉴权范式） |
| Dispatch 命令回路 | 本地代码执行 | 人类批准闸；远程来源默认禁；审计账本；approval relay 防伪 |
| TakoAPI consumer | 出站（二阶注入） | 网关响应当 hostile；护 `TAKO_KEY`（0600） |
| TakoAPI publisher（1.0 后） | 入站（公网可调） | DEFERRED 到 consent/安全成熟后 |

### 2.3 1.0 前要补的硬欠账
- **工具 input 无 schema 校验**（review §2 未修）：LLM 生成的 input 直进 `tool.execute()`。给关键工具（尤其 dispatch / A2A 入站 / bash）加 Zod 校验层。
- 验收：
  - [ ] 畸形 tool input 被 schema 层挡下并回友好错误，不进 execute。
  - [ ] 新端点全部走鉴权范式；红队脚本验证 LAN 不可无 token 触达带工具 agent。

---

## 3. 测试（核心循环仍裸奔）

### 3.1 现状（review 反复点名）
`agent.ts`、三 provider 翻译层、`subagent`、`approval`、`sessions`、`hooks`、`mcp` **零测试**——最该测的恰好裸奔。（外围工具/observer 测试覆盖反而好。）

### 3.2 计划
- **补核心循环欠账**：给 `agent.ts`（tool-use 循环 / tool_result 配对 / maxIterations / soul_object surface）、`approval`、`sessions` resume、`hooks`、`mcp` 加测试。
- **新能力自带测试**：Sense（每 source 隐私 + consent）、Dispatch（命令回路 + 远程安全回归 + A2A 注入）、Model（fallback + embedding + 本地生命周期状态机）、Reve（reflect 门禁 + autonomy run + soul 并发）。
- **发布门禁**：`release.yml` / `release-mac-apps.yml` 加 `npm test`；`prepublishOnly` 加 `typecheck && test`（review §6：现在红 CI 也能发版）。
- 验收：
  - [ ] 核心循环关键路径有测试（agent 循环、approval、resume）。
  - [ ] CI 红 → 发布被挡。

---

## 4. 可观测性

四支柱都需要结构化日志 + "给人看"的面板，而非只有 LLM 自己读的文本 blob：
- **Reve**：`AutonomyRun`（[PLAN_REVE R2](./PLAN_REVE_v1.0.md)）+ `lisa autonomy` 摘要。
- **Dispatch**：dispatch 账本 + DispatchEvent 流 + island 多 agent 面板。
- **Sense**：`sense/events.jsonl` + island "正在采什么"指示。
- **Soul**：`lisa soul summary`（[PLAN_REVE R3](./PLAN_REVE_v1.0.md)）。
- 统一约定：结构化 JSONL 落 `~/.lisa/<domain>/*.jsonl`，有界 + 保留期；一个 `lisa status` 汇总入口。
- 验收：
  - [ ] 每个支柱有一条 `lisa <domain>` 命令打印近期可读摘要。

---

## 5. footprint / 兼容 / 叙事诚实

### 5.1 常驻进程 footprint
- Sense 采集服务：低频轮询 + 事件驱动 + 本地处理，**实测 CPU/内存/能耗/磁盘**。截图/音频帧率是主成本旋钮——给保守默认 + 用户可调。
- 验收：
  - [ ] 空闲态（仅 presence/git/agent 观察）CPU 占用可忽略；不让风扇起飞（实测基准）。

### 5.2 向后兼容
- 现有 `~/.lisa/*`（config.env / soul / sessions / agents.json / heartbeat.json）格式不破坏；新增配置（`sense.json` / `consent.json`）独立文件，缺省即旧行为。
- Dreams→Reve 更名平滑（旧键继续读，见 [PLAN_REVE R6](./PLAN_REVE_v1.0.md)）。

### 5.3 叙事诚实（1.0 硬指标）
**叙事 = 代码**：第一个认真读代码的 contributor 每句都能对上。
- 修文档尸体（review §4.5）：LisaIsland 幽灵、三处 0.2.0 版本、LOC 数字失真一倍、completions 缺 `autostart`、CONTRIBUTING 指向不存在目录。
- 新能力的对外文案随代码同步：observer 深度、本地模型"真部署 vs 自带 endpoint"、Sense 采什么、Dispatch 能指挥到什么程度——都如实标注，不夸大。
- 验收：
  - [ ] README/PITCH/官网与当前 tree 逐项核对一致。
  - [ ] 本地模型文档区分"自带 endpoint" vs "`lisa model install` 真部署"。

---

## 6. v0.9 review 债务追踪（1.0 前复核/关闭）

> 0.9.1 已关 P0；以下 P1/P2 排期前对当前树逐条复核：

| 项 | 归属 | 状态 |
|---|---|---|
| abort signal 贯通 | [Model M4](./PLAN_MODEL_v1.0.md) | **已修**（三 provider + 测试），仅回归 |
| maxIterations 静默截断 / 空 content 守卫 | Model M4 | **已修**（agent.ts:403 / :231，已核对） |
| advisor 建议可点 + 多 agent 前端 | [Dispatch D4](./PLAN_DISPATCH_v1.0.md) | 复核（部分可能已动） |
| dispatch/github 写操作入 mutating 集 | Dispatch D4 | 复核 0.9.1 是否已修 |
| 核心循环补测试 | §3 | 待做 |
| `/chat` 并发 busy+queue + JSON.parse 容错 | §3 / web | 待做 |
| 工具 input schema 校验 | §2.3 | 待做 |
| 文档尸体 | §5.3 | 待做 |
| 发布门禁加测试 | §3 | 待做 |

---

## 7. 分阶段（映射里程碑）

| 阶段 | 内容 | 里程碑 |
|---|---|---|
| F-core | 核心循环测试 + 发布门禁 + 文档诚实 + schema 校验起步 | 0.10 |
| F-consent | 统一 consent 框架（Sense S3 前置） | 0.13 前完成 |
| F-observ | 各支柱可观测落地（随各支柱走） | 0.10–0.14 |
| F-footprint | 常驻服务实测基准 | 0.13 |

> F-core 与 Reve 硬化同期（0.10），是"先打深"的一部分；F-consent 必须早于 Sense 的 ambient 采集（0.13）。

---

## 8. 一句话
> **地基先于柱子**：consent 框架、安全地板、测试门禁、可观测——这四样不到位，Sense 的常驻采集和 Dispatch 的命令回路就不该上线。先打深，再铺宽。
