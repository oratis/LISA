# PLAN · Dispatch D2b — A2A adapter (remote agents in the hub)

> 展开 [PLAN_DISPATCH_v1.0.md](./PLAN_DISPATCH_v1.0.md) D2(b)。基线：main(v0.9.1+,D2a `takoapi` 工具已合)。
> TakoAPI 事实见 [ROADMAP_v1.0.md §4](./ROADMAP_v1.0.md):A2A(`/v1/agents/{slug}/message`、`/stream`、TaskState)+ OpenAI shim。

---

## 0. 现状
- ✅ **D2a 已合**:`src/tools/takoapi.ts` —— `discover`(GET `/api/registry`)+ `call`(POST `/v1/agents/{slug}/message`,**同步**返回回复);`LISA_BASE_URL→takoapi.com/v1` 自动用 `TAKO_KEY`。自主/远程禁用闸。
- ❌ 远程 agent **不在 hub**:本机 observer(claude/codex/.../git/shell)进 hub,远程 TakoAPI agent 不进。
- D2a 的 `call` 是**同步**的(发→等→拿回复),没有"在跑的远程任务"可观察。

---

## 1. 目标 / 非目标

**目标**:让 **LISA 实际交互过的**远程 agent 以**一等 session** 出现在 hub(与本地 agent 并列),带 A2A **TaskState**;长任务可看进度。
**关键非目标**:**绝不**把 registry 的 ~200 个 agent 全塞进 hub —— 那是 `discover` 的发现职责,不是监控职责。hub 只显示"你叫过/钉过"的远程 agent。

---

## 2. 设计

### 核心取舍:surface 谁?
hub 只收两类远程 agent,各有上限 + 活动窗口(同其它 observer):
1. **called**:LISA 经 `takoapi call` 调过的 agent(本会话/近期),带其最后 TaskState。
2. **pinned**(可选):用户在 `~/.lisa/agents.json` 显式钉的几个 slug(`{ "takoapi": { "enabled": true, "pin": ["slug-a"] } }`)。

→ 发现(200 个)永远走 `discover` 工具;监控只看交互过的。

### D2b-1 — 异步任务 + 调用账本
- A2A 真正的价值在**长任务**。给 `takoapi` 加异步路径(或新 `call` 模式):`message` 返回 A2A `Task`(有 `id` + 初始 state)而非只等同步回复;用 `/v1/agents/{slug}/stream`(SSE)或轮询 task 状态跟踪。
- 记一个**调用账本** `~/.lisa/takoapi-calls.json`(镜像 `dispatch-ledger`):`{ slug, taskId, startedAt, lastState, lastMtime }`。同步 call 也记一条(state 直接 completed)。

### D2b-2 — `takoapi` observer
- `registerIntegration("takoapi", …)`,kind `"takoapi"`,**默认关**(需 `TAKO_KEY` + opt-in)。
- `list()`:读调用账本(called + pinned),对 in-flight 的轮询/读 SSE 拿最新 TaskState,映射成 `AgentSession`(project = slug,cwd 省略,activity = 最小)。
- 复用 observer 的窗口 + 上限 + 注入式 fetch(同 takoapi 工具,便于测试)。

**A2A TaskState → AgentSessionState(纯函数,可测)**:
```
submitted | working           → working
input-required | auth-required → waiting
completed                     → done
failed | rejected             → error
canceled                      → done (reason: canceled)
unknown                       → unknown
```

### D2b-3 — 进 hub / UI
- observer 进 `registerBuiltinIntegrations` + DEFAULT config(`takoapi: { enabled: false }`)。
- UI 显示**依赖 [D4a 多 agent 前端消费](./PLAN_DISPATCH_D4_v1.0.md)** —— D4a 落地后,远程 agent 自动随 `agent_session_update` 出现在 roster(带 takoapi 徽标)。**D2b 应排在 D4a 之后**,否则后端有事件、前端看不到。

---

## 3. 分阶段 + 验收(依赖顺序)
> 前置:**D4a(多 agent 前端)**先做,否则远程 session 进了 hub 也不显示。

| 阶段 | 内容 |
|---|---|
| D2b-1 | 异步 task + `takoapi-calls` 账本(同步 call 也记) |
| D2b-2 | `takoapi` observer + TaskState 映射(纯函数)+ 注入式 fetch |
| D2b-3 | 注册 + DEFAULT(off) + 随 D4a 在 roster 显示 |

- [ ] `call` 一个远程 agent 后,它作为 session 出现在 `lisa` agent 列表 / island,带 TaskState。
- [ ] registry 的 200 个 agent **不**出现在 hub(只 called/pinned)。
- [ ] TaskState→state 映射有单测;observer 用 mock A2A 响应测(injectable fetch)。
- [ ] 远程来源(渠道)默认仍禁 takoapi(autonomous/remote-blocked 不变)。

## 4. 测试
- `taskStateToSessionState` 纯函数:全状态映射用例。
- 账本:record/list/prune(镜像 dispatch-ledger 测试)。
- observer:注入 fake fetch 返回各 TaskState → `list()` 产出正确 AgentSession;空账本→空;窗口剔除。
- A2A 响应当 hostile:注入测试(2nd-order injection)。

## 5. 隐私 / 安全
- **出站**:把远程 agent 的响应/状态当**不可信**(2nd-order prompt injection,TakoAPI 技术文档 §11 也强调);hub 只 surface **结构化**(slug、TaskState、时间),完整回复仍经 `takoapi` 工具返回(那是 LISA 自己委派的活,可读)。
- `TAKO_KEY` 走 `config.env`(0600);takoapi 仍 autonomous/remote-blocked(不变)。
- 默认关:无 `TAKO_KEY`/未 opt-in 时 observer no-op。

## 6. 风险
- **TakoAPI 网关仍在演进**(Phase 2 gateway、生产 DB 升配未完)→ observer 必须容错(A2A 断路器 / 解析失败跳过),A2A async task 端点是否稳定要先验。
- **同步 call 无可观察任务**:D2b 的真价值要 A2A async task 支持;若网关只稳定支持同步,D2b 退化为"最近调用列表"(仍有用,但弱)。
- **别破坏"不塞 200 个"的纪律**:任何"列出 registry 进 hub"的诱惑都要拒绝。
- 依赖 D4a:顺序不对就白做(后端有、前端不显)。

## 7. 一句话
> 让**你叫过的**远程 agent 进 hub(带 A2A TaskState),和本地 agent 并排 —— 发现归 `discover`、监控只看交互过的;先做 D4a 前端,再让远程 session 借同一条 `agent_session_update` 通道显示。
