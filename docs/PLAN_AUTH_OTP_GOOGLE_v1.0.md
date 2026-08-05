# PLAN — 邮箱验证码登录 + Google 登录 / Email-OTP & Google Sign-In (v1.0)

**Status: IMPLEMENTED（代码侧全部落地，2026-07-24；等运营配置见 §4/§6）。**
承接 [PLAN_ACCOUNTS_BILLING_v1.0.md](PLAN_ACCOUNTS_BILLING_v1.0.md)
(B1 邮箱+密码 / SIWA、B8a 验证链接、B8b SIWA-web)。目标:① 邮箱**验证码(OTP)
免密登录**成为邮箱路径的默认形态;② 新增 **Google 登录**(推翻原 §4 "不加 Google"
的裁决——当时的顾虑是 4.8 连带义务,但 SIWA 已上线且处主位,义务已满足)。

## 1. 现状与缺口

| 组件 | 位置 | 现状 |
| --- | --- | --- |
| 邮箱+密码账号(scrypt) | [src/web/accounts.ts](../src/web/accounts.ts) | ✅ 保留不动(ASC 审核账号必须 user/pass) |
| 验证**链接**(提额 $1→$5) | accounts.ts `mintVerifyToken` + [mailer.ts](../src/web/mailer.ts) | ⚠️ OTP 上线后此流程被吸收(见 §2.3) |
| SIWA(iOS 原生 + web Services ID) | [cloudAuth.ts](../src/web/cloudAuth.ts) / [login.ts](../src/web/login.ts) | ✅ 线上原生已启用;web 端 `appleWeb:null` 待配 |
| Google 登录 | — | ✗ 全库为零 |
| OTP | — | ✗ 全库为零 |
| 发信 | mailer.ts(Resend) | ⚠️ OTP **硬依赖**线上 RESEND_API_KEY(现在缺失只降级打日志) |
| 登录限流/锁定 | accounts.ts 锁定 + [billing/limits.ts](../src/billing/limits.ts) | ✅ OTP 复用同一套 |

## 2. 设计

### 2.1 OTP 免密登录(与密码并存,OTP 为默认)

* **端点**:
  * `POST /api/auth/otp/request {email}` → 生成 6 位数字码;存 `SHA-256(code+salt)`,
    TTL 10 分钟;同邮箱 60s 冷却、每日 ≤10 次;per-IP 限流复用 limits.ts;
    响应恒定(不泄露邮箱是否已注册)。
  * `POST /api/auth/otp/verify {email, code}` → 常量时间比对;单条 OTP 最多试 5 次,
    超限作废;成功 → 签发既有 HMAC session(cookie/JSON token 双通道不变)。
* **注册=登录合一**:验证码成功即证明邮箱所有权 —— 未注册邮箱直接建号且
  `verified=true`(直接 $5 窗口);已注册未验证账号顺带转正。**独立的
  "注册+验证链接"两步流被吸收**,`/api/auth/verify/*` 保留兼容存量邮件。
* **存储**:pending-OTP 独立表(未注册邮箱尚无 account record):file 模式
  `/data/otp.json`(复用 fs-utils 原子写+锁,读时惰性清理过期);Firestore 模式
  `otps` 集合 CAS(与 [firestore.ts](../src/cloud/firestore.ts) 现有模式一致)。
* **密码路径保留**:`/api/auth/login` 原样;UI 上折叠为 "Use password instead"。
  审核账号 `reviewer@meetlisa.ai` 继续密码登录,ASC 表单不变。

### 2.2 Google 登录

* **服务端** `src/web/googleAuth.ts`,复刻 cloudAuth.ts 风格(纯 Node crypto,
  零依赖):Google JWKS(`googleapis.com/oauth2/v3/certs`)缓存 + RS256 验签;
  校验 `iss ∈ {accounts.google.com, https://accounts.google.com}`、
  `aud ∈ {LISA_GOOGLE_WEB_CLIENT_ID, LISA_GOOGLE_IOS_CLIENT_ID}`、`exp`、
  `email_verified === true`。端点 `POST /api/auth/google {idToken}`。
* **账号映射(决策点,推荐如下)**:Google 邮箱命中现有 email-kind 账号 →
  登入该账号并记 `googleSub`(一个邮箱一个 uid,余额不分裂;Google 已验证
  所有权,风险可控);否则建 `g-<sub>` 新号,`verified=true`。SIWA 不参与
  匹配(private relay 邮箱)。
* **客户端**:
  * **web**:GIS(Google Identity Services)按钮,动态注入(与 SIWA-web 同模式);
    `/api/auth/config` 增发 `google.webClientId`。
  * **iOS**:**不引 GoogleSignIn SDK**(沿袭零依赖惯例,先例:拒 RevenueCat、
    cloudAuth 纯 crypto)——用 `ASWebAuthenticationSession` + OAuth **PKCE**
    (authorization code → token 端点换 `id_token`,iOS 类 client 无 secret)→
    POST /api/auth/google。project.yml 加反转 client ID 的 URL scheme。
  * **Mac 菜单栏 / CLI**:v1 不做原生 Google(OTP 已覆盖"免密"诉求);后续可
    复用 ASWebAuthenticationSession(Mac)/ 设备码(CLI)。
* **按钮次序(4.8/HIG)**:Apple 首位、Google 次之、邮箱第三 —— SIWA 等同
  显著性义务持续满足。App Privacy 无新增类别(email/uid 已申报)。

### 2.3 防滥用

OTP 发信是新攻击面:① 请求响应恒定,防枚举;② 冷却+日限+IP 限流(费率:
Resend 免费档 100 封/天,超限告警接既有通道);③ 验证码尝试上限与密码锁定
共用计数语义;④ OTP 建号获 $5 窗口 —— 一次性邮箱女巫风险与现有"邮箱验证后
$5"完全同级,不新增暴露(仍受 per-uid 并发=1 + RPM + 全局日上限约束)。

## 3. Phasing(堆叠 PR,两线可并行)

| 阶段 | 内容 | 依赖 |
| --- | --- | --- |
| **A0** | 本方案入库 | — |
| **A1** | OTP 服务端:otp store(file+Firestore)+ 两端点 + 邮件模板 + 限流 + 测试 | — |
| **A2** | OTP 四端:web 登录页 code-first;iOS 表单;Mac AccountWindow;CLI `lisa login` 默认 OTP(`--password` 保留) | A1 |
| **A3** | Google 服务端:googleAuth 验签 + `/api/auth/google` + email 绑定 + config 下发 + 测试 | — |
| **A4** | Google 客户端:web GIS 按钮 + iOS PKCE 流(project.yml URL scheme) | A3 |
| **A5** | 文档:runbook 增补(GCP OAuth、Resend 核查、部署 env);RELEASE 注记;iOS 1.2 tag 发 TestFlight(CI 已配好,`pocket-v1.2.0` 即可) | A2+A4 |

## 4. 运营前置(人工,代码做不了)

1. **Resend 发信必须真的在线上生效**(OTP 硬依赖):确认 `RESEND_API_KEY` 已配
   且 `meetlisa.ai` 发信域在 Resend 验证通过(SPF/DKIM);未配则 OTP 无法送达。
2. **GCP Console**:OAuth consent screen(External、发布)+ 两个 OAuth Client ID
   (Web 应用、iOS 应用 bundle `ai.meetlisa.main`)。
3. **重部署**:带 `LISA_GOOGLE_WEB_CLIENT_ID` / `LISA_GOOGLE_IOS_CLIENT_ID`
   (顺带补 SIWA-web 的 Services ID,把 `appleWeb:null` 一起解决)。
4. ASC:1.2 送审时 Review Notes 不变(demo 账号仍密码制);4.8 合规自查通过。

## 5. 决策(2026-07-24 拍板,均按推荐项执行)

1. Google 邮箱与既有邮箱账号**自动绑定** —— 一个地址一个账号,余额不分裂(§2.2)。
2. iOS 用 **PKCE 零依赖**(ASWebAuthenticationSession),不引 GoogleSignIn SPM。
3. Mac/CLI 的 Google **缓到下一版**;两端已有 OTP,免密诉求已满足。
4. **OTP 为默认**,密码折叠进 "Use a password instead"(审核账号仍走密码)。

## 6. Implementation log (2026-07-24)

堆叠 PR 链(base: main ← #289 ← #290 ← #291 ← #292 ← #293):

| 里程碑 | PR | 内容摘要 |
| --- | --- | --- |
| A0+A1 | #289 | 本方案入库 + OTP 服务端(otp.ts 存储/两端点/邮件/限流) |
| A3 | #290 | Google 验签(googleAuth.ts)+ /api/auth/google + 一地址一账号绑定 |
| A2 | #291 | OTP 四端(web code-first / iOS 共用表单 / Mac / CLI `lisa login`) |
| A4 | #292 | Google 客户端(web GIS + iOS PKCE)+ config 下发 client id |
| A5 | #293 | 本节 + runbook 增补(RUNBOOK_ACCOUNTS_LAUNCH Phase 8/9) |

**顺带修掉的既有问题**(A2 实测时暴露):CLI 每个 prompt 新建 readline 会丢弃上一个
reader 的缓冲(非 TTY 下第二个 prompt 永远读空);`lisa login` 的兜底 catch 把任何
异常都报成"连不上服务器"。另:登录页首次纳入 inline-script 语法守卫;
`lisa --help` 首次列出 login/logout/billing。

**仍待人工(operator)**:见 §4 与
[RUNBOOK_ACCOUNTS_LAUNCH.md](RUNBOOK_ACCOUNTS_LAUNCH.md) Phase 8–9 ——
Resend 发信域核实(**OTP 硬依赖**)、GCP OAuth consent + 两个 client ID、
带新 env 重部署、iOS 1.2 打 TestFlight(`git tag pocket-v1.2.0`,CI 已配齐)。
