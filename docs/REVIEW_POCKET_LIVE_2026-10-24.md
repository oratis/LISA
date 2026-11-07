# Lisa Pocket 上架与生产链路复核 — 2026-10-24

## 商店状态

**Lisa Pocket 1.2 已在[美区 App Store](https://apps.apple.com/us/app/lisa-pocket/id6784690058) 上架**，
App ID `6784690058`，bundle ID `ai.meetlisa.main`，要求 iOS/iPadOS 17+。
Apple Lookup API 当日返回 `version: 1.2`、`releaseDate: 2026-10-14T07:00:00Z`、
`currentVersionReleaseDate: 2026-10-14T17:39:09Z`（后者为北京时间 10 月 15 日 01:39）。
中国大陆和香港的同 ID 查询均无结果；不把美区上架扩大为全地区可下载。

配对 iPhone 的安装清单显示 **1.2 (1791346539)**，与[10 月 7 日送审构建](REVIEW_2026-10-07.md)一致。
安装清单本身不证明安装来源；本轮没有重新安装或替换手机上的 App。
10 月 8 日的视觉刷新晚于送审构建，源码更新不能当成商店包更新。
此前审计和发布说明保留其日期对应的历史事实；本记录是较新的上架与验证依据。

## 403 原因

同一网络、同一域名、同一 `/health` 接口，改变客户端标识得到：

| 请求方式 | 结果 |
| --- | --- |
| Python urllib 默认标识 | HTTP 403，`Server: cloudflare`，响应体 `error code: 1010` |
| 相同 Python 请求，仅改为 curl 标识 | HTTP 200，健康 JSON |
| 相同 Python 请求，仅改为 Lisa Pocket / CFNetwork 标识 | HTTP 200，健康 JSON |
| `LISA-HealthCheck/1.0` 诊断标识 | HTTP 200 |
| 送审客户端源码、系统 URLSession、无自定义 User-Agent | 配置、密码登录、账号、历史、额度和流式聊天均通过 |

[Cloudflare 官方说明](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)
将 1010 定义为按客户端浏览器签名拒绝访问，并指向 Browser Integrity Check。
这是入口针对 Python 默认客户端的拦截，不能据此认定 Lisa Pocket 无法登录。
本轮未读取到有效的 Cloudflare 管理配置，因此不声称核实了具体规则 ID。

Cloud Run `lisa-cloud-00033-meq` 为 Ready，100% 流量；服务入口为 `all`，
`allUsers` 仍有 `roles/run.invoker`。10 月 24 日应用请求日志的 403 查询无结果，
与请求在 Cloudflare 被截住相符。没有修改 IAM、关闭 Cloudflare 防护或重部署后端。

新增[公开健康诊断脚本](../scripts/check-cloud-health.py)，提供明确的客户端标识，区分
1010、其他 HTTP 错误、网络故障及无效 JSON；任何失败均非零退出。

## 原生协议与生产聊天验证

从送审提交 `c5f65ab` 提取未修改的 `LisaClient.swift`、`Models.swift`、
`PushSettings.swift` 和 `APIContract.generated.swift`，编译临时 macOS Swift 验证程序。
其中 `LisaClient.swift` 与当前 `main` 内容一致。使用系统 URLSession 和现有专用审核账号，
请求正式域名 `https://cloud.meetlisa.ai`；凭据在内存中传入，未写入文档、Git 或输出。

- `/api/auth/config`：账号功能启用，AI 接收方为 Google Gemini。
- `emailAuth(register: false)`：密码登录成功，获取会话。
- `authMe()`：已登录，身份匹配专用审核账号。
- `history()`：成功解码 20 条历史；未输出已有对话内容。
- `billingQuota()`：成功读取账号额度。
- `chatStream()`：发送一条明确的服务验证消息，要求计算 `17 + 26`；收到文本流、答案 43 和 `done`，无 `error` 事件。
- 聊天后额度接口仍正常；该验证会话已通过 `/api/auth/logout` 退出（HTTP 200）。

这些结果确认**正式版客户端使用的密码登录与聊天协议可用**。macOS 上运行相同网络代码
不等于在 iPhone 正式 App 内完成 UI 验收。用户解锁镜像后已打开已安装 App 的首页，
随后镜像连接中断并提示 `iPhone Not Found`，真机登录和聊天尚待连接恢复后验收。
Apple/Google 第三方交互登录、真实 StoreKit 购买到账尚未在本轮完成。

## 已修复与剩余事项

- 更新中英文 README、使用指南、iOS README、项目认知和官网首页 / Cloud / 安装页，提供实际 App Store 链接与地区边界。
- 历史审核记录不改写为当时已经上架；当前状态指向本文。
- 生产配置仍未包含 `LISA_APPLE_TEAM_ID`、`LISA_APPLE_KEY_ID`、`LISA_APPLE_PRIVATE_KEY`。
  Apple 登录后的自动授权撤销仍需配置专用密钥并验收。
- 真机交互登录、内购到账及幂等重投继续作为独立验证项，不能由商品可见、健康接口或本次密码登录代替。

## 本轮检查

- `python3 scripts/check-cloud-health.py`：两个公开接口均 200，退出码 0。
- 同一脚本指定 Python 默认标识：两个接口均复现 403，正确识别 Cloudflare 1010，退出码 1；兼容纯文本和 JSON 错误体。
- Markdown 相对链接检查通过；中英文 README 的 10 个标题及使用指南的 51 个标题结构一致。
- 官网 Astro 构建成功，生成 14 个页面；浏览器确认中文首页上架文案和 App Store 按钮显示正常。
- 官网锁文件通过兼容更新修复 6 项 high 依赖告警；`npm audit` 为 0 vulnerabilities，未使用强制跨主版本升级。此次更新不改变生产后端依赖。
- PR 自动检查发现主仓库旧锁文件另有 7 项生产依赖告警（3 high / 4 moderate），以及安装后发现的 1 项开发依赖 high；通过兼容锁文件更新消除。主仓库完整审计和生产审计均为 0。
- 主仓库依赖更新后：**3,453 passed / 1 skipped / 0 failed**；服务端及浏览器端类型检查、API 契约、构建、两个锁文件格式检查通过。后端锁文件修复仅提交至 PR，没有以此重部署正在运行的生产服务。

## 官网发布

静态官网发布为 Cloud Run **`lisa-web-00026-ney`**。先以零流量地址检查，再切换至
100% 流量；旧版本 **`lisa-web-00023-gew`** 保留可回滚。
正式域名的 `/`、`/cloud/`、`/install/` 及对应 `/zh-CN/` 三页均读回 HTTP 200、
真实商店链接和已上架文案。临时预发布标签随后移除。
