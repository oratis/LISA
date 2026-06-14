# PLAN · Observer Tier-2 deepening (codex / opencode / aider)

> 展开 [PLAN_SENSE_v1.0.md](./PLAN_SENSE_v1.0.md) S1a。基线：main(v0.9.1+)。
> **先核查的结论**:非-Claude observer 的 Tier-2 活动 **0.9.1 已基本铺开**(commit `db01920`);
> 本计划只补**真正缺的字段 + 活验证**,不重做。`SessionActivity` 形状见 `src/integrations/types.ts:42`。

---

## 0. 现状(已核查,逐 observer)

| 字段 | claude-code(基准) | codex | opencode | aider | 来源 |
|---|:-:|:-:|:-:|:-:|---|
| turnCount | ✅ | ✅ | ✅ | ✅ | 各自计 turn |
| lastTools | ✅ | ✅ | ✅ | ❌`[]` | aider 无工具协议(诚实空) |
| filesTouched | ✅ | ✅ | ✅ | ✅ | CC/codex 从 tool input;opencode part input;aider 从 SEARCH 块前的路径标签 |
| lastCommandName | ✅ | ✅ | ✅ | ❌ | shell argv[0] |
| lastError | ✅ | ✅ | ✅ | ✅ | 短标签 |
| **gitBranch** | ✅ | ❌ | ❌ | ❌ | CC 读 JSONL 顶层 `.gitBranch`;其余格式不带 |
| tokens | ✅ | ✅ | ✅ | ❌ | aider 不记 |
| pendingPermission | ✅(显式) | ❌ | ❌ | ❌ | 仅 CC 有显式权限记录 |

→ codex/opencode **5/8**、aider **3/8(其中 3 个是设计性留空)**。privacy:每个 observer 都有 planted-secret 测试,prompt/reply/内容不泄漏。

**关键事实**:每个 observer 都有**现成测试 fixture**(内联 JSONL / message 对象 / markdown 样本 + `writeRollout`/`msg()`/`AIDER_SAMPLE` helper)——所以**深化可用 fixture 验证,不必依赖真实 agent**。

**真正的 gap 不是字段多少,是"没对活的 agent 验证过"**(changelog 自己写了 "non-Claude depth is new and not yet battle-tested against live agents")。

---

## 1. 目标 / 非目标

**目标**:把 codex/opencode 的可得字段补齐到接近 CC;给 non-Claude observer 一次**真实 agent 活验证**,把"看你所有 agent"从"已实现但未验证"变成"已验证"。
**非目标**:不强行给 aider 造它没有的字段(lastTools 保持 `[]` 是对的);不发明 pendingPermission(codex/opencode 格式不暴露,造一个=假信号)。

---

## 2. 设计(按"可得性"排,只做真能拿到的)

### O-D1 — gitBranch for codex / opencode(可得,价值高)
codex/opencode 的 JSONL/DB 不带 branch,但 session **有 cwd**。复用刚落地的 **git observer 的 `parseGitStatus`/或一次 `git -C <cwd> rev-parse --abbrev-ref HEAD`** 派生 branch:
- 在 observer 的 activity 提取里,若有 cwd,补 `gitBranch`(带 5s 超时 + 失败留 undefined,沿用 git observer 的 execFile 范式)。
- 缓存(cwd→branch,短 TTL)避免每次 record 都 spawn git。
- 验收:fixture(cwd 指向一个临时 git repo)→ activity.gitBranch 正确;非 repo → undefined。

### O-D2 — 放宽窗口/上限(可得,小)
- codex:目前只看 JSONL 尾 64KB → 长会话欠计 tools/files。评估提到 128KB 或按记录数;权衡读成本。
- opencode:`RECENT_MSGS = 20` 上限 → 长会话欠计。提到 40 或可配。
- 验收:fixture(超长会话)→ 尾部窗口扩大后 tools/files 计数更全;读时间仍可接受。

### O-D3 — 活验证 harness(真正的 gap)
- 写一个 `scripts/verify-observers.ts`(或 `lisa agents --verify`):对每个已启用 observer,打印它当前解析出的 `SessionActivity`,让用户**对着一个真实运行的 codex/opencode/aider 会话**核对字段是否对得上其磁盘格式的真实 schema(各家 CLI 版本会漂)。
- 产出:每个 observer 一份"对 vX.Y 验证过"的记录(写进各 observer 顶部注释 / 一个 `OBSERVER_FIDELITY.md`)。
- 这是把"未 battle-tested"变"已验证"的唯一办法——fixture 测逻辑,活验证测 schema 假设。

### 不做
- **pendingPermission(codex/opencode)**:格式无显式权限门 → 不造。若某 CLI 将来加了权限记录类型,再补。
- **aider lastTools/tokens/command**:markdown 无结构化工具/token/命令 → 保持留空(造=违反隐私契约或假数据)。

---

## 3. 分阶段 + 验收
| 阶段 | 内容 | 可 fixture 测? |
|---|---|---|
| O-D1 | codex/opencode gitBranch via cwd-git(+缓存) | ✅(临时 repo fixture) |
| O-D2 | 窗口/上限放宽 | ✅(超长会话 fixture) |
| O-D3 | 活验证 harness + 记录 fidelity | ⚠️ 逻辑可测;schema 对齐需真实 agent |

- [ ] O-D1:每个 observer 的现有 `.test.ts` 加 gitBranch 用例(扩展现成 fixture)。
- [ ] O-D2:加超长-会话 fixture,断言计数更全 + 无性能回退。
- [ ] O-D3:`verify-observers` 能对真实会话打印 activity;codex/opencode/aider 各记一次"对某版本验证"。

## 4. 测试
- 全部走**现成 fixture 扩展**(audit 已确认每个 observer 都有可扩展的内联 fixture + helper)——逻辑零真实-agent 依赖。
- 每个新字段补一条 planted-secret 断言(沿用既有 privacy 测试范式),确保深化不泄漏内容。
- O-D3 的活验证是手动/半自动,产出记录而非 CI 测试。

## 5. 隐私 / 安全
- gitBranch 只是分支名(非内容)——安全。git 派生用 execFile(无 shell 注入)。
- 严守既有契约:只 tool 名 / 路径 / argv[0] / 错误类 / 计数 / branch;绝不读 prompt/reply/diff/命令参数。每个深化点配 planted-secret 测试。

## 6. 风险
- **CLI schema 漂移**:各家格式会随版本变(codex rollout、opencode DB schema)→ O-D3 活验证 + 容错解析(已有"未知 schema 跳过")是缓解。
- gitBranch 的 spawn 成本 → 缓存 + 超时。
- 价值边际:这几个字段对 advisor detector 触发有用,但收益递减;O-D3(活验证)其实是这块最该做的(让宣传"看你所有 agent"名副其实)。

## 7. 一句话
> Tier-2 字段 0.9.1 已铺开(codex/opencode 5/8、aider 3/8);剩下的是补**可得**的 gitBranch、放宽窗口,以及最重要的 **对真实 agent 活验证**——把"已实现"变成"已验证",别再给 aider 造它没有的字段。
