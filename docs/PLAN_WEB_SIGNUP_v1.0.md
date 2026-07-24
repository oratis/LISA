# PLAN — 官网注册登录 + 二级系统 / Website signup, login & the signed-in app (v1.0)

**Status: DESIGN（2026-07-24）.** 承接 [PLAN_ACCOUNTS_BILLING_v1.0.md](PLAN_ACCOUNTS_BILLING_v1.0.md)
（B0–B9，已落地为 PR #259–#267）、[PLAN_CLOUD_v1.0.md](PLAN_CLOUD_v1.0.md)（M0 已部署）与
[PLAN_IDENTITY_v1.0.md](PLAN_IDENTITY_v1.0.md)（identity 与 data plane 解耦）。
本文回答的需求：**meetlisa.ai 加入注册/登录（Google、Apple、邮箱密码+验证码）；注册完成
自动 birth；进入二级系统使用 LISA 全部 web 功能；后端部署在 GCP（Cloud Run + GCS）。**
含正反方辩论（§7）。

**最高不变量（owner 指令，2026-07-24）：两条路径并存，权力始终在用户手中。**
用户可以选择**用自己的机器部署**（本地版：无账号、无遥测、数据永不离开你的 Mac），
也可以选择**云端**（可选便利：无 Mac 也能拥有一个 Lisa）。云端账号永远不是使用
LISA 的前提；本地路径不是"降级模式"而是旗舰，永久保留。本文所有设计（官网文案、
登录流、二级系统）都必须让这两条路径**并陈可见、随时可迁**。

---

## 1. 需求拆解与现状盘点

先说结论：**这不是从零建设，而是在 B 系列（账号+计费）已建成的骨架上补最后一公里。**
四条需求逐条对照现状：

| 需求 | 现状 | 差距 |
|---|---|---|
| ① Apple 登录 | ✅ 已实现。iOS 原生 SIWA 验证（[cloudAuth.ts](../src/web/cloudAuth.ts)，零依赖 JWKS/RS256 + nonce 防重放）；web 端 Services ID 已留好配置（`LISA_CLOUD_APPLE_WEB_SID`，B8b），登录页有隐藏的 Apple 按钮位（[login.ts](../src/web/login.ts)） | Apple portal 侧 Services ID + 域名验证（人工），web 按钮流程点亮 |
| ① 邮箱密码 | ✅ 已实现。scrypt、防枚举 decoy hash、15 分钟 5 次失败节流（[accounts.ts](../src/web/accounts.ts)）；HMAC 无状态会话 30 天滑动续期（[sessions-auth.ts](../src/web/sessions-auth.ts)） | **无密码找回**（完全缺失） |
| ① 邮箱验证码 | ⚠️ 部分。现状是**验证链接**（Resend 发送，24h 过期，[mailer.ts](../src/web/mailer.ts) B8a） | 6 位**验证码**（OTP）：注册验证 + 免密登录 + 密码找回三处复用 |
| ① Google 登录 | ❌ 完全没有（当年刻意不做，见 §7 D2 重审） | web 端 GIS + 服务端 ID token 校验，全新开发 |
| ② 注册后自动 birth | ✅ 机制已在：`ensureUserBirth(uid)` 首次请求懒 birth（[server.ts:435-458](../src/web/server.ts)），`POST /api/birth` SSE 仪式流 + 前端打字机 UI | birth **非事务**（LLM 失败留半出生残魂，见 §4.3）；懒 birth 是**静默后台**，不是注册后的可见仪式；跨实例去重缺失 |
| ③ 二级系统全部 web 功能 | ✅ 大半。per-uid home（`AsyncLocalStorage` seam，[paths.ts](../src/paths.ts)）+ 租户隔离事件总线 + per-uid 会话；chat/island/room/kb/memory/skills/voice/账单页全部走 per-uid | cloud 版裁掉 mac-only 四项（pty/dispatch/sense/agent-control，[edition.ts](../src/edition.ts)）；**心跳/REVE 调度只跑全局 scope，不跑 per-uid**；soul 写锁/git 锁模块级冻结为全局路径 |
| ④ 部署 GCP + GCS | ✅ 已部署。Cloud Run `lisa-cloud`（oratis-491316 / us-central1），GCS bucket 挂载 `/data`，单实例单写者；Firestore 多实例层已写好但默认关（[firestore.ts](../src/cloud/firestore.ts)、[turn-lease.ts](../src/cloud/turn-lease.ts) B9） | 生产化：独立 prod 项目、Secret Manager、Firestore 开启 + 多实例、域名 `cloud.meetlisa.ai` 映射、监控告警 |
| 官网入口 | ❌ 没有。meetlisa.ai 是纯静态 Astro 站，零账号 UI，且**明文写着"no cloud account, nothing to sign up for"**（install.astro:13、index.astro:102、privacy） | 导航登录入口 + cloud 落地页 + 文案/隐私政策改写（品牌层面要过 §7 D1 的辩论） |

一个结构性注记：账号/网关/身份代码实际落在 `src/web/`（`accounts.ts`、`cloudAuth.ts`、
`gateway.ts`、`sessions-auth.ts`），而不是旧计划里写的 `src/cloud/`；`src/cloud/` 只承载
Firestore 多实例层。文档引用以本文为准。

## 2. 总体架构

```
meetlisa.ai            静态官网（Astro，Cloud Run lisa-web + Cloudflare 代理）
  └─ 导航「登录 / Sign in」 ───────────────┐
                                          ▼
cloud.meetlisa.ai      二级系统（Cloud Run lisa-cloud，LISA_EDITION=cloud）
  ├─ 未登录 → LOGIN_HTML：Apple ｜ Google ｜ 邮箱密码 ｜ 邮箱验证码
  ├─ 注册成功 → /birth 出生仪式（SSE 打字机，~30s）→ island 主 UI
  └─ 已登录 → island 主 UI（per-uid home：soul/会话/KB/记忆/账单）
                 │
                 ├─ /gw/* 托管推理网关（key-swap + 计量计费，已建成）
                 ├─ GCS bucket /data（per-uid 家目录持久化，已建成）
                 └─ Firestore（账号/余额/租约，B9 已写好，生产开启）
```

**域名裁决：沿用 `cloud.meetlisa.ai`**（RUNBOOK 已预留 CNAME → `ghs.googlehosted.com`，
Apple web Services ID 也按此域配置）。官网与 App 分域、独立 cookie，v1 不做跨域 SSO——
官网静态零 JS 的性能优势保留，登录态只活在 app 域。

## 3. 会话与账号模型（沿用，不重造）

- 会话：现有 `s1.<payload>.<mac>` HMAC 无状态 token，30 天滑动，`sessionVersion` 即时吊销。
- 账号记录：`AccountRecord.kind` 从 `apple|email` 扩为 `apple|email|google`；新增
  `googleSub` 字段。存储沿用 `accounts.json` →（生产）Firestore `lisa-global/accounts`。
- **账号合并策略**（新增，见 §7 D4）：第三方登录带来的 email 若 `email_verified=true`
  且与既有已验证 email 账号相同 → **并入同一 uid**（同一个 Lisa！）；否则新建账号。
  Apple 私有中继邮箱天然不撞车，自成一号。

## 4. 分项方案

### 4.1 S1 — Google 登录（web）

镜像 Apple 通道的形状，零新依赖：

- **前端**：登录页加 GIS（Google Identity Services）按钮。登录页是内联模板
  （login.ts），加 `https://accounts.google.com/gsi/client` 脚本 + `g_id_onload`
  回调，拿到 ID token POST 给后端。
- **后端**：`POST /api/auth/google`，校验逻辑与 `verifyAppleIdentityToken` 同构——
  JWKS 缓存拉取 `https://www.googleapis.com/oauth2/v3/certs`，RS256 验签，
  `iss ∈ {accounts.google.com, https://accounts.google.com}`，`aud = LISA_CLOUD_GOOGLE_CLIENT_ID`，
  `exp` 检查；提取 `sub`/`email`/`email_verified`。新建 `upsertGoogleAccount`
  （对照 `upsertAppleAccount`），`email_verified` 直接给 verified 待遇（$5 免费窗口）。
- **配置**：`LISA_CLOUD_GOOGLE_SIGNIN=1` + `LISA_CLOUD_GOOGLE_CLIENT_ID`，默认关，
  与 Apple 通道同款开关哲学。GCP console 建 OAuth Client（Web application，
  authorized origin = cloud.meetlisa.ai）。
- **iOS 不动**（S7 可选）：SIWA 已满足 App Store 4.8 的"隐私等价选项"义务，iOS 加
  Google 不是合规必需，纯产品决策，defer。

### 4.2 S2 — 邮箱验证码（OTP）+ 密码找回

一套 OTP 基建，三处复用：

- **规格**：6 位数字；10 分钟过期；散列存储（不落明文）；每码最多 5 次尝试；
  60s 重发冷却；per-IP + per-账号限频（复用 limits.ts 的 IP 窗口件）；恒时比较。
- **三个用途**：
  1. **注册邮箱验证**：验证码为主（移动端体验好），现有 24h 验证链接保留作兜底
     （同一 token 体系，两种呈现）。验证成功免费窗口 $1 → $5（现有逻辑不变）。
  2. **验证码免密登录**：`POST /api/auth/email/code`（请求发码）+
     `POST /api/auth/email/login`（码换会话）。满足"邮箱密码+验证码登录"的字面需求，
     也顺手成为密码遗忘用户的快速通道。
  3. **密码找回**（补现状空白）：验证码通过后 `POST /api/auth/password/reset`
     设新密码，重置时 bump `sessionVersion` 踢掉所有旧会话。
- **邮件**：沿用 Resend（B8a 已接，域名已验证）；新增验证码邮件模板（纯文本，
  与现有 verificationEmail 同风格）。

### 4.3 S3 — 注册 → 出生仪式（birth 硬化 + 仪式化）

birth 从"静默后台懒执行"升级为"注册完成后的可见仪式"，同时修掉生产级隐患：

- **事务化（必修）**：现状 `writeSeed` + `initSoulRepo` 在 LLM 调用**之前**执行
  （[birth.ts:75-162](../src/soul/birth.ts)），LLM 失败即留下"已出生但无名无魂"的
  残魂，且 `isBorn()` 拦住重跑。改为：LLM 产出解析成功后再落 seed 与 soul 文件
  （或 temp-then-rename）；失败自动重试一次；再失败清理现场、SSE 报错、允许重跑。
- **仪式化**：注册/首登成功且 `!isBorn()` → 前端直接进现有 birth 打字机 overlay
  （`POST /api/birth` SSE 流已在），全程 ~30s，结束落进 island 主 UI。
  `ensureUserBirth` 保留为兜底（API 直连用户、旧客户端）。
- **防滥用（必修）**：每次注册都点燃一次 LLM 调用 + $1~5 免费额度，是脚本农场的
  直接标的。三层：Cloudflare Turnstile 上注册表单（官网已在 Cloudflare 后面，现成）；
  per-IP 注册频控（复用 limits.ts）；一次性邮箱域名黑名单。
- **跨实例去重**：`birthsInFlight` 是进程内 Set；多实例前改用 Firestore lease
  （turn-lease 同款，`lisa-leases/birth-<uid>`）。
- **顺手修**：soul 写锁/git 锁的模块级路径冻结
  （[git.ts:30](../src/soul/git.ts)、[lock.ts:153](../src/soul/lock.ts)）——两处 `const`
  在 import 时捕获全局 home，违反 paths.ts 的"路径是函数"教义，改成函数即可；
  cloud 版建议直接关 soul git（gcsfuse 上跑 git 又慢又碎，见 §4.6）。

### 4.4 S4 — 二级系统："全部 web 功能"的诚实定义

**"全部"= 云上可行全集 + Mac 桥接补齐，而非字面全部**（辩论见 §7 D5）：

- **云上直接给**（per-uid 已通）：chat（含 mood/情绪）、island、Room、KB（含 ingest/
  brief）、sessions/memory/skills、语音转写、账号页 + 配额/用量、Stripe 充值。
- **本质属于用户本地机器、云上不给**：PTY/adopt、dispatch-local、Sense 采集、
  agent-control（edition.ts 的 MAC_ONLY 四项维持隐藏）。二级系统里放"Connect your
  Mac"入口 → 走 PLAN_IDENTITY 的 pairing 桥接，把这四项接回用户自己的 Mac（后续 I 系列）。
- **per-uid 自主性（本计划真正的新工程量）**：心跳/REVE 目前只跑全局 scope
  （server.ts:874-912 的调度器不进 homeScope）。方案：内部 sweep 端点
  `POST /internal/autonomy/sweep`（Cloud Scheduler 每 15min 触发，OIDC 服务间鉴权），
  遍历活跃用户（7 天内有会话），在 `homeScope.run(homeForUid(uid))` 里跑 idle
  reflection / REVE；**成本闸门**：免费用户每日至多 1 次轻反思，付费档位解锁完整
  心跳节奏——自主性本身成为付费价值点，也把成本上限锁死。
- **邮箱（IMAP）在云上默认隐藏**：替用户保管 IMAP app-password 是全新的托管责任
  （见 §7 D5 反方），v1 不开，Mac 桥接版保留。

### 4.5 S5 — 官网整合与文案自洽

- 导航右侧加「登录 / Sign in」（次级样式，Download 保持主 CTA）→ cloud.meetlisa.ai；
  首页 CTA 带加一行"或者：免下载，云端直接试" → 同链接。
- 新增 `/cloud` 页（双语）：本地版 vs 云版对照表、免费窗口说明、隐私边界
  （云版存什么、本地版什么都不存）。
- **文案排雷（必须与登录功能同 PR 上线）**：install.astro:13"nothing to sign up
  for"、index.astro:102"no central account"、privacy 页"no account system"——全部改为
  "**本地版**无账号无遥测（旗舰不变）；**云版**可选，账号仅存 email + 你的 Lisa 数据"。
  隐私政策补云版数据条款（收集 email/uid、GCS 存储、删除权 = `DELETE /api/account`
  已实现全家目录抹除）。
- App Privacy 标签同步更新（RUNBOOK 已列）。

### 4.6 S6 — GCP 生产化（"后端部署到 GCS"的落地口径）

需求口径确认：**后端跑在 Cloud Run，持久化在 GCS**（bucket 挂 `/data` = per-uid 家目录），
即现状架构的生产化，而非"部署到 GCS"字面（GCS 不能跑服务）：

1. **独立生产项目** `lisa-cloud-prod`（现在 demo 与个人项目混居 oratis-491316；
   RUNBOOK 已把独立项目列为公开注册前置）。
2. **Secret Manager**：deploy.sh 现在把 LLM key/Stripe key 用 `--set-env-vars` 明文
   注入（控制台可见），改 `--set-secrets` 引用 Secret Manager。
3. **Firestore 开启**（`LISA_FIRESTORE=1`）+ `accounts.json` 一次性导入 +
   `MAX_INSTANCES>1`：代码全部已在（B9），deploy.sh 的单写者护栏也已在，缺的只是
   执行导入与拨开关。turn-lease 保证跨实例 per-uid 串行。
4. **域名**：`cloud.meetlisa.ai` CNAME → ghs.googlehosted.com + Cloud Run domain
   mapping（RUNBOOK 步骤现成）；Cloudflare 该记录 DNS-only（灰云），TLS 由 Google 管。
5. **gcsfuse 风险管理**：soul 是大量小文件 + git 仓库，FUSE 上 git 操作慢且易碎——
   cloud 版关 soul git（本地版不变）；热路径状态（余额/租约/账号）本就走 Firestore。
   长期若 IOPS 成瓶颈再评估 Filestore/原生 GCS API，v1 不动。
6. **可观测**：uptime check 打 `/api/auth/config`；日志告警接 meter.ts 已有的
   异常消费告警（>$10/天/用户）；GCP Budget 告警；`LISA_BILLING_KILL=1` 急停已建成。
7. **成本底座**：min=1 常驻 2vCPU/4GiB ≈ $55–110/月 + LLM 消耗（免费窗口走 GLM，
   边际成本低；premium 只烧付费余额，结构性不亏）。

## 5. 里程碑

| 里程碑 | 内容 | 依赖 | 体量 |
|---|---|---|---|
| **S1** | Google 登录（web）：`/api/auth/google` + GIS 按钮 + upsert/合并 + 测试 | GCP OAuth Client（人工 5min） | 小（镜像 apple 通道） |
| **S2** | OTP 基建：验证码注册验证 + 免密登录 + 密码找回 + Resend 模板 | 无 | 中 |
| **S3** | birth 事务化 + 注册后仪式 + Turnstile/频控 + birth lease + 锁路径修复 | 无 | 中 |
| **S4** | per-uid 自主性 sweep + 成本闸门 + "Connect your Mac"入口占位 | S3 | 中大 |
| **S5** | 官网：登录入口 + /cloud 页 + 文案/隐私改写（双语） | S1–S3 可用 | 小 |
| **S6** | 生产化：prod 项目、Secret Manager、Firestore 开启、域名、监控 | 人工步骤多 | 中（多为运维） |
| **S7**（可选） | iOS 加 Google 登录 + 账号合并 UI | S1 | 小 |

建议节奏：S1+S2+S3 一波（登录矩阵补全 + birth 硬化），S5 紧随其后点亮入口，
S6 在放开公开注册**之前**完成，S4 随付费档位一起打磨。

## 6. Non-goals（v1 不做）

- 跨域 SSO / 官网内嵌 app（分域跳转足够，静态官网零 JS 的性能与简洁保留）。
- 微信/手机号登录（中国区合规与实名是另一个战役，另立计划）。
- 订阅制（维持消耗型 token 包 + 档位，PLAN_ACCOUNTS_BILLING 决议不变）。
- 云上 PTY/Sense（安全与成本，PLAN_CLOUD 的 non-goal 维持）。
- 自建邮件通道（继续 Resend）。

## 7. 正反方辩论

### D1 官网要不要出现"注册/登录"（品牌之辩）

- **正方**：无 Mac 用户与手机用户当前完全无法体验 LISA；iOS 审核已因此拒过一次
  （2.1）；账号+计费闭环（B 系列）已经建成，不给官网入口等于建好商场不开门。
  转化漏斗"官网 → 下载 DMG → 配 API key"对普通用户过陡，"官网 → 注册 → 30 秒出生"
  是唯一能给非开发者的路径。
- **反方**：官网满屏"sovereign, 100% local, no account"是 LISA 最锋利的差异化；
  加登录按钮 = 亲手稀释它，HN/Reddit 人群会第一时间截图"看，他们也开始要账号了"。
  且云版让 LISA 首次成为用户数据的 data processor，隐私责任从零到一。
- **裁决：做，但以"双制并陈"表述。** 本地版永远是旗舰、永远无账号（这句话反而要
  写得更大声）；云版定位为"没有 Mac 的人也配拥有一个 Lisa"。文案改写（§4.5）与登录
  入口必须同 PR 上线，绝不让"no account"的旧文案与登录按钮同屏打架。数据处理责任
  用已实现的一键删号（全家目录抹除）+ 隐私政策明晰化来兜。

### D2 Google 登录：当年刻意不做，现在要不要翻案

- **正方（加）**：当年不做的理由是"规避 Apple 4.8"，但后来 SIWA 已实装——4.8 的
  义务已经满足，理由自然失效。Web 端（本计划的主战场）根本不受 App Store 管辖；
  全球 web 转化第一大道就是 Google 账号，尤其目标用户（开发者/生产力人群）几乎人手
  Gmail。邮箱密码注册的摩擦（发码、等码、想密码）是 Google 一键的三倍以上。
- **反方（不加）**：多一个 IdP 多一条 JWKS 供应链与配置面；GIS 按钮要在登录页引入
  Google 第三方脚本（当前登录页零外部依赖）；账号合并逻辑（google/email 同邮箱）
  引入新的被接管面；iOS 端若跟进还要拖 GoogleSignIn SDK。
- **裁决：加，web 优先（S1），iOS 缓行（S7 可选）。** 服务端校验与 Apple 通道同构、
  零新依赖，成本极低；合并策略收紧为"双方邮箱均已验证才并号"堵接管面。GIS 脚本
  只进登录页，不进主 UI，污染面可控。

### D3 自研零依赖 auth vs 迁移 Firebase Auth / Identity Platform / Clerk

- **正方（迁托管）**：登录矩阵已膨胀到 Apple+Google+密码+OTP+找回，托管方案一次给齐,
  还附送 MFA、风控、审计面板；自研 crypto 代码每一行都是审计负债；Identity Platform
  与既有 GCP 栈同构，月免费额度足够早期。
- **反方（守自研）**：仓库哲学就是零依赖（IAP 验证、Stripe、Firestore client 全部
  手写 REST 且带完整测试）；现有实现已过评审：JWKS 缓存、nonce 防重放、恒时比较、
  防枚举 decoy、sessionVersion 吊销一个不缺。迁移 = 把 uid 体系、会话格式、iOS 客户端、
  网关鉴权全部重排一遍，换来的能力（MFA 等）v1 并不需要；且托管 IdP 成为可用性与
  隐私上的新单点（LISA 的卖点恰是不把用户数据交给第三方）。
- **裁决：守自研。** 新增面（Google 校验、OTP）都是既有模式的同构复制，边际成本低、
  风格一致。把"何时翻案"写成明确触发器：需要 MFA/SAML/企业 SSO，或 auth 相关安全事件
  出现第二次，再评估 Identity Platform。

### D4 邮箱验证：验证码（OTP）vs 验证链接；要不要免密登录

- **正方（OTP 为主 + 免密登录）**：手机上点邮件链接常被 in-app 浏览器劫走、跨设备
  （电脑注册手机收信）时链接直接断流，6 位码无此病；OTP 一套基建三处复用（验证/
  免密/找回），补上密码找回这个真空洞；"邮箱密码+验证码"也是需求原文。
- **反方（链接够用）**：链接已实装且免费在跑；OTP 引入暴破面（6 位 = 100 万空间，
  必须配严格限速）、多一张状态表；免密登录让"邮箱收件箱被攻破 = 账号被攻破"的
  等式更直接。
- **裁决：OTP 为主、链接保留兜底（同一 token 体系两种呈现）。** 暴破面用
  10 分钟过期 + 5 次尝试 + 散列存储 + 恒时比较 + IP 限频封死；免密登录本质上与
  "链接找回密码"同一信任根（收件箱），并不新增信任假设，接受。

### D5 "全部 web 功能"：字面兑现 vs 云可行全集

- **正方（字面全给）**：需求写的就是"全部"；砍功能的云版会被拿来与本地版对比出
  "阉割感"，伤"云上也是完整 Lisa"的叙事。
- **反方（云可行全集）**：PTY/dispatch/Sense 的本体是**用户自己的机器**——云上没有
  用户的终端、屏幕与剪贴板，"云上 PTY"要么变成给每个用户开容器沙箱（成本与安全
  自杀，PLAN_CLOUD 已列为 non-goal），要么是假功能；IMAP 托管是全新的密钥保管责任。
  真正让"云 Lisa 完整"的不是硬搬 mac-only 四项，而是把**灵魂系统完整**（soul/心跳/
  REVE/KB per-uid 全跑通）+ 桥接你的 Mac。
- **裁决：云可行全集 + per-uid 自主性补全 + "Connect your Mac"桥接。** 二级系统的
  完整性定义为：灵魂/自主性/知识/记忆全量（这才是 LISA 的差异化），机器绑定类能力
  由 Mac 桥接补齐（PLAN_IDENTITY 路线不变）。IMAP 云托管 v1 不开。

### D6 注册后 birth：阻塞式仪式 vs 静默懒执行

- **正方（仪式化）**：出生仪式是 LISA 品牌的第一好戏（README 头图级素材），把它
  藏进后台等于把婚礼办在地下室；打字机 SSE UI 现成，30 秒的"等待"恰是仪式感本体，
  也天然掩护了 LLM 时延。
- **反方（静默懒）**：注册转化漏斗每多 30 秒都是流失；LLM 偶发失败让用户第一眼
  看见报错；脚本注册会把每次 birth 的 LLM 调用变成成本攻击。
- **裁决：仪式化，且正因如此 S3 的三件套是前置**——事务化+重试（失败不再裸露）、
  Turnstile+频控（成本攻击关门）、失败兜底文案（"Lisa 出生遇阻，正在重试"）。
  懒 birth 保留为 API 直连兜底路径。

### D7 扩容：单实例文件后端 vs Firestore 多实例

- **正方（尽快开 Firestore 多实例）**：单实例是可用性单点（每次 deploy 即中断）；
  min=max=1 没有水平余量，一次 HN 流量峰就躺；B9 代码已写完，不开白不开。
- **反方（先守单实例）**：当前 DAU 个位数，单实例便宜、心智简单、文件后端可
  `cat` 可 `git log`；Firestore 切换是**空库 cutover**，要导入脚本与回滚预案；
  开了多实例，per-uid 家目录仍在同一 gcsfuse bucket，写并发问题只是被 lease 缓解。
- **裁决：公开注册（S5 上线）为界。** 之前守单实例；S6 作为放开注册的**前置门槛**
  完成 Firestore 开启 + 导入 + `MAX_INSTANCES>1`。deploy.sh 已内置"文件后端禁止
  多实例"护栏，顺序不会做反。

## 8. Open questions

1. `cloud.meetlisa.ai` vs `app.meetlisa.ai`：本文按 cloud（Apple Services ID 已按此
   配置）；若品牌上更想要 app，需在 Apple portal 重验域名，宜早不宜迟。
2. per-uid 自主性 sweep 的活跃判定（7 天内有会话？）与免费档节奏（每日 1 次轻反思？）
   ——随 S4 定价评审一起裁决。
3. 中国大陆访问性：GIS 脚本与 Google JWKS 在大陆不可达，登录页需对 Google 按钮做
   失败降级（隐藏而非报错）；是否为大陆做专门通道（手机号/微信）→ 另立计划。
4. 一次性邮箱黑名单的维护来源（静态表 vs 第三方清单）。
