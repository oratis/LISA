# LISA 项目认知库

本目录保存供后续 Codex 会话复用的项目认知。它不是产品文档，也不替代代码和测试；当认知与实现冲突时，以当前代码、测试和部署配置为准。

## 当前基线

- 审查日期：2026-07-26
- 审查原始基线：`237f1f036969ece484a60a0f6bc73552dd211883`（v0.21.0）
- 当前发布基线：`17dbeedca01caf7fc99cb69420784387a34565b8`（v0.22.0）
- 稳定化工作：#307–#323 已按安全边界、计费、租户状态、上下文、SSRF 和
  跨端协议拆分推进；当前事实以 `main`、测试和部署配置为准
- 审查范围：Node/TypeScript 核心、Web、CLI、知识库、Soul、自治机制、编排器、Cloud 账户与计费、macOS/iOS 客户端、官网、打包与 CI

## 文件索引

- [PROJECT.md](./PROJECT.md)：项目定位、产品表面、技术栈、常用命令
- [ARCHITECTURE.md](./ARCHITECTURE.md)：系统边界、主要数据流、模块地图
- [INVARIANTS.md](./INVARIANTS.md)：修改代码时必须守住的安全、租户、计费和 Soul 不变量
- [REVIEW_BASELINE.md](./REVIEW_BASELINE.md)：本次验证结果、已知热点和下一次审查入口

整体审查与优化路线图位于：

- [../docs/PROJECT_REVIEW_AND_OPTIMIZATION_v0.21.0.md](../docs/PROJECT_REVIEW_AND_OPTIMIZATION_v0.21.0.md)

## 使用约定

1. 开始较大改动前先读取本目录。
2. 涉及 Cloud、账户、计费、工具执行或 Soul 写入时，必须同时读取 `INVARIANTS.md`。
3. 架构发生实质变化后更新这里；不要把临时实现细节写成永久事实。
4. 重要结论应附代码、测试或运行结果作为证据，并区分“当前事实”和“建议目标”。
