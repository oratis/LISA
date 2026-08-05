# 审查基线

## 2026-07-26 验证结果

基线提交：`237f1f036969ece484a60a0f6bc73552dd211883`

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 1,384 个测试；1,383 通过，1 个因无真实 PTY 跳过，0 失败 |
| `npm run build` | 通过 |
| `website/npm run build` | 通过；生成 12 个静态页面 |
| macOS `swift build -c debug` | 通过；存在 Sendable 与 WKProcessPool 弃用警告 |
| iOS Simulator 测试 | 28 通过，0 失败 |
| `npm audit --omit=dev` | 未通过；12 个生产依赖漏洞：5 high、6 moderate、1 low |

## 稳定化执行状态

本次审查已拆成可独立审阅、可独立回滚的 PR：

| 顺序 | PR | 处理范围 |
| --- | --- | --- |
| 1 | [#308](https://github.com/oratis/LISA/pull/308) | Cloud 服务端能力隔离 |
| 2 | [#309](https://github.com/oratis/LISA/pull/309) | 固定公开 Origin 与可信代理 IP |
| 3 | [#311](https://github.com/oratis/LISA/pull/311) | 账户/余额 fail-closed 与支付恢复状态机 |
| 4 | [#312](https://github.com/oratis/LISA/pull/312) | 全部缓冲式 HTTP 请求体上限 |
| 5 | [#314](https://github.com/oratis/LISA/pull/314) | Cloud 自治水位、并发防重与租约 |
| 6 | [#315](https://github.com/oratis/LISA/pull/315) | Chat/Gateway 统一推理准入与租约生命周期 |
| 7 | [#316](https://github.com/oratis/LISA/pull/316) | TenantRuntime 单飞、pin、TTL 与 LRU |

其中 #316 堆叠在 #315 上，应在 #315 合并后再合并。其余 PR 以 `main` 为基线。

第二轮继续完成了剩余高优先级边界：

| 顺序 | PR | 处理范围 |
| --- | --- | --- |
| 8 | [#317](https://github.com/oratis/LISA/pull/317) | 手动 Reflection 统一准入、租约、计量与结算 |
| 9 | [#318](https://github.com/oratis/LISA/pull/318) | Cloud 出生流程单飞计量与失败用量保留 |
| 10 | [#319](https://github.com/oratis/LISA/pull/319) | 语音时长计费、音频限制与 Dictation 推理结算 |
| 11 | [#320](https://github.com/oratis/LISA/pull/320) | 完整 Provider 输入预算与历史无损持久化 |
| 12 | [#321](https://github.com/oratis/LISA/pull/321) | Island/Advisor/活动状态按 TenantRuntime 归属 |
| 13 | [#322](https://github.com/oratis/LISA/pull/322) | DNS 全解析、IP pinning、重定向复核与响应硬上限 |
| 14 | [#323](https://github.com/oratis/LISA/pull/323) | OpenAPI v1、生成常量、DTO fixture 与 Swift 版本门 |

这些变更按 #317 → #323 的依赖顺序合并，merge commit 保留原提交祖先，避免
stacked PR 在重定 base 时重复引入差异。

## 当前高优先级热点

### 已处理的原 P0/P1

- Cloud 能力、公开 Origin/代理边界、账务一致性、HTTP body、自治水位、
  推理准入、TenantRuntime、Web context、活动状态、SSRF 与 API 契约均已进入实现。

### 后续优先级

- `--no-reflect`、`--compact`、`--approval` 等 CLI 语义在 Web 模式未完整生效。
- Web 服务、客户端脚本和样式文件仍过大，应渐进抽取路由域和客户端模块。
- PR CI 未覆盖 website、macOS 与 iOS。
- 计费审计与余额结算仍需 durable outbox/reconciliation，覆盖“Provider 已收费但
  余额提交失败”以及进程崩溃窗口。
- 生产依赖仍有 Google GenAI/MCP/Hono 链的 moderate 漏洞，不能用破坏性强制
  降级替代有计划的依赖升级。

详细证据、取舍和路线图见：

- [../docs/PROJECT_REVIEW_AND_OPTIMIZATION_v0.21.0.md](../docs/PROJECT_REVIEW_AND_OPTIMIZATION_v0.21.0.md)

## 下一次审查入口

优先检查以下位置：

- `src/cli.ts`：能力组合根
- `src/agent.ts`：统一 Agent 循环
- `src/web/server.ts`：Cloud/Web 安全与租户边界
- `src/web/accounts.ts`：账户存储错误语义
- `src/billing/iap.ts`：支付幂等与原子性
- `src/billing/quota.ts`、`src/billing/limits.ts`：余额与上限
- `src/web/autonomy-sweep.ts`：反思扫描与租约
- `src/tools/bash.ts`、`read.ts`、`write.ts`、`web_fetch.ts`：高权限工具与 SSRF
