# PLAN · Dispatch D4 — multi-agent monitor + advisor actions

>展开 [PLAN_DISPATCH_v1.0.md](./PLAN_DISPATCH_v1.0.md) 的 D4。基线：main（v0.9.1+，已合入四支柱首块）。
> **先核查的结论(已对当前树验证)**：D4 里"advisor 建议可点"那一半 **0.9.1 已经做了**;真正没做的是 **多 agent 前端消费**。本计划据此收窄。

---

## 0. 现状(已核查,file:line)

### ✅ 已完成(0.9.1, commit `e1fcc33`)——advisor 建议可点
- `src/advisor/types.ts:26` `SuggestedAction { label, kind: approve|cancel|open|serialize|look|dispatch, arg }`;6 个 detector(`detectors.ts`)都产出带 action 的 `Suggestion`。
- `src/web/island.ts:699–759` 渲染 advisor 卡 **真按钮**(onclick),`advisorPrefill()`(676–697)把动作 prefill 进 composer、**绝不自动执行**;✕ dismiss → `POST /api/advisor/dismiss`。
- SSE `advisor_suggestions`(`server.ts:289`)+ `GET /api/advisor/latest`;两个假告警也已修。

→ **"可点 + prefill + dismiss 学习闭环"这条 review 生死线已经合上,不用重做。**

### ❌ 仍未做——多 agent 监控前端
- 后端**已发**通用 `agent_session_update`(`server.ts:230`,覆盖所有 observer)+ 兼容用的 `claude_session_update`(232–241)。
- 但前端**只消费 claude**:`island.ts:1115` 只有 `case 'claude_session_update'`;`lisa-client.ts:428` 同样只听 claude。→ **codex/opencode/aider/git/shell 的 session 状态变化,UI 完全看不到**(尽管它们都在 hub 里、都发了事件)。
- `GET /api/agents/sessions`(`server.ts:678`)已能列全部 agent(初始加载用),但前端没用它建多-agent 列表。

### ⚠️ 可选缺口——直接动作端点
- advisor 的 `cancel`/`dispatch`/`approve` 目前都是 **prefill→用户发→Lisa 调工具**,没有 `/api/signal_agent` 之类**直接执行**端点。这是**有意的安全默认**(nothing auto-runs);是否要加"一键直接 cancel"是产品取舍,不是 bug。

---

## 1. 目标 / 非目标

**目标**:让 island(和主 chat)把**所有** agent(不只 Claude)的 session 状态显示出来 —— 兑现"看你整支 agent 舰队"。
**非目标**:不重做已完成的 advisor 可点;不默认加"自动执行"动作端点(保持 prefill 安全默认,直接端点列为可选 D4b)。

---

## 2. 设计

### D4a — 多 agent 前端消费(核心)
1. **统一消费 `agent_session_update`**:在 `island.ts` 的 SSE switch(~1063–1130)与 `lisa-client.ts`(~428)各加 `case 'agent_session_update'`。`agent_session_update` 已覆盖 claude-code,所以**以它为准**,`claude_session_update` 仅作旧客户端兼容(前端可不再依赖)。
2. **一个纯 reducer(可测)**:把"收到一条 session 更新 → 更新本地 roster"抽成纯函数,绕开前端难单测的问题:
   ```ts
   // 放进一个可被 vm/单测加载的纯模块(或 island 内联但导出给测试)
   export interface RosterEntry { agent: string; sessionId: string; project: string; state: string; lastMtime: number; }
   export function mergeAgentSession(roster: RosterEntry[], u: RosterEntry, now: number, windowMs = 30*60_000): RosterEntry[]
   //  - upsert by (agent+sessionId);按 lastMtime 排序;丢弃超出活动窗口的;去掉 done/idle 过老的
   ```
   前端只做 `roster = mergeAgentSession(roster, ev, Date.now())` + 渲染。
3. **渲染**:island 现有 Claude 监控区扩成"多 agent roster":每行 `agent 图标 + project + 状态点 + 最近活动(activity.lastTools/lastCommandName)`。agent 种类用小徽标(claude/codex/opencode/aider/git/shell)。初始加载走 `GET /api/agents/sessions`。
4. 复用现有状态点/CSS;不新增后端(后端已发齐)。

### D4b —(可选)直接动作端点
- 仅在用户明确想要"一键直接执行"时做。`POST /api/agent/signal { id, action: "cancel" }` → 复用 `signal_agent` 的 ledger-gated kill(只杀 LISA 自己派的)。
- **必须**走 0.9.1 的 web 鉴权(loopback 或 `LISA_WEB_TOKEN`),并带确认。默认仍 prefill;direct 作为 opt-in。
- approve/dispatch 的直接执行风险更高(代码执行),**不做**,保持 prefill。

---

## 3. 分阶段 + 验收

**D4a(核心)**
- [ ] island + lisa-client 各加 `agent_session_update` 消费,经 `mergeAgentSession` 维护 roster。
- [ ] island 显示非-Claude(codex/git/shell…)session 的状态 + 活动(手动起一个 git observer 会话即可见)。
- [ ] `mergeAgentSession` 纯函数有单测(upsert/排序/窗口剔除)。
- [ ] 内联 JS 仍通过现有 `vm.Script` 语法校验测试(island/lisa-html snapshot)。

**D4b(可选,需用户拍板)**
- [ ] `/api/agent/signal` 仅 loopback/token 可达;只 cancel ledger 内的 pid;有测试。
- [ ] island cancel 按钮可选"直接执行"(默认仍 prefill)。

---

## 4. 测试策略(前端难测的解法)
- **抽纯 reducer**(`mergeAgentSession`)承载所有逻辑 → 单测覆盖;前端只是"调 reducer + 写 DOM"。
- 内联 `<script>` 继续靠现有 `lisa-html`/island 的 `vm.Script` 解析测试防语法炸。
- D4b 端点:后端单测(鉴权 + 只 cancel 自己的 pid)。

## 5. 隐私 / 安全
- 多 agent roster 只显示 hub 已有的结构化 activity(无 prompt/reply/内容)——隐私层不变。
- D4b 直接端点严守 0.9.1 web 鉴权 + ledger 限制(signal_agent 既有保证)。

## 6. 风险
- 前端可测性低 → 用纯 reducer 缓解。
- roster 太吵(很多 session)→ 活动窗口 + 上限 + 折叠;沿用 island 既有的 cap。
- direct-action(D4b)是攻击面扩张 → 默认不开,prefill 优先。

## 7. 一句话
> D4 的"可点"半边 0.9.1 已合;剩下的是让前端真正消费 `agent_session_update`,把"看你所有 agent"从后端事实变成 UI 事实 —— 用一个纯 reducer 把前端逻辑做成可测的。
