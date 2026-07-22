# PLAN — 中心化账号 + Token 计费 / Centralized accounts & token billing (v1.0)

**Status: DESIGN v1.1, decisions locked（2026-07-21 评审后更新）.** 由 2026-07-13 App Store
拒审（Guideline 2.1，Submission `cb80235c-cf2f-4245-817c-ba80d9c8929d`，iPad Air 11-inch M3，
v1.0 build 1782924012）触发。本文承接 [PLAN\_CLOUD\_v1.0.md](PLAN_CLOUD_v1.0.md)（C3
multi-tenant）与 [PLAN\_IDENTITY\_v1.0.md](PLAN_IDENTITY_v1.0.md)（I2 登录 / I3 per-uid /
I4 账号生命周期），并把二者标为 "out of scope" 的 **managed tier（LISA 计费的 token）**
正式纳入范围。

**v1.1 相对 v1.0 的决策变更（评审意见）：**

1. **中心化账号升级为主流程**（所有端的默认路径）；不登录 = 高级选项（自带 API key +
   Mac 桥接），不再是并列形态。
2. 明确**多端一致性**要求：web（island UI）、官网 meetlisa.ai、Mac 客户端、iOS App
   四端体验一致，同一套账号/额度。
3. **本地 My Mac 用户也可在 Settings 登录**：登录后免配 key，LLM 流量走 LISA 推理网关，
   享受同样的每日重置额度（新增 §6.6 网关组件）。
4. 原 open questions 全部裁决（见 §9）；其中付费行为**按档位提升每日 session 限额**（§5.2）。
5. **Cloud 服务立即升配**（§6.7），Firestore 迁移从"DAU>100 再说"提前到 B2。

***

## 1. Why — 两个问题，一个答案

**问题 A（眼前）：审核员登录不了。** 审核员拿到的 "code" 实际是
`https://<cloud>/?token=<LISA_WEB_TOKEN>` 整条 URL（[deploy.sh:102](../deploy/deploy.sh)），
而 App 里没有任何"用户名/密码"式登录。调研定位到三个叠加根因：

1. **Settings 的 Cloud "Connect" 是假成功**：只解析 URL 不发网络请求
   （[SettingsView.swift:98-105](../packaging/ios-companion/Sources/SettingsView.swift)、
   [AppState.swift:157-173](../packaging/ios-companion/Sources/AppState.swift)），token 错也提示
   "Connected to LISA Cloud."，真正的 401 要到 Chat 发消息才暴露 —— 观感正是"输入 code 后无法登录"。
   （Onboarding 路径反而有 `verifyConnection` 真探测，两条路径不一致。）
2. **ASC 表单模式不匹配**：App Review 的 "Sign-in required" 字段是 username/password 两栏，
   我们的"粘贴整条 URL"模式没法规范地填进去，token 被截断/填错位置的概率很高。
3. **共享 token 链路脆弱**：`timingSafeEqualStr` 精确比对（[server.ts:162-170](../src/web/server.ts)），
   query 分支不 trim（server.ts:184-185）；失败一律裸 `401 "unauthorized"`，无法自诊断。

**问题 B（战略）：cloud 版没有商业闭环。** 现状是 BYO key + 一把共享 token 的
single-tenant demo。要让普通用户"下载即用"，必须有账号（隔离数据）和计费（覆盖推理成本）。

**一个答案：中心化账号作为主流程 + LISA 计费 token。** 所有端的默认路径都是
"注册/登录 → 免配 key 直接用"：登录后 LISA 出 key、按实际消耗计量；每 12h 窗口送约 \$5
面值的免费额度（类 Claude Code session 模型），付费按档位提升限额；用超后应用内购买
token 包（消耗型 IAP）。**不想要账号的用户保留完整逃生舱**：自带 API key + Mac
桥接（现有 pairing 流程），永不强制登录。同时它彻底解决 2.1：给 Apple 一个真正的
**demo 账号（用户名+密码，预充值、全功能）**。

## 2. Non-goals / 不变量

* **本地数据面不动摇**：无论是否登录，My Mac 模式的 soul/记忆/会话数据**永远只在
  Mac 上**（[PLAN\_IDENTITY\_v1.0.md](PLAN_IDENTITY_v1.0.md) 的命题不变：identity 与 data
  plane 解耦）。登录只增加两样东西：身份 + 托管推理（见 §6.6 的隐私边界——推理流量过网关
  但不落盘）。**自带 key 的纯本地路径永久保留**，供不接受任何云中转的用户使用。

* **不做订阅**（monthly sub）v1：只做消耗型 token 包（档位机制见 §5.2，用消耗型
  近 30 天购买额实现"类订阅"体验，规避自动续订的合规与实现成本）。

* **iOS 内不做任何非 IAP 购买**；官网 Stripe 充值仅服务桌面/web 用户且 iOS App
  内不出现其链接（美区外链见 §8 B7，非 v1）。

* **不做转售订阅额度**：token 必须来自按量计费的真 API key。relay 的 README 已明确
  replay/转售订阅 token 违反 provider ToS（[packaging/gcp-relay/README.md](../packaging/gcp-relay/README.md)）。

## 3. 现状盘点（调研结论，已核对 file:line）

**可复用的既有件：**

| 组件                            | 位置                                                                                                                                                                                                                                                                                                                                             | 状态                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Sign in with Apple 后端验证器      | [src/web/cloudAuth.ts:81-133](../src/web/cloudAuth.ts)（纯 Node crypto，JWKS/RS256/iss/aud/exp）                                                                                                                                                                                                                                                   | ✅ 已写好，`LISA_CLOUD_APPLE_SIGNIN` env 关闭中                                              |
| SIWA iOS UI + 交换逻辑            | `#if LISA_ENABLE_SIWA` gate（[SettingsView.swift:89-97](../packaging/ios-companion/Sources/SettingsView.swift)、[OnboardingFlow.swift:387-405](../packaging/ios-companion/Sources/Onboarding/OnboardingFlow.swift)）；`exchangeAppleToken` → `POST /api/auth/apple`（[LisaClient.swift:60-77](../packaging/ios-companion/Sources/LisaClient.swift)） | ✅ 已写好，编译期关闭（当年为避 5.1.1(v) 删号要求）                                                      |
| per-device token（hash 存储、可吊销） | [src/web/devices.ts:73-92](../src/web/devices.ts)                                                                                                                                                                                                                                                                                              | ✅ 可作 per-user 凭据雏形                                                                   |
| token 门禁                      | [server.ts:761-787](../src/web/server.ts)（Bearer/cookie/query 三路提取 + 常量时间比对）                                                                                                                                                                                                                                                                   | ✅ 会话机制可在其上替换                                                                         |
| 每 turn 的 token 用量             | `ProviderUsage{input,output,cacheRead,cacheWrite}`（[src/providers/types.ts:4-9](../src/providers/types.ts)），agent 循环累加（[src/agent.ts:266-269,481-485](../src/agent.ts)）                                                                                                                                                                        | ⚠️ **交互式 chat 在** **[server.ts:2284](../src/web/server.ts)** **处直接丢弃** —— 计量的接入点就在这里 |
| 用量台账样板                        | [src/autonomy/runs.ts](../src/autonomy/runs.ts)（append-only JSONL + 锁 + trim）；窗口聚合样板 [src/model/plan-usage.ts](../src/model/plan-usage.ts)（5h 滚动窗，改 12h 即用）                                                                                                                                                                                    | ✅ 直接复刻                                                                               |
| key-swap 反代样板                 | [packaging/gcp-relay/index.mjs](../packaging/gcp-relay/index.mjs)（client token 换真 key 转发，~110 行零依赖）                                                                                                                                                                                                                                            | ✅ §6.6 网关的直接前身                                                                       |
| 云端持久化                         | GCS bucket 挂 `/data`（=`LISA_HOME`），min=max=1 单写者（[deploy/deploy.sh:93-96](../deploy/deploy.sh)）                                                                                                                                                                                                                                                | ✅ C2 basic 已完成                                                                       |
| edition flag                  | [src/edition.ts](../src/edition.ts)（cloud 不信任 loopback）                                                                                                                                                                                                                                                                                        | ✅                                                                                    |

**缺口（全部绿地）：** per-uid 隔离（`LISA_HOME` 进程全局单例，[paths.ts:4](../src/paths.ts)）；
邮箱密码认证；会话签发；价格表与 \$ 计量；额度引擎；推理网关（managed inference）；
StoreKit 2 / IAP 收据验证；退款回收；应用内删号；官网账号入口。**支付/quota 相关代码全库为零**。

## 4. App Store 合规约束（硬性，决定设计边界）

| 条款                         | 要求                                                                                                 | 对设计的影响                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **3.1.1** In-App Purchase  | App 内解锁的数字内容/额度必须走 Apple IAP；**已购买的 credits 不得过期**；须提供恢复机制                                         | token 包 = 消耗型 IAP；**付费余额永不过期**（免费额度可以过期重置——过期的只能是赠送部分；档位提升是赠送权益，30 天期限合规）；credits 必须在 app 内可消耗      |
| **4.8** Login services     | 只用自建账号体系 → 不强制 SIWA；一旦加 Google 等第三方登录 → 必须同时提供 SIWA                                                | 我们本来就以 SIWA 为主 + 自建邮箱密码，天然合规；**不要加 Google 登录**（徒增义务）                                                |
| **5.1.1(v)** 账号删除          | 提供账号创建就必须提供**应用内**删除                                                                               | B1 里程碑必含 "Delete my LISA account"（连带清空 per-uid home，PLAN\_CLOUD 已有设计草案）                             |
| **2.1** Information Needed | demo 账号（用户名+密码）或 demo mode，录屏不算                                                                    | 预置 `reviewer@meetlisa.ai` + 固定密码 + 预充值余额，填入 ASC "Sign-in required"                                  |
| **隐私标签**                   | 现声明 "Data Not Collected"（[APPSTORE\_METADATA.md](../packaging/ios-companion/APPSTORE_METADATA.md)） | 加账号后必须改：收集 identifiers（email/uid）、purchase history；PrivacyInfo.xcprivacy 与 ASC 同步更新                 |
| **美区外链**（Epic 案后）          | 美区可放一个外部网页结账链接，Apple 不抽成（2025-12 九巡上诉后佣金框架仍在变）                                                     | 官网 Stripe 充值仅桌面/web 使用、iOS 不出现链接（B7）；v1 iOS 全量走 IAP                                                 |
| **Provider ToS**           | 计费必须走 metered 真 key                                                                                | 云端 provider key 由 LISA 持有（现有 registry 即可，[src/providers/registry.ts](../src/providers/registry.ts)） |

（合规调研来源见文末 References。）

## 5. 产品设计

### 5.1 主流程与逃生舱（账号是默认，不是强制）

| 路径                       | 定位            | 账号          | key/计费                            | 数据面                       |
| ------------------------ | ------------- | ----------- | --------------------------------- | ------------------------- |
| **LISA 账号 · Cloud**（主流程） | 新用户默认："下载即用"  | SIWA 或邮箱+密码 | LISA 的 key；免费窗口 + 档位 + token 包    | cloud per-uid home        |
| **LISA 账号 · My Mac**（主流程） | 已有本地用户在 Settings 登录 | 同上          | 免配 key：LLM 走 LISA 推理网关（§6.6），同一额度体系 | **数据仍全在 Mac**，仅推理流量过网关     |
| **自带 key · My Mac**（逃生舱） | 高级/隐私优先用户，永久保留 | 永不需要        | 用户自己的 key / Claude Code 订阅        | 全本地，与今天完全一致                |
| **Cloud · BYO 粘贴 token**（遗留） | reviewer/极客     | 不需要         | 粘贴 URL+token，运营者自担 key            | 保留在 flag 后面，公开文档不再提       |

所有端的 onboarding 顺序统一为：**① Sign in with Apple ② 邮箱注册/登录 ③ "高级：自带
API key / 连接我的 Mac"**。第三项永远可见（一层折叠即可），不藏死。

### 5.2 额度体系：12h session 窗口 + 付费档位（类 Claude Code）

* **窗口模型**：滚动 session 窗——某 uid 在无活跃窗口时发起首个请求，即开一个
  12h 窗口并授予对应档位面值的额度；窗口到期后清零，下次请求再开新窗。不跨窗累积
  （与 Claude Code 的 5h session 同构，参数 5h→12h）。

* **档位（决策 #4：付费按档位提升每日 session 限额）**——档位由**近 30 天累计 IAP
  购买额**决定（消耗型购买行为授予 30 天的限额提升权益；付费余额本身永不过期，两者独立）：

| 档位         | 条件（近 30 天累计购买）  | 12h 窗口面值 | 免费窗口可用模型      | 高价模型（Claude 等） |
| ---------- | --------------- | -------- | ------------- | -------------- |
| Free       | —（SIWA 账号）      | \$5      | 标准档（GLM-4.6）  | 仅付费余额          |
| Free-email | —（邮箱账号，未验证）     | \$1      | 标准档           | 仅付费余额          |
| Tier 1     | ≥ \$4.99        | \$10     | 标准档           | 仅付费余额          |
| Tier 2     | ≥ \$19.99       | \$20     | 标准档           | 仅付费余额          |

* **计量口径**：按**实际 token 消耗**扣减 —— `input × P_in + output × P_out +
  cacheWrite × P_cw + cacheRead × P_cr`，价目为**面值价**（= 供应商实价 × margin，见 §7）。

* **免费窗口只覆盖标准模型**（默认 GLM-4.6 一档）。高价模型（Claude 等）任何档位都
  仅从付费余额扣 —— 这是免费慷慨度在成本上成立的关键（见 §7 测算）。

* **扣减顺序**：先免费窗口额度，后付费余额（付费余额永不过期，合规要求）。

* **超额行为**：免费用尽且无付费余额 → 结构化 `402 quota_exhausted`（含窗口重置
  时间戳 + 当前档位）→ 客户端弹 paywall（可等重置，可购买提档）。四端文案一致。

### 5.3 购买 token（消耗型 IAP，iOS）

* 商品：3 档消耗型：`ai.meetlisa.main.credits.5`（\$4.99 → \$5 面值，激活 Tier 1）、
  `.credits.10`（\$9.99 → \$10.5 面值，+5% 赠送，Tier 1）、
  `.credits.20`（\$19.99 → \$22 面值，+10% 赠送，激活 Tier 2）。

* 余额以**面值美元（micro-USD 整数）**记账，不向用户暴露原始 token 数（模型间价差由
  价目表吸收）。购买同时刷新"近 30 天购买额"→ 档位即时生效。

* 已购余额**永不过期**、随账号跨设备/跨端漫游、支持 restore（3.1.1 全部满足）。
  档位权益 30 天滚动过期（赠送权益可过期，合规）。

* UI：Settings → Account 卡片（余额、档位、窗口进度条、历史用量）；Chat 顶部轻量额度指示。

### 5.4 审核视角（2.1 的终局解）

ASC "Sign-in required" 填 `reviewer@meetlisa.ai` + 固定密码；该账号预充值 \$20（Tier 2）、
标准模型全功能。Review Notes 同步改写（不再要求审核员粘贴 URL）。

### 5.5 多端一致性（决策 #2）

同一套账号/额度/文案，四端同表现。各端改动面：

| 端                                    | 改动                                                                                                                                             | 阶段        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| **iOS App**（packaging/ios-companion） | Onboarding 翻转为 §5.1 顺序（SIWA/邮箱在前，"高级"折叠 pairing）；Settings Account 卡片（余额/档位/删号）；StoreKit 2 paywall；额度条                                           | B1/B5     |
| **web island UI**（src/web）           | 未认证访问 cloud → 登录页（SIWA JS + 邮箱表单，同一 `/api/auth/*`）；登录后 Set-Cookie 走既有 `lisa_token` cookie 通道；Settings 加 Account 卡片 + 额度条（web 端不卖，引导 iOS 或后续官网充值） | B1/B4     |
| **Mac 客户端**（packaging/mac-client）    | Settings 加 "Sign in to LISA"（决策 #3）：登录后把 `LISA_MANAGED_SESSION` 写入 `~/.lisa/config.env`，本地后端自动走网关免 key；未登录一切如旧                                   | B6        |
| **官网 meetlisa.ai**                   | 导航加 "Sign in" 入口（跳 cloud web app）；定价/额度说明页；后续账号 dashboard + Stripe 充值（桌面/web 专用）                                                                | B1 文案；B7 充值 |
| **CLI**                              | `lisa login`（浏览器授权 + 短码回填，device-code 风格）→ 写 session 到 config.env；`lisa billing summary`                                                        | B6        |

一致性守则：额度条、402 paywall、档位名称、错误文案在四端用同一份 copy 表（放
`src/billing/strings.ts`，web/iOS/Mac 各自消费），避免四端漂移。

## 6. 架构

```
 客户端 (iOS / web island / Mac app / CLI)      lisa-cloud (Cloud Run, LISA_EDITION=cloud)
 ┌──────────────────────┐                  ┌────────────────────────────────────────┐
 │ SIWA / email+pass UI │──POST /api/auth──▶ identity: cloudAuth.ts (SIWA verify)   │
 │ Keychain/config.env  │◀──{session}──────│  + accounts.ts (email+scrypt, uid 表)  │
 │  存 session token    │                  │  → HMAC session token {uid, exp}       │
 │ Chat (SSE /chat)     │──Bearer session──▶ gate: server.ts (共享token→session)    │
 │ 额度条 / paywall     │◀─402 quota_exh.──│  homeFor(uid)=/data/users/<uid>  (C3)  │
 │                      │                  │  runAgent → usage → billing/meter.ts   │
 │ StoreKit 2 purchase  │──JWS tx──────────▶ billing/iap.ts (App Store Server API   │
 │ Transaction.finish() │◀──{balance}──────│   验签+去重) → ledger + balance        │
 └──────────────────────┘                  │  quota.ts: 12h 窗口 + 档位引擎          │
        ▲                                  │  prices.ts: 模型价目表(面值价)          │
        │ App Store Server Notifications V2 │  gateway.ts: /gw/* 推理网关 (§6.6)     │
        │ (退款回收)                        └──────────────▲─────────────────────────┘
        │                                                 │ Bearer session（免 key）
        │                                  ┌──────────────┴─────────────┐
        └──────────────────────────────────│ 本地 Mac 后端 (lisa serve)  │
                                           │ providers registry:        │
                                           │  managed 模式→网关, BYO→直连 │
                                           └────────────────────────────┘
```

### 6.1 身份与会话（改造 I2）

* **SIWA**：翻开三处既有开关即可 —— iOS `LISA_ENABLE_SIWA` 编译条件 +
  `project.yml` 加 `com.apple.developer.applesignin` entitlement（注意 Info.plist/entitlements
  的**真源是** **`project.yml`**，生成物勿改）+ 服务端 `LISA_CLOUD_APPLE_SIGNIN=1`。
  改造点：`/api/auth/apple` 现在成功后返回共享 `LISA_WEB_TOKEN`（[server.ts:752](../src/web/server.ts)）
  → 改为以 Apple `sub` 为 uid 签发 **HMAC session token**（`cloudAuth.ts:36` 注释早已把
  `sub` 预留为 "account key if/when we go multi-tenant"）。

* **邮箱+密码**（新增 `src/cloud/accounts.ts`）：scrypt 哈希；账号表 v1 落
  `/data/accounts.json`（复用 [fs-utils.ts](../src/fs-utils.ts) 原子写 + 文件锁），B2 随
  升配迁 Firestore（§6.7）。v1 不做强制邮箱验证（未验证仅 \$1 窗口，见 §5.2），发信
  基础设施（Resend/SES + `meetlisa.ai` 域名）到 B7 后拉平额度。
  存在理由：① ASC demo 账号必须是 user/pass；② 无 Apple ID 的桌面/web 用户。

* **会话**：`session = base64(uid.exp).hmac(LISA_SESSION_SECRET)`，30 天滑动续期。
  iOS 侧**零协议改动** —— session token 走既有 Bearer 通道
  （[LisaClient.swift:103-104](../packaging/ios-companion/Sources/LisaClient.swift)）、存既有
  Keychain（[TokenStore.swift](../packaging/ios-companion/Sources/TokenStore.swift)）；web 走既有
  `lisa_token` cookie 通道；Mac/CLI 存 `config.env`。门禁在
  [server.ts:761-787](../src/web/server.ts) 加一路：先试 session 验签，再退共享 token
  （`LISA_CLOUD_SHARED_TOKEN_OK=1` flag 内，默认关）。

* **删号（5.1.1(v)）**：`DELETE /api/account` → 删 `/data/users/<uid>` 整棵 + accounts 记录；
  iOS Settings 加 "Delete Account"（二次确认）。**注意**：删号不退已购 credits（IAP 由 Apple
  处理退款），删号前弹明确提示。

### 6.2 per-uid 隔离（C3/I3，全方案最大工程量）

`LISA_HOME` 从进程全局改为请求作用域：`homeFor(uid) = ${LISA_HOME}/users/<uid>`，
soul/session/memory store 全部穿 home 上下文；首次登录 lazy `birth`（entrypoint 的
one-shot birth 变 per-user）。**这是真实多用户的闸门**，方案细节沿用
[PLAN\_IDENTITY\_v1.0.md](PLAN_IDENTITY_v1.0.md) §Decision 1；Mac edition 完全不动
（保持全局单 home）。跨租户隔离必须有测试把关。

### 6.3 计量（metering）

* **接入点**：[server.ts:2284](../src/web/server.ts) 的 `runAgent` 结果处接住现在被丢弃的
  `result.inputTokens/outputTokens/cache*` → `meter.record(uid, model, usage)`。
  autonomy 后台 run（若云端开）同样接（[autonomy/runs.ts](../src/autonomy/runs.ts) 已有数据）；
  网关路径在 `gateway.ts` 流末计量（§6.6）。

* **台账**：`/data/users/<uid>/billing/usage.jsonl`（append-only，复刻 runs.jsonl 的
  锁+trim 模式）+ `balance.json`（`{paidMicroUSD, purchases30d, window:{start, spentMicroUSD}}`，
  原子写）。JSONL 是审计源，balance 是快路径缓存，可由 JSONL 重建；B2 迁 Firestore 后
  balance 用事务更新，JSONL 仍留作审计。

* **价目表**：`src/billing/prices.ts` —— per-model `{inMicroUSD, outMicroUSD, cacheW, cacheR}`
  （每 M token），**面值价 = 供应商牌价 × margin**。价目表随代码版本化，接入时从各
  provider 官方价目页生成（不要手抄进多处）。

* **预扣断路**：复用 [agent.ts:191-196](../src/agent.ts) 的 `budgetTokens` 熔断——请求前把
  "剩余额度可买到的 token 数"折算成本次 run 的预算上限，防单 turn 冲穿余额。

### 6.4 IAP（StoreKit 2 + App Store Server API）

* **不引入 RevenueCat**：单人维护、已有自建服务端、只有消耗型商品，原生方案足够且零抽成。

* 客户端：StoreKit 2 `Product.purchase()` → 拿 `Transaction` 的 **JWS representation**
  → `POST /api/billing/iap {jws}` → 服务端确认入账后再 `Transaction.finish()`。
  未 finish 的交易 StoreKit 会重投递，天然防"扣了钱没到账"。

* 服务端 `src/billing/iap.ts`：验 JWS 签名链（x5c → Apple Root CA，纯 crypto 可实现，
  与 cloudAuth.ts 验 Apple JWT 同风格）→ 校验 `bundleId==ai.meetlisa.main`、productId 白名单
  → **`transactionId`** **去重**（防重放）→ 按商品面值入账 + 刷新 `purchases30d` 档位。

* **退款回收**：注册 App Store Server Notifications V2 端点
  （`POST /api/billing/asn`，验签同上）→ `REFUND` 通知按 transactionId 反向入账（余额可为负，
  下次购买先抵扣；档位同步回收）。

* **Restore**：余额本就跟着账号走，restore 按钮只触发 `AppTransaction`/entitlement 刷新兜底。

* ASC 侧（人工）：创建 3 个消耗型商品 + 定价；签 Paid Apps 协议（银行/税务）；
  IAP 商品与 1.1 版本一并送审。

### 6.5 防滥用（免费额度是攻击面）

* 免费窗口 quota 只对**已验证身份**满额发放：SIWA 的 `sub` 天然抗女巫（Apple ID 成本高）；
  邮箱账号未验证仅 \$1（决策见 §9.1），B7 上邮箱验证后拉平。

* per-uid 并发=1（复用现有 `chatChain` 串行化，[server.ts:2377](../src/web/server.ts)；网关
  路径同样 per-uid 串行）+ per-uid RPM 上限；全局**日消耗上限 + kill switch**（env，超限
  cloud 整体降级到 402）。RPM/并发上限的标定原则：让"理论最大日燃烧"≈ 窗口面值本身，
  即榨满额度需要不间断满速请求。

* 高价模型仅付费余额；免费窗口封顶单 turn `budgetTokens`。

* 监控：`lisa` CLI 加 `billing summary`（复用 [plan-usage.ts](../src/model/plan-usage.ts)
  的聚合样板）；异常 uid（日面值 > \$10）告警到既有推送通道。

### 6.6 LISA 推理网关（决策 #3：本地 Mac 登录后免 key）

新增 `src/cloud/gateway.ts`，是 [packaging/gcp-relay](../packaging/gcp-relay/index.mjs)
key-swap 模式的 uid 化升级：

* **端点**：`/gw/anthropic/v1/messages`、`/gw/openai/v1/chat/completions`（两种上游
  协议透传；GLM 走 OpenAI 兼容面）。认证 = `Bearer <session token>`（与主门禁同一验签）。

* **行为**：验 session → 查档位/余额（quota.ts 预检，不足直接 402）→ 换上真 provider
  key 转发（流式透传 SSE）→ 流末从 usage 帧提取 token 数 → `meter.record(uid, ...)`。
  模型白名单按档位过滤（免费窗口只放行标准档模型）。

* **本地端接入**：providers registry（[src/providers/registry.ts](../src/providers/registry.ts)）
  加 **managed 模式**：`config.env` 存在 `LISA_MANAGED_SESSION` 且用户未配自有 key 时，
  `resolveProvider` 把 baseURL 指向网关、auth 用 session token；
  `hasCredentialsForModel` 在 managed 模式下返回 true（birth/run gate 直接通过）。
  Mac 客户端 Settings 登录成功即写入 `LISA_MANAGED_SESSION`；登出删除。BYO key 优先级
  高于 managed（配了自己的 key 就直连，不过网关）。

* **隐私边界（必须写进文档与官网）**：managed 模式下**推理请求内容会经过 LISA 网关**
  （TLS，转发后不落盘、不训练；台账只记 token 计数与模型名）。soul/记忆/会话数据仍
  只在 Mac。不接受此边界的用户用 BYO key 路径，功能无损。

* **402 语义贯通**：网关 402 → 本地后端把结构化错误透传给客户端 → 与 cloud 直连模式
  同一 paywall 文案（§5.5 copy 表）。

### 6.7 云端升配（决策 #5：现在就做）

* **立即（运维项，独立于代码，随 B0 执行）**：`deploy/deploy.sh` 升级 —— Cloud Run
  `lisa-cloud` 提到 **2 vCPU / 4 GiB**、`--timeout 3600`（SSE 长连余量）、并发参数按
  单实例串行模型收紧；保持 `min=max=1`（文件态单写者约束未解除前不横向扩）。
  同项目顺带核查 GCS bucket 的 lifecycle/备份。

* **B2（随 per-uid 隔离一起）**：**账号/计费态迁 Firestore**（native mode；`accounts`、
  `balances` 集合，余额用事务更新防并发双花），soul/会话文件留 GCS per-uid 子树；
  迁移后解除单实例约束（`max-instances > 1` + SSE 会话亲和），推理网关（B6）天然
  无状态可横向扩。JSONL 审计台账保留，作为 Firestore 的对账源。

## 7. Token 经济学测算

**记账单位**：micro-USD 面值。**margin 建议 1.4×**（覆盖 Apple 佣金 + 基建 + 呆账）。

| 项              | 数字（示例，接入时以官方实价为准）                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| GLM-4.6 牌价     | 约 \$0.6 / M input，\$2.2 / M output（bigmodel.cn 实价为准）                                                          |
| 面值价（×1.4）      | \$0.84 / \$3.08 per M                                                                                         |
| \$5 免费窗口 ≈     | 约 160 万 output token 或混合负载一整天重度使用 —— **实际供应商成本 ≤ \$3.6/窗**，典型用户日成本预计 \$0.1–0.5                                |
| 档位上限暴露         | Tier 2 最坏 2×\$20/天面值 ≈ \$28.6/天供应商成本 —— 由 §6.5 的 RPM/并发标定压到"不可能持续榨满"；且档位是 30 天权益，随购买停止自动回落，无永久负债              |
| 最坏情形（Free）     | 单 uid 榨满 2 窗/天 = \$7.2/天供应商成本 → 靠 per-uid 并发=1 + RPM 上限把"榨满"变得极难；再靠全局 kill switch 兜底                         |
| \$9.99 token 包 | Apple 抽成后净 \$8.49（Small Business Program 15%，年营收 < \$1M 应尽快申请）；给 \$10.5 面值 → 供应商成本 ≤ \$7.5 → 毛利约 \$1/包 + 未消耗余额浮存 |
| Claude 档（付费专属） | Sonnet 牌价 \$3/\$15 → 面值 \$4.2/\$21 per M；免费窗口不开放                                                              |

结论：**免费/档位慷慨度在"免费窗口=标准模型（GLM）+ 并发1 + RPM 标定"的前提下成立**；
若免费窗口开放 Claude 档，最坏情形会到 \$40+/天/uid，不可接受 —— 这仍是本方案唯一的
硬性产品约束。档位机制把"给更多"严格绑在"近 30 天有付费"上，giveaway 有界。

## 8. Phasing

| 阶段               | 内容                                                                                                                                                                                               | 依赖 / 需要你做的（人工）                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **B0（立即，独立于账号）** | 2.1 再提审急救：① Settings Cloud "Connect" 接真 `verifyConnection`（对齐 Onboarding，消灭假成功）；② 401 细分文案；③ query token trim；④ 核对 demo 实例存活 + ASC 里 token 无占位符/截断；⑤ Review Notes 重写（明示"无用户名密码，整条 URL 粘贴"+ 分步截图）；⑥ **云升配运维项**（§6.7：2 vCPU/4 GiB + timeout） | 无。**建议按此先回复本次拒审**，不等大方案                                           |
| **B1**           | 身份（多端）：SIWA 全链路打开（编译开关 + entitlement + env）→ session token；邮箱+密码注册/登录；应用内删号（5.1.1(v)）；隐私标签更新；**web island 登录页 + iOS onboarding 翻转为主流程；官网加 "Sign in" 入口与定价说明页**                                   | Apple portal 给 `ai.meetlisa.main` 开 Sign in with Apple capability |
| **B2**           | per-uid home（C3/I3）：`homeFor(uid)` seam + lazy per-user birth + 隔离测试；**账号/计费态迁 Firestore + 解除单实例约束**（§6.7）                                                                                       | GCP：启用 Firestore                                                  |
| **B3**           | 计量：接住 server.ts:2284 的 usage → per-uid 台账 + prices.ts + `GET /api/billing/usage` + iOS/web 额度条                                                                                                   | —                                                                 |
| **B4**           | 额度引擎：12h 窗口 + 档位表（§5.2）+ 402 paywall（四端同 copy）+ 预扣熔断                                                                                                                                             | —                                                                 |
| **B5**           | IAP：StoreKit 2 + JWS 验签入账 + ASN V2 退款回收 + restore + 档位联动；**1.1 版本与 IAP 商品一并送审**（demo 账号 `reviewer@meetlisa.ai` 预充值 Tier 2 填入 ASC）                                                                | ASC：Paid Apps 协议（银行/税务）、3 个消耗型商品、Small Business Program 申请        |
| **B6**           | **推理网关 + 本地免 key**（§6.6）：`gateway.ts` + providers registry managed 模式 + Mac 客户端 Settings 登录 + `lisa login` / `lisa billing summary`                                                               | —                                                                 |
| **B7**           | 硬化：邮箱验证 + 发信域（拉平邮箱账号额度）、防滥用调参、监控告警；官网账号 dashboard + **Stripe 充值（桌面/web 专用，iOS 内不出现）**                                                                                                            | 发信服务（Resend/SES）+ DNS；Stripe 账号                                   |

排序理由：B0 解眼前拒审（天级）；B1→B2 是所有真实用户的闸门（身份先行，隔离+升配殿后）；
B3→B4 先送后卖（免费额度先上线可单独发 1.1-beta 验证计量正确性）；B5 收钱随 1.1 送审；
B6 网关服务存量 Mac 用户（他们已有 key，紧迫度次于新用户主流程）；B7 收尾。

## 9. 决议（原 open questions，2026-07-21 裁决）

1. **免费额度给不给纯邮箱账号** → SIWA 满额 \$5；邮箱未验证 \$1；B7 邮箱验证后拉平。
2. **BYO 粘贴 token 的 cloud 路径** → 留在 flag 后，公开文档不再提。
3. **付费与限额的关系** → **付费按档位提升每日 session 限额**（§5.2 档位表；30 天
   滚动购买额定档）。
4. **余额负值（退款回收后）** → 仅冻结付费模型，标准模型免费窗照常。
5. **云端扩容时机** → **现在就升配**（B0 运维项）；Firestore 迁移提前到 B2。
6. **定价档位与赠送比例** → 按 §5.3 三档执行（上线前仅微调数值，不再改结构）。

仍开放的小问题：网关先做哪种上游协议面（建议 OpenAI 兼容面先行，覆盖 GLM 标准档）；
发信服务选型（Resend vs SES）；Tier 阈值是否随汇率/地区定价微调。

## 10. Implementation log (2026-07-22)

B0–B7 全部落地为堆叠 PR 链（base: main ← #259 ← #260 ← #261 ← #262 ← #263 ← #264 ← #265 ← #266 ← B7）：

| 里程碑 | PR | 内容摘要 |
| --- | --- | --- |
| B0 | #259 | 2.1 急救（真连接探测、结构化 401、Review Notes 重写、云升配） + 本方案入库 |
| B1 服务端 | #260 | accounts/sessions/auth 端点/应用内删号 |
| B1 客户端 | #261 | SIWA 打开、iOS 主流程翻转、web 登录页、隐私标签 |
| B2 | #262 | per-uid home 隔离（AsyncLocalStorage seam）+ lazy per-user birth |
| B3 | #263 | 价目表（面值 ×1.4）+ per-uid 用量台账 + usage API |
| B4 | #264 | 12h 窗口 + 档位 + 402 paywall + 预算熔断 + iOS 额度条 |
| B5 | #265 | StoreKit 2 消耗型 + JWS 验签 + 全局去重 + ASN 退款回收 |
| B6 | #266 | 推理网关（/gw/*）+ registry managed 模式 + lisa login/logout/billing |
| B7 | (最后一个 PR) | RPM 限流、全局日上限、kill switch、异常告警、审核账号种子（LISA_REVIEWER_SEED） |

**仍待人工（operator checklist，PR 描述内有细节）**：Apple portal 开 SIWA capability；ASC Paid Apps 协议 + 3 个消耗型商品 + ASN URL + App Privacy 更新 + demo 账号填入；Small Business Program；cloud.meetlisa.ai DNS；重跑 deploy.sh（带 LISA_CLOUD_APPLE_SIGNIN=1 + LISA_REVIEWER_SEED）。
**代码侧遗留（后续 PR）**：Firestore 迁移（解除单实例）；邮箱验证发信（Resend）+ 拉平 \$1 → \$5；Mac 菜单栏 app 的 Sign in UI（CLI 已可用）；SIWA-web（Services ID）；官网 Stripe 充值页。

## 11. References

* 内部：[PLAN\_CLOUD\_v1.0.md](PLAN_CLOUD_v1.0.md)（C2/C3、Firestore 备选、审核 demo 现状）、
  [PLAN\_IDENTITY\_v1.0.md](PLAN_IDENTITY_v1.0.md)（I1–I4）、
  [REVIEW\_IOS\_APP\_v1.0.md](REVIEW_IOS_APP_v1.0.md)、
  [RELEASE.md](../packaging/ios-companion/RELEASE.md)（现行 Review Notes 模板）、
  [REVIEW\_RESPONSE\_4.1a.md](../packaging/ios-companion/REVIEW_RESPONSE_4.1a.md)（上次 4.1(a) 拒审）、
  [WEBSITE\_OPS.md](WEBSITE_OPS.md)（官网改动入口）、
  [packaging/gcp-relay/README.md](../packaging/gcp-relay/README.md)（key-swap 反代样板）。

* App Store 合规（2026-07 调研）：
  [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)（3.1.1/4.8/5.1.1/2.1）、
  [3.1.1 拒审处理指南（BuddyBoss）](https://buddyboss.com/docs/app-store-guideline-3-1-1-business-payments-in-app-purchase/)、
  [3.1.1 credits 不得过期（PTKD）](https://ptkd.com/journal/guideline-3-1-1-in-app-purchase-digital-goods-rejection-fix)、
  [4.8 SIWA 豁免条件（Apple Forums）](https://developer.apple.com/forums/thread/707538)、
  [Sign in with Apple HIG](https://developer.apple.com/design/human-interface-guidelines/sign-in-with-apple/)、
  [美区外链裁决解读（RevenueCat）](https://www.revenuecat.com/blog/growth/apple-anti-steering-ruling-monetization-strategy)、
  [美区外链实现指南（Stora）](https://stora.sh/blog/2026-05-16-apple-app-store-external-purchase-links-implementation-guide)、
  [Stripe 与 IAP 的边界（Adapty）](https://adapty.io/blog/can-you-use-stripe-for-in-app-purchases/)。
