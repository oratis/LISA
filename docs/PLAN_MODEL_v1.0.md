# PLAN · MODEL — 从"自带 endpoint"到真·本地部署（v1.0）

> 展开 [ROADMAP_v1.0.md §6](./ROADMAP_v1.0.md) 的 Model 支柱。基线 v0.9.1。
> 现状：20+ provider 前缀路由很干净，但本地仅"自带 endpoint"（用户自己装 Ollama 再连过去）。
> 1.0 目标：把本地模型升级为**一等部署选项**（能装/管/切/容错）+ 补本地 embedding。
> provider 抽象参考 [PROVIDERS.md](./PROVIDERS.md)。

---

## 0. 目标 / 非目标

### 目标
1. **本地模型生命周期**（M1）：`lisa model install/list/use`，封装 Ollama 等的下载 + 启动 + 健康检查。
2. **本地 embedding**（M2）：给 `memory/vector.ts` 抽象 embedding 接口，TF-IDF 保留为快路，加可选本地语义向量（与 [Sense S5](./PLAN_SENSE_v1.0.md) 共用）。
3. **provider 容错 + 自检**（M3）：fallback 链；单 key 自动选 provider；Anthropic 专属特性优雅降级。
4. **清 provider 层欠账**（M4）：abort / maxIterations / 空 content 均**已修（已核对）**；仅 OpenAI/Gemini 无 compaction 待办。

### 非目标
- 不自研推理引擎——封装 Ollama / llama.cpp / vLLM，不重造。
- 不打包模型权重进发行物（体积爆炸）；下载是按需触发，不是内置。
- 不强制本地——云 API 仍是默认，本地是平权选项。

---

## 1. 现状（file-level）

| 能力 | 现状 | 文件 |
|---|---|---|
| provider 路由 | 模型名前缀路由 + 14 家 OpenAI 兼容预设（`OPENAI_COMPAT_PRESETS`） | `src/providers/registry.ts` |
| provider 契约 | `Provider {name, runTurn(opts)}`，`ProviderRunOpts {model, systemPrompt, tools, messages, maxTokens, thinking, compaction, handlers, signal}` | `src/providers/types.ts` |
| 三 provider | Anthropic（streaming+cache+thinking）/ OpenAI（双向翻译）/ Gemini（Content 翻译） | `src/providers/{anthropic,openai,gemini}.ts` |
| 本地模型 | 仅 `LISA_BASE_URL`→OpenAI provider 指本地端口；用户自己 `ollama pull` + `serve` | `src/providers/openai.ts`、`PROVIDERS.md` |
| embedding | **无向量**——TF-IDF（fingerprint 缓存） | `src/memory/vector.ts` |
| 容错 | **无 fallback 链** | — |
| abort | **已修**：三 provider 均透传 `opts.signal`（`anthropic.ts:60`/`openai.ts:45`/`gemini.ts:79`）+ 测试 | — |

**关键缺口**：本地模型无生命周期管理；无本地语义检索；无容错；文档把"自带 endpoint"含混说成"开箱即用"。

---

## 2. 设计

### M1 · 本地模型生命周期
```ts
// src/model/local.ts  (NEW) — 封装本地后端（先 Ollama，留 backend 抽象）
interface LocalBackend {
  name: "ollama" | "lmstudio" | "llamacpp";
  install(model: string): Promise<void>;  // 封装 `ollama pull`
  ensureServing(): Promise<{ baseURL: string }>;  // 启动 + 健康检查
  listInstalled(): Promise<string[]>;
  health(): Promise<"up" | "down">;
}
```
CLI（`src/cli.ts` 加子命令）：
```
lisa model list                 # 已装 / 已配 / birth-capable 标注
lisa model install <model>      # ollama pull + 首启
lisa model use local://<model>  # 写 LISA_BASE_URL+LISA_API_KEY 到 config.env，切过去
lisa model health               # 本地 server 状态
```
- 复用现有路径：`use` 本质就是把 `LISA_BASE_URL` 指向 `http://localhost:11434/v1` + `LISA_API_KEY=ollama`（现在要用户手填，现在自动化）。
- 健康检查：session 启动前探活，本地 server down 时友好提示（而非中途崩）。
- 验收：
  - [ ] `lisa model install qwen2.5-coder` 一条命令完成下载 + 启动。
  - [ ] `lisa model use local://qwen2.5-coder` 后下次会话走本地。
  - [ ] 本地 server 未起时给清晰提示，不静默挂起。

### M2 · 本地 embedding
```ts
// src/memory/embedding.ts  (NEW) — embedding provider 抽象
interface Embedder { embed(texts: string[]): Promise<number[][]>; }
// 实现：TfIdfEmbedder(默认快路) | LocalEmbedder(ollama embedding / 本地 sentence-transformer)
```
- `memory/vector.ts` 改为接 `Embedder`：默认 TF-IDF（零依赖、快），可选语义向量（召回近义查询）。
- 与 [Sense S5](./PLAN_SENSE_v1.0.md) 的蒸馏检索共用同一索引。
- 验收：
  - [ ] 配本地 embedder 后，"network error" 能召回"connection failed"类近义条目。
  - [ ] 未配时回退 TF-IDF，行为不变（向后兼容）。

### M3 · 容错 + 自检
- **fallback 链**：`config.env` 配 `LISA_MODEL_FALLBACK=claude-...,gpt-...`；主 provider `runTurn` 报错 → 有界重试 → 降级备用。在 registry 包一层 `FallbackProvider`（实现同 `Provider` 契约，对 `runTurn` 失败透明切换）。
- **provider 自检**：只配了一个 key（如仅 `ANTHROPIC_API_KEY`）时自动选该 provider，免显式前缀/env。
- **Anthropic 专属特性优雅降级**：`ProviderRunOpts.thinking`/`compaction` 在 OpenAI/Gemini 上 no-op 而非报错；文档标注质量预期差异。
- 验收：
  - [ ] 主 provider 注入 500 → 自动切备用，会话不断。
  - [ ] 仅一个 key 时零配置直接可用。
  - [ ] `thinking:true` 发给 OpenAI 不抛错。

### M4 · provider 层欠账复核
- **abort：已修**，仅保持回归测试（三 provider passthrough 测试已在）。
- **已核对、已修**（review 旧账已不成立）：
  - maxIterations 静默截断 → **已修**：`agent.ts:403` 命中上限且仍想调用工具时把 stopReason 置为 `"max_iterations"` 并发 info 事件（另：本轮新增 `"budget_exceeded"`，见 [PLAN_REVE R2](./PLAN_REVE_v1.0.md)）。
  - 空 content 入历史 → **已修**：`agent.ts:231` 跳过空 content 的 assistant 消息，避免下轮 Anthropic 400。
- 仍存在的真欠账：
  - OpenAI/Gemini 路径无 compaction：要么实现简单截断压缩，要么文档明示仅 Anthropic 有。
- 验收：
  - [ ] 触发 maxIterations → 调用方能区分截断 vs 正常结束。
  - [ ] OpenAI 空回合后切 Anthropic 不 400。

---

## 3. 分阶段（映射里程碑）

| 阶段 | 内容 | 里程碑 | 风险 |
|---|---|---|---|
| M4 | provider 欠账复核（abort 已修） | 0.10 | 低 |
| M1 | 本地模型生命周期 | 0.11 | 中低 |
| M2 | 本地 embedding | 0.11 | 中低 |
| M3 | 容错 + 自检 | 0.11 | 中低 |

---

## 4. 测试
- 本地生命周期：mock backend → install/ensureServing/health 状态机正确；server down 路径有提示。
- embedding：TfIdf 与 Local 两实现同接口；切换不破坏检索 API；近义召回用例。
- fallback：主 provider 注入错误 → 切备用（注入测试）。
- 自检：仅一个 key 的 env → 选对 provider。
- provider 回归：abort passthrough（已有）+ 新增 maxIterations / 空 content 守卫用例。

---

## 5. 隐私 / 安全
- 本地模型 + 本地 embedding = 记忆检索与推理**可完全不离机**——这正是 Sense 敏感数据"本地优先"的底座。
- `lisa model install` 下载来自用户指定源（Ollama registry），不引入隐式远程执行；下载产物路径属用户。
- fallback 备用 provider 的 key 同样走 `config.env`（0600）。

---

## 6. 风险 / 开放问题
- **本地模型 tool-use 质量参差**：小模型 function-calling 可能不稳；`lisa model list` 标注 "birth/tool-capable"，并在 birth 时挡住能力不足的模型。
- **本地 embedding 选型**：ollama embedding vs 纯 JS 本地向量，体积/质量权衡（与 Sense 联合验证）。
- **fallback 的语义一致性**：Anthropic ↔ OpenAI 切换时 thinking/cache 行为差异，可能影响连续会话质量。

---

## 7. 与 roadmap / 论文衔接
- Model 是 0.11 主轴，紧随 Reve 硬化（0.10）。
- 对论文：本地模型 = 可复现、零边际成本的 long-horizon 实验底座；本地 embedding = 记忆检索不离机。让 ablation 能在独立研究者算力预算内反复跑（[ROADMAP §9](./ROADMAP_v1.0.md) "不要需要实验室算力的实验"）。
