# PLAN · Sense S2 — ambient vision + voice (consent-gated)

> 展开 [PLAN_SENSE_v1.0.md](./PLAN_SENSE_v1.0.md) S2/S3。基线：main(v0.9.1+)。
> **这是四支柱里隐私面最危险的一块。** 头号约束:**consent 框架先行、本地优先、默认全关。**
> 依赖 [PLAN_FOUNDATIONS_v1.0.md §1](./PLAN_FOUNDATIONS_v1.0.md)(统一 consent)——**S2 不得先于它落地。**

---

## 0. 现状(已知)
- ✅ 按需视觉:`src/vision/capture.ts`(`screencapture` interactive/full,热键/📷,临时文件即删)。
- ⚠️ 可选周期视觉:`src/screen_advisor/engine.ts`(默认关、≥10min、`~/.lisa/screen-advisor.json`,截图送模型问"下一步",卡片 prefill 不自动跑)。
- ⚠️ 语音:`voice/transcribe.ts`(Whisper API,**需用户给文件路径**)、`speak.ts`(say)、`dictation.ts`(润色)。
- ❌ **无 ambient 采集**(连续/低频屏幕、前台 app、录音/热听);❌ **无 consent 框架**;❌ **无本地 STT/本地判定**。

---

## 1. 目标 / 非目标

**目标**:在用户**逐项显式授权**下,把屏幕(前台 app/窗口 + 低频截图)和语音(热键/录音→转写)作为 ambient 信号纳入 Sense,**本地优先**处理,只沉淀结构化摘要。
**非目标**:不默认开;不持久化 raw 截图/音频;不在无 consent 下采任何东西;不做键盘记录/鼠标轨迹;v1 以 macOS 为先。

---

## 2. 硬前置:consent 框架(F-consent)
**必须先实现**(详见 [PLAN_FOUNDATIONS §1](./PLAN_FOUNDATIONS_v1.0.md)):
- `~/.lisa/consent.json` 单一事实源;每类信号(screen/voice/...)独立 `granted`,**默认 false**。
- 一次性 consent 卡(说明:采什么、存哪、保留多久);**随时可见 + 一键全停**(island 顶栏指示灯 + popover + `revokeAll()`)。
- 黑名单:app 级(密码/银行/隐私窗口)、路径级、PII 模式级。保留期 `retentionDays`。
- 每个 source `start()` 前查 `isGranted()`,未授权 **no-op**(绝不"先采后问")。

→ **S2 的每个 source 都建立在 consent 闸之上。没有它,S2 不上线。**

---

## 3. 设计

抽象沿用 [PLAN_SENSE §2.1](./PLAN_SENSE_v1.0.md) 的 `SenseSource`(屏幕/语音不是 agent session,用并列抽象,不塞进 observer)。

### S2-screen — ambient 屏幕
- 把 `screen_advisor` 的"周期截图"泛化为**可配 ambient 采集**:前台 app 名 + 窗口标题(便宜、低敏)+ **可选**低频截图(`everySec`,默认较大)。
- **本地优先判定**:先在本地判"是否值得上报"(前台 app 变了 / 出现 error 对话框 / 切到代码编辑器),**命中才**考虑送模型;**截图绝不持久化**(沿用 capture.ts 的 finally 删除)。
- **黑名单 app 命中 → 整帧跳过**(不截、不记)。
- consent:`screen` 默认关;开启走 consent 卡;island 实时红点"屏幕采集中"。

### S2-voice — ambient 语音
- 补**录音 + 热键(push-to-talk 默认)+ 流式转写**(现在只有"给文件路径才转")。
- 探索**本地 STT(whisper.cpp)**作离机选项(与 [Model 本地化](./PLAN_MODEL_v1.0.md) 呼应);默认仍可用云 Whisper,但本地是隐私优选。
- consent:`voice` 默认关;push-to-talk 优先于 always-on;island 红点"语音采集中"。

### 落地架构
- 接入 [PLAN_SENSE §2.2](./PLAN_SENSE_v1.0.md) 的 **SenseService 常驻循环**(与 chat 解耦),consent 闸在 source 启动处。
- 蒸馏:命中的事件经低频 distill 落 `memory`(结构化摘要,非 raw),受 [Reve 反思门禁](./PLAN_REVE_v1.0.md) 约束。
- 本地 embedding(Model M2,已合)给蒸馏检索不离机。

---

## 4. 分阶段 + 验收(严格顺序)
| 阶段 | 内容 | 前置 |
|---|---|---|
| **F-consent** | 统一 consent 框架(FOUNDATIONS §1) | —— **必须最先** |
| S2-screen | 前台 app/窗口 + 可选低频截图 + 本地判定 + 黑名单 | F-consent |
| S2-voice | 录音 + 热键 + 流式转写(+ 本地 STT 探索) | F-consent |

- [ ] **全新安装默认零敏感采集**(screen/voice 全关)。
- [ ] 黑名单 app 在前台 → 对应 source **零捕获**(测试)。
- [ ] `revokeAll()` 后所有 source 立即停 + UI 反映。
- [ ] raw 截图/音频**绝不**进结构化事件 / 不默认落盘(每 source 一条 planted-secret/隐私测试)。
- [ ] 截图即用即删;`retentionDays` 到期清事件。

## 5. 隐私 / 安全(头号)
- **同意是地基不是补丁**:逐类开关、默认全关、随时可见可停。
- **本地优先**:raw 在本地完成判定/蒸馏,命中且必要才送模型;落盘永远是结构化摘要。
- **黑名单**(密码/银行/隐私窗口)、**保留期**、**即用即删**。
- 复用 observer 既有的 planted-secret 测试范式,扩到每个新 source。
- 详见 [PLAN_FOUNDATIONS §1](./PLAN_FOUNDATIONS_v1.0.md)。

## 6. 风险
- **隐私/信任反噬**:这是对外叙事最大风险点——"它一直在看你屏幕"若无可信隐私故事会直接劝退。consent + 本地优先 + 黑名单是兑现承诺,不是文案。
- **常驻 footprint**:截图/音频帧率是主成本旋钮;保守默认 + 可调 + 实测能耗([FOUNDATIONS §5])。
- **跨平台**:系统级钩子(前台 app、录音、锁屏)macOS 先行;Linux/Windows 降级或后置。
- **本地 STT 质量**:whisper.cpp 够不够用,还是仍需云兜底——与 Model 本地化联合验证。
- **范围蔓延**:S2 是大件;F-consent 没就位前**坚决不上**(吸取 v0.9 review"先打深再铺宽"教训)。

## 7. 一句话
> 把屏幕/语音变成 Sense 的 ambient 信号 —— 但**先建 consent 框架、一切本地优先、默认全关**;这块的成败不在能不能采,而在隐私故事能不能让人信。
