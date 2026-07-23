# RUNBOOK — 账号/计费上线的人工操作 (operator actions)

**配套**: [PLAN_ACCOUNTS_BILLING_v1.0.md](PLAN_ACCOUNTS_BILLING_v1.0.md) §10（PR #259–#267）
与 [PLAN_AUTH_OTP_GOOGLE_v1.0.md](PLAN_AUTH_OTP_GOOGLE_v1.0.md) §6（PR #289–#293，
验证码登录 + Google 登录 → Phase 8–10）。
本文是代码做不了的那部分：Apple 后台、ASC、GCP、DNS、部署。按阶段顺序执行；
每步标注了前置依赖和大致耗时。

---

## Phase 0 — 合并 PR 链（30 min，一切的前置）

PR 是堆叠的：main ← #259 ← #260 ← #261 ← #262 ← #263 ← #264 ← #265 ← #266 ← #267。

**推荐流程（沿用仓库的 squash 习惯）**：
1. 按 #259 → #267 的顺序逐个 squash-merge。上层 PR 与已合并内容完全一致，
   merge 时不会产生冲突。
2. **合并过程中不要勾 "delete branch"**（本仓库踩过坑：删除 base 分支会把上层
   PR 自动关闭，见 #170 事故）。等 #267 合并后，再统一删除 9 个分支。
3. 每合并一个，确认下一个 PR 的 base 已自动指向或手动改为 main 再合并
   （GitHub 通常自动 retarget；不确定就在 PR 页面手动 Edit base）。

**偷懒流程（一次合并全部）**：把 #267 的 base 改成 main，用 **Create a merge
commit**（不要 squash，保留 9 个里程碑提交）合并 — 其余 8 个 PR 会被 GitHub
自动标记为 merged。

## Phase 1 — Apple Developer portal：开 Sign in with Apple（5 min）

> 前置：无。阻塞：下一次签名构建（testflight.sh）——没开 capability，
> automatic signing 会因 entitlement 不匹配失败。

1. developer.apple.com → **Account** → **Certificates, Identifiers & Profiles**
   → **Identifiers**。
2. 找到 App ID **`ai.meetlisa.main`**（就它；widget 的
   `ai.meetlisa.main.widgets` 不需要动）。
3. **Capabilities** 勾选 **Sign In with Apple** → Edit → 选
   **Enable as a primary App ID** → Save。
4. 无需创建 Services ID/Key —— 那是网页版 SIWA（B7 遗留项）才要的；原生 iOS
   只需要 App ID capability。
5. 保存后 automatic signing 会自动重新生成 provisioning profile；若下次
   archive 报 profile 错误，用 Xcode 打开工程让它刷新一次即可。

## Phase 2 — ASC：Paid Apps 协议 + 税务银行（30 min 填表，审批 1–3 天）

> 前置：无。阻塞：IAP 商品无法被 App 拉取（paywall 会一直 "Loading packs…"）。
> **这是最长的外部等待，今天就提交。**

1. App Store Connect → **Business**（旧版叫 Agreements, Tax, and Banking）。
2. **Paid Apps / Paid Applications** 协议 → View and Agree to Terms。
3. **Bank Account**：添加收款账户（国内账户可用 CNAPS，或用有 SWIFT 的账户）。
4. **Tax Forms**：至少填美国 **W-8BEN**（非美个人）；其他地区税表按需（不填只
   影响对应地区的销售）。
5. 状态变 **Active** 后才算完成（回到 Business 页可查）。

## Phase 3 — DNS + 部署（30 min；与 Phase 2 并行）

### 3a. cloud.meetlisa.ai → lisa-cloud

App 端预填的默认地址是 `https://cloud.meetlisa.ai`（AppState.defaultCloudBase）。

```bash
gcloud beta run domain-mappings create \
  --service lisa-cloud --domain cloud.meetlisa.ai \
  --region us-central1 --project oratis-491316
```

命令会输出所需 DNS 记录 —— 到你的 DNS 服务商给 `meetlisa.ai` 加一条：

```
cloud  CNAME  ghs.googlehosted.com.
```

（meetlisa.ai 主域已在同项目跑 lisa-web，域名所有权验证应已通过；如提示未验
证，按命令给的 TXT 记录先验证。）TLS 证书自动签发，约 15–30 分钟生效。
生效验证：`curl -sI https://cloud.meetlisa.ai/ | head -3`（应 401 + HTML 登录页）。

### 3b. 重新部署（带新 env）

```bash
# 取现有 token / key（别重新生成，免得旧的粘贴链接失效）：
gcloud run services describe lisa-cloud --project oratis-491316 \
  --region us-central1 --format='value(spec.template.spec.containers[0].env)' 

LISA_WEB_TOKEN='<现有值>' \
ZHIPU_API_KEY='<现有值>' \
LISA_MODEL=glm-4.6 \
ANTHROPIC_API_KEY='<可选：要开高价档才填>' \
LISA_CLOUD_APPLE_SIGNIN=1 \
LISA_REVIEWER_SEED='reviewer@meetlisa.ai:<新起一个强密码>' \
deploy/deploy.sh
```

要点：
- **`LISA_REVIEWER_SEED` 的密码自己起一个强密码并记下来** —— 它就是待会填进
  ASC "Sign-in required" 的密码。种子幂等：账号已存在时不改密码。
- `ANTHROPIC_API_KEY` 只在想让付费用户用 Claude 档时加；GLM 免费档只需 ZHIPU。
- 升配（2 vCPU / 4Gi / timeout 3600）在脚本里，无需另外操作。
- 可选防线：`LISA_DAILY_CAP_USD=50` 起步更保守（默认 200）。

### 3c. 部署后自检（5 min）

```bash
BASE=https://cloud.meetlisa.ai
# 1) 登录页在（401 + HTML）：
curl -s -o /dev/null -w '%{http_code}\n' -H 'Accept: text/html' $BASE/
# 2) 审核账号能登录：
curl -s $BASE/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"reviewer@meetlisa.ai","password":"<密码>"}' | head -c 120; echo
# 3) 拿上一步的 token 查额度（应 tier2、$20 credits）：
curl -s $BASE/api/billing/quota -H "Authorization: Bearer <token>"
```

## Phase 4 — ASC：IAP 商品（30 min；协议 Active 后商品才拉得下来）

My Apps → Lisa Pocket → **Monetization → In-App Purchases** → ⊕，类型一律
**Consumable**，Product ID 必须逐字一致：

| Product ID | 价格 | Display Name（建议） | 描述要点 |
| --- | --- | --- | --- |
| `ai.meetlisa.main.credits.5` | $4.99 | Starter Credits | $5.00 in credits; boosts your daily session to $10 for 30 days |
| `ai.meetlisa.main.credits.10` | $9.99 | Plus Credits | $10.50 in credits (+5%); Tier 1 boost |
| `ai.meetlisa.main.credits.20` | $19.99 | Max Credits | $22.00 in credits (+10%); Tier 2 boost ($20/session) |

每个商品要上传一张 **Review Screenshot**（模拟器里截 PaywallSheet 即可，
`packaging/ios-companion/build.sh` 起模拟器 → Settings → Add credits…）。
商品做到 **Ready to Submit** 即可 —— **首批 IAP 必须与新版本二进制一起送审**
（1.1 版本页底部有 In-App Purchases 区，把三个商品勾进去）。

顺手在 **Users and Access → Sandbox Testers** 建一个 sandbox 测试账号，
真机 dev build 里可免费走完整购买流（TestFlight 构建的 IAP 本身就不扣真钱）。

## Phase 5 — Small Business Program（10 min，随时可做）

developer.apple.com/app-store/small-business-program/ → Enroll（需要
Account Holder 身份）→ 确认关联开发者账号与近 12 个月收入 < $100 万。
生效后佣金 30% → **15%**。尽早提交（按月生效，过号等下月）。

## Phase 6 — ASC 元数据 + 1.1 送审（1 h + 审核等待）

### 6a. App Privacy（必改，否则与二进制隐私清单不一致）

App Privacy → Edit → "Do you or your third-party partners collect data?" →
**Yes**：
- **Email Address** — App Functionality / Linked to user / No tracking
- **User ID** — App Functionality / Linked to user / No tracking

其余保持不收集。Publish。

### 6b. 打 1.1 构建

```bash
# project.yml: MARKETING_VERSION: "1.1"
cd packaging/ios-companion
ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_PATH=… ./testflight.sh
```

（记忆中的四个签名坑：automatic signing、别强制 Distribution、iPad 四方向、
Issuer ID 用对 —— testflight.sh 均已处理。）

### 6c. App Review Information（终局版，替换 B0 的粘贴 token 版本）

- **Sign-in required: YES**
- **User name**: `reviewer@meetlisa.ai`
- **Password**: `<LISA_REVIEWER_SEED 里那个密码>`
- **Notes**（粘贴）：

```
Lisa Pocket now has standard account sign-in.

Steps:
 1. Open the app. On the welcome flow choose "LISA Cloud" (Recommended),
    or go to Settings tab → "Connect to" → "LISA Cloud".
 2. The cloud URL field is pre-filled (https://cloud.meetlisa.ai).
    Sign in with the demo account above (email + password).
 3. The app verifies the connection and shows "Connected to LISA Cloud."
 4. Chat tab → talk to Lisa. Replies stream in.

The demo account is pre-funded, so In-App Purchase credit packs are listed
but not required for review; the free 12-hour session allowance also renews
automatically. "My Mac" mode connects to the user's own computer and is not
needed for review.
```

### 6d. 提交 + 回复本次拒审

1.1 版本页：Add Build（选刚处理完的构建）→ In-App Purchases 勾三个商品 →
Save → **回复 2026-07-13 那条拒审消息**（Submission `cb80235c…`），说明：

```
Thank you for the details. The sign-in issue is resolved: version 1.1 adds a
standard account system (email/password + Sign in with Apple). A funded demo
account is provided in App Review Information (username/password), and the
app now verifies the connection at sign-in time. Please review 1.1.
```

→ Submit for Review。

## Phase 7 — 上线后看板（持续）

- `lisa billing`（登录后）/ `GET /api/billing/usage` —— 用量。
- Cloud Run 日志里盯三类行：`[iap] credited …`、`[billing] ⚠ anomaly`、
  `[accounts] reviewer demo account ready`。
- 急停：`gcloud run services update lisa-cloud --update-env-vars LISA_BILLING_KILL=1 …`
  （恢复时改回空值）。

## Phase 8 — 验证码登录上线（Resend 是硬依赖）

> 配套 [PLAN_AUTH_OTP_GOOGLE_v1.0.md](PLAN_AUTH_OTP_GOOGLE_v1.0.md) A1/A2。
> **没有可用的发信通道 = 没人收得到验证码 = 登录不了**（缺 key 时验证码只会
> 打进服务端日志）。上线前务必确认这一条。

1. **Resend**：确认 `RESEND_API_KEY` 已在 Cloud Run env 里，且 `meetlisa.ai`
   在 Resend 后台是 **Verified**（SPF + DKIM 记录已加在 DNS）。
   B8a 的验证邮件用的是同一条通道，所以之前若已验证过就无需重做。
2. **自检**（部署后）：

```bash
BASE=https://cloud.meetlisa.ai
# 应答 {"ok":true,"sent":true,...}；sent:false 就是发信没配好
curl -s $BASE/api/auth/otp/request -H 'content-type: application/json' \
  -d '{"email":"你的邮箱@example.com"}'
# 收到邮件后拿六位数字换 session
curl -s $BASE/api/auth/otp/verify -H 'content-type: application/json' \
  -d '{"email":"你的邮箱@example.com","code":"123456"}'
```

3. 免费额度：验证码登录建号即 `verified=true`，直接拿满额 $5 窗口（旧的
   "未验证邮箱 $1" 只剩历史密码账号会遇到）。
4. 审核账号不受影响：`reviewer@meetlisa.ai` 仍是密码登录，ASC 表单不用改。

## Phase 9 — Google 登录（GCP OAuth）

> 配套 A3/A4。不配 client ID 时，Google 按钮在四端都不出现，其它登录方式照常。

1. GCP Console（项目 `oratis-491316`）→ **APIs & Services → OAuth consent
   screen**：User Type 选 **External**，填应用名/支持邮箱/开发者邮箱，
   Scopes 只要 `openid`、`email`（不要 profile 之外的敏感 scope，免走审核），
   然后 **Publish app**（Testing 状态只有测试名单里的账号能登）。
2. **Credentials → Create Credentials → OAuth client ID**，建**两个**：
   - **Web application** —— Authorized JavaScript origins 填
     `https://cloud.meetlisa.ai`（GIS 按钮按 origin 校验；不需要 redirect URI）。
   - **iOS** —— Bundle ID 填 `ai.meetlisa.main`。
     （iOS 客户端的 redirect 由 Google 自动按"反转 client ID"配好，无需手填；
     app 侧也不用注册 URL scheme —— ASWebAuthenticationSession 自己拦截回调。）
3. **重新部署**，带上两个 client ID（顺带把 SIWA-web 的 Services ID 一起补上，
   解决 `/api/auth/config` 里 `appleWeb: null`）：

```bash
LISA_WEB_TOKEN='<现有值>' \
ZHIPU_API_KEY='<现有值>' \
LISA_MODEL=glm-4.6 \
LISA_CLOUD_APPLE_SIGNIN=1 \
LISA_REVIEWER_SEED='reviewer@meetlisa.ai:<现有密码>' \
RESEND_API_KEY='<现有值>' \
LISA_GOOGLE_WEB_CLIENT_ID='<web client id>.apps.googleusercontent.com' \
LISA_GOOGLE_IOS_CLIENT_ID='<ios client id>.apps.googleusercontent.com' \
LISA_CLOUD_APPLE_WEB_SID='<Apple Services ID，可选>' \
deploy/deploy.sh
```

4. **自检**：`curl -s https://cloud.meetlisa.ai/api/auth/config` 应看到
   `google: {webClientId: …, iosClientId: …}`；打开登录页应出现 Google 按钮。
5. **iOS 1.2 送审前**：Google 登录不改变 App Privacy 申报（email/User ID 已申报）；
   4.8 合规靠 SIWA 仍在首位满足 —— 改动版面时别把 Apple 按钮挪到 Google 下面。

## Phase 10 — 发 iOS 构建（CI 已配齐，无需 Mac）

**先确认版本号该不该动**（取决于 ASC 上 1.1 的状态，代码里看不出来）：

- **1.1 还没送审**（Phase 6 尚未做完）→ **不要改版本号**。验证码/Google 登录
  直接并进 1.1 这一版一起送审，只是多打一个 build。
- **1.1 已在审核中或已上架** → 把 `packaging/ios-companion/project.yml` 的
  `MARKETING_VERSION` 提到 `1.2`，再走下面的 tag。

六个签名 secret 自 2026-07-23 起已在 `oratis/LISA` 仓库配好，任何有 push 权限的
协作者都能发版（tag 名与 MARKETING_VERSION 对齐即可）：

```bash
git tag pocket-v1.1.1 && git push origin pocket-v1.1.1
```

（或 Actions 里手动跑 `release-ios-testflight.yml`。）build number 是构建时的
Unix 时间戳，自动生成，所以同一 MARKETING_VERSION 可以反复出 build。细节见
[packaging/ios-companion/RELEASE.md](../packaging/ios-companion/RELEASE.md)。

**Review Notes 增补一句**（Phase 6c 那段文案后面加）：

```
Sign-in now also accepts a one-time code emailed to any address, and
Sign in with Google. The demo account above still uses email + password.
```

## （可选）多实例扩容 — Firestore 模式（B9）

单实例（默认）什么都不用做。用户量上来后要 `max-instances > 1` 时：

1. GCP 项目启用 Firestore：`gcloud services enable firestore.googleapis.com
   --project oratis-491316`，并在 Console 里创建 **Native mode** 数据库
   （区域选 us-central1，与 Cloud Run 同区）。
2. Cloud Run 运行 SA（默认 compute SA）授予 `roles/datastore.user`。
3. 部署时加：`LISA_FIRESTORE=1 MAX_INSTANCES=3 deploy/deploy.sh …`
   （脚本会拒绝没有 LISA_FIRESTORE 的 MAX_INSTANCES>1）。

切换后：账号表、余额、交易去重索引、全局日上限、per-uid turn lease 全部走
Firestore CAS；soul/会话文件仍在 GCS per-uid 子树（turn lease 保证同一账号
同时只有一个实例在跑 turn）。注意：从文件切 Firestore 是**空库开始**——现有
账号需要一次性导入（`accounts.json` → `lisa-global/accounts` 文档），切换前
问我要导入脚本即可。

## 依赖关系速查

```
Phase 0 (merge) ─┬─► Phase 1 (SIWA capability) ──► Phase 6b (build 1.1)
                 ├─► Phase 2 (Paid Apps 协议) ───► Phase 4 (IAP 商品) ─► Phase 6d (随 1.1 送审)
                 ├─► Phase 3 (DNS + deploy) ─────► Phase 6c (审核账号可用)
                 └─► Phase 5 (SBP，独立)

验证码 / Google（PR #289–#293 合并后）：
Phase 8 (Resend 核实) ──┐
Phase 9 (GCP OAuth) ────┴─► 一次重部署（两组 env 一起带上）──► Phase 10 (发 1.2)
```
