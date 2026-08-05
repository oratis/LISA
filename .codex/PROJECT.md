# 项目定位与工作模型

## 一句话定位

LISA 是一个以本地自主权为核心、带长期人格与记忆的 AI Agent。它把对话、工具、知识库、Soul、反思、自治、外部代理编排和原生客户端组合成一个持续运行的个人智能体。

## 产品原则

从当前代码可以归纳出四条主线：

1. **Local-first**：默认数据落在用户的 Lisa Home，本地运行不依赖 LISA Cloud。
2. **Persistent self**：身份、目的、价值观、情绪、观点、欲望、关系、日志与技能会跨会话演进。
3. **Tools, not chat only**：Agent 可以读写文件、执行命令、访问网络、调用插件/MCP，并观察或调度其他编码代理。
4. **Multiple surfaces**：同一核心同时服务 CLI、Web、macOS、iOS 和 Cloud 托管场景。

这些原则之间存在天然张力：本地环境里“强能力”是优势，在多租户 Cloud 里同样的能力会成为宿主机与租户隔离风险。后续设计必须显式区分运行配置，不能只靠 UI 隐藏能力。

## 主要产品表面

| 表面 | 入口 | 作用 |
| --- | --- | --- |
| CLI / REPL | `src/cli.ts` | 组装 Provider、工具、插件、MCP、会话、反思和 Web 服务 |
| Agent 核心 | `src/agent.ts` | 流式推理、工具循环、参数校验、审批、Hook、预算和终止控制 |
| Web / Cloud | `src/web/server.ts` | Web UI、SSE、认证、账户、计费、Agent 控制和多数 HTTP API |
| Soul | `src/soul/` | 持久人格、关系、情绪、观点、欲望、日志、记忆与 Git 溯源 |
| Knowledge Base | `src/kb/` | 来源摄取、Wiki/Schema、检索、链接图和 Git 版本 |
| Autonomy | `src/heartbeat.ts`、`src/idle.ts`、`src/web/autonomy-sweep.ts` | 心跳、空闲主动行为和 Cloud 扫描反思 |
| Orchestrator | `src/orchestrator/` | 观察与管理 Claude、Codex、OpenCode、Aider、GitHub 等外部代理 |
| macOS | `packaging/mac-client/` | Swift 原生壳、后端进程控制、Web 内容和 Island |
| iOS | `packaging/ios-companion/` | SwiftUI 客户端、REST/SSE、Widget、Live Activity、认证与 IAP |
| 官网 | `website/` | Astro 双语静态网站 |

## 技术栈

- Node.js 20+、TypeScript、ESM
- 多 Provider：Anthropic、OpenAI、Google
- MCP 与插件扩展
- 手写 Node HTTP 服务与 SSE
- 本地文件、Git、可选 GCS/Firestore
- Swift / SwiftUI 原生客户端
- Astro 官网

TypeScript 开启严格模式、`noUncheckedIndexedAccess` 和 `noImplicitOverride`。核心 `src/` 约 4.8 万行，Web 层是最大模块。

## 常用验证命令

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev

cd website
npm run build

cd packaging/mac-client
swift build -c debug

cd packaging/ios-companion
./build.sh test 'platform=iOS Simulator,name=iPhone 17 Pro'
```

运行测试前先检查仓库自己的 `package.json`、脚本和平台依赖。原生构建需要 macOS/Xcode；PTY 测试在无真实 TTY 环境下可能跳过。

## 规模与热点

当前稳定化分支中有约 573 个 `src` 文件、159 个测试文件。最大的维护热点是：

- `src/web/server.ts`：约 3,832 行
- `src/web/lisa-client.ts`：约 2,798 行
- `src/web/lisa-css.ts`：约 2,144 行
- `src/web/island.ts`：约 1,479 行
- `src/cli.ts`：约 1,129 行
- `src/web/room.ts`：约 1,096 行

热点不等于必须重写；它意味着任何跨租户、安全、协议或生命周期变更，都要优先检查这些文件。
