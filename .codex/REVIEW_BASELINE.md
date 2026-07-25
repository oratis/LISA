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

本次审查已拆成可独立审阅、可独立回滚的草稿 PR：

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

## 当前高优先级热点

### P0

- Cloud 继承完整 CLI 工具集，存在宿主机 Shell/文件/插件/MCP 暴露风险。
- 邮箱验证链接根据请求 `Host` 与代理协议头生成，可能泄露验证 Token。
- IAP 交易去重与余额入账不是原子操作，既可能重复入账，也可能永久漏记。
- 账户、余额和部分消费上限在损坏/存储异常时存在错误初始化或 fail-open 行为。
- 反思等非聊天推理路径没有统一经过额度与计量。

### P1

- Web 长会话无上下文压缩，租户缓存无 TTL/LRU。
- 部分 Web 状态仍为进程级全局状态。
- 大量路由手工读取无上限请求体。
- Cloud sweep 缺消息水位、幂等键、分布式租约和公平游标。
- `--no-reflect`、`--compact`、`--approval` 等 CLI 语义在 Web 模式未完整生效。
- Web 服务、客户端脚本和样式文件过大，协议为手工同步。
- PR CI 未覆盖 website、macOS 与 iOS。

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
