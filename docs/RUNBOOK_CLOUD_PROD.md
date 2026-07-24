# RUNBOOK — LISA Cloud 公开注册上线（S6）

**这是把 cloud.meetlisa.ai 从"审核 demo"推到"公开注册"的操作手册。**
承接 [RUNBOOK_ACCOUNTS_LAUNCH.md](RUNBOOK_ACCOUNTS_LAUNCH.md)（Apple/ASC 侧手续）与
[PLAN_WEB_SIGNUP_v1.0.md](PLAN_WEB_SIGNUP_v1.0.md)（S 系列设计）。**除注明外全部
需要 owner 凭据，由人工执行**；每一步幂等，可安全重跑。

先决条件：S1–S5 的 PR 已合并（Google 登录、OTP、birth 硬化、per-uid sweep、官网入口）。

---

## 0. 独立生产项目（一次性）

Demo 与个人项目混居 `oratis-491316`；公开注册前迁到专属项目，隔离账单与 IAM 爆炸半径。

```bash
gcloud projects create lisa-cloud-prod --name "LISA Cloud"
gcloud billing projects link lisa-cloud-prod --billing-account <BILLING_ACCOUNT_ID>
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  firestore.googleapis.com secretmanager.googleapis.com \
  cloudscheduler.googleapis.com --project lisa-cloud-prod
```

之后所有命令带 `PROJECT=lisa-cloud-prod`。（继续用旧项目也行——跳过本节，其余照旧。）

## 1. Firestore（多实例前置，B9）

```bash
gcloud firestore databases create --project $PROJECT --location us-central1 --type firestore-native
```

**导入现有账号**（服务仍在 `MAX_INSTANCES=1` 时执行；脚本幂等，tx 索引 create-only）：

```bash
# 先把 GCS 家目录同步到本地（或直接挂载）：
gcloud storage rsync -r gs://<project>-lisa-cloud-data /tmp/lisa-home
LISA_FIRESTORE=1 LISA_FIRESTORE_PROJECT=$PROJECT \
  LISA_FIRESTORE_TOKEN="$(gcloud auth print-access-token)" \
  npx tsx scripts/import-accounts-firestore.ts /tmp/lisa-home --dry-run   # 先看
# 去掉 --dry-run 正式导入；重复导入安全（已存在则跳过）
```

## 2. 部署（Secret Manager 模式 + Firestore 开启）

```bash
PROJECT=$PROJECT SECRETS_MODE=sm LISA_FIRESTORE=1 MAX_INSTANCES=3 \
  LISA_WEB_TOKEN=… ZHIPU_API_KEY=… ANTHROPIC_API_KEY=… \
  RESEND_API_KEY=… LISA_MAIL_FROM='LISA <no-reply@meetlisa.ai>' \
  STRIPE_SECRET_KEY=… STRIPE_WEBHOOK_SECRET=… \
  LISA_CLOUD_APPLE_SIGNIN=1 LISA_CLOUD_APPLE_WEB_SID=… \
  LISA_CLOUD_GOOGLE_SIGNIN=1 LISA_CLOUD_GOOGLE_CLIENT_ID=… \
  LISA_TURNSTILE_SITE_KEY=… LISA_TURNSTILE_SECRET=… \
  LISA_SWEEP_TOKEN="$(openssl rand -hex 24)" \
  deploy/deploy.sh
```

- `SECRETS_MODE=sm`：敏感值进 Secret Manager（每次部署推新版本），容器经
  `--set-secrets` 引用，控制台 env 页不再可见明文。
- 部署脚本自带护栏：`MAX_INSTANCES>1` 必须配 `LISA_FIRESTORE=1`。

## 3. 第三方控制台开关（各一次性，人工）

| 事项 | 在哪配 | 备注 |
|---|---|---|
| Google OAuth Client | GCP Console → Credentials → OAuth client (Web) | Authorized JS origin = `https://cloud.meetlisa.ai`；产出的 client id 即 `LISA_CLOUD_GOOGLE_CLIENT_ID`；同意屏(Branding)配 logo/域名 |
| Apple web Services ID | Apple Developer portal | 见 RUNBOOK_ACCOUNTS_LAUNCH §B8b；域名验证 cloud.meetlisa.ai |
| Turnstile widget | Cloudflare dash → Turnstile | hostname = cloud.meetlisa.ai；site key/secret 即两个 `LISA_TURNSTILE_*` |
| Resend 域名 | Resend dash | `meetlisa.ai` 已验证（B8a）；确认 SPF/DKIM 仍绿 |
| Stripe webhook | Stripe dash | endpoint `https://cloud.meetlisa.ai/api/billing/stripe/webhook`，事件 checkout.session.completed + charge.refunded |

## 4. 域名 `cloud.meetlisa.ai`

```bash
gcloud beta run domain-mappings create --service lisa-cloud \
  --domain cloud.meetlisa.ai --project $PROJECT --region us-central1
```

Cloudflare DNS：`cloud` CNAME → `ghs.googlehosted.com`，**DNS-only（灰云）**——TLS 由
Google 管，代理会破坏证书签发。等 mapping 状态 ready（约 15 分钟）。

## 5. Cloud Scheduler：per-uid 自主性 sweep（S4）

```bash
URL="$(gcloud run services describe lisa-cloud --project $PROJECT --region us-central1 --format='value(status.url)')"
gcloud scheduler jobs create http lisa-autonomy-sweep --project $PROJECT \
  --schedule "*/30 * * * *" --location us-central1 \
  --uri "$URL/internal/autonomy/sweep" --http-method POST \
  --headers "Authorization=Bearer $LISA_SWEEP_TOKEN,Content-Type=application/json" \
  --message-body '{}'
```

半小时一跳是安全的：档位节奏（free 24h / t1 6h / t2 1h）由每用户 stamp 幂等控制，
空跳几乎零成本。验证：`curl -X POST -H "Authorization: Bearer $LISA_SWEEP_TOKEN" $URL/internal/autonomy/sweep` 应返回 `{"scanned":…}`。

## 6. 监控与告警

```bash
# Uptime check 打公开的 auth 配置端点（无需凭据、恒 200）
gcloud monitoring uptime create lisa-cloud-auth \
  --resource-type uptime-url --resource-labels host=cloud.meetlisa.ai \
  --path /api/auth/config --project $PROJECT
# 预算告警（月 $200 起步，超 50/90/100% 邮件）
gcloud billing budgets create --billing-account <BILLING_ACCOUNT_ID> \
  --display-name lisa-cloud --budget-amount 200USD \
  --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0
```

日志侧已内建：异常消费告警（meter.ts，>$10/天/用户打 `[billing] ANOMALY`）、
sweep 报告行（`[sweep] scanned…`）。建一条 log-based alert 盯 `ANOMALY` 即可。

## 7. 急停开关（记住这三个）

| 开关 | 效果 |
|---|---|
| `LISA_BILLING_KILL=1` 重部署 | 立停一切计量推理（登录/账号页仍可用） |
| Cloudflare Turnstile 调成 Managed-challenge 全量 | 注册口收紧到人类 |
| `gcloud run services update lisa-cloud --max-instances 0` | 整站下线（保数据） |

## 8. 上线冒烟清单

- [ ] 无痕窗口 → cloud.meetlisa.ai → 登录页三种方式齐全（Google/Apple/邮箱+验证码）
- [ ] 新邮箱注册 → 收到验证码邮件 → birth 仪式打字机完整跑完 → 落进 island
- [ ] `DELETE /api/account`（账号页删除）→ 再登录 404/需重注册，家目录已消失
- [ ] 免费窗口计量在账号页可见；Stripe 测试卡充值到账
- [ ] 官网 meetlisa.ai 导航「登录」与 /cloud 页链接可达
- [ ] sweep 手动 curl 返回报告；Scheduler 首跳成功
