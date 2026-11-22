# 游戏平台 Connector 接入调研

核查日期为 **2026-11-22**。代码基线为 `7977df60c1d8`。能力判断来自平台方的公开文档、条款和支持页。Playnite 导出扩展另引作者说明。本文没有使用玩家凭据、合作伙伴后台或生产 API 做联调。文中的“未公开”指在所列官方资料中未找到面向独立个人助手的接入途径。“待验证”列出各平台后续实测所需的证据。

**首个联网 Connector 建议选 itch.io。** 玩家可以授予游戏库所需的具体权限，桌面应用可以用系统浏览器和本机回调完成授权。想先回答“我在几个平台上都有哪些游戏”，则可从用户主动导出的 Playnite 清单做一次性本机预览。Steam 适合在密钥部署和游戏可见性验证通过后接入。查发行日期和价格可分别使用 IGDB 和 IsThereAnyDeal，无需玩家登录。[itch.io 授权规范][itch-auth] · [Playnite][playnite] · [Valve 身份认证][steam-auth] · [IGDB 文档][igdb] · [IsThereAnyDeal 文档][itad]

## 五大平台的读取与写入边界

“公开接口”表示平台公开了调用方法。实际读取仍可能需要应用密钥。“用户授权”说明玩家能同意开放哪些数据。“合作伙伴”表示还需要发行商身份、特定游戏配置或平台审批。自助查看或导出的数据单独标注。

| 平台 | 公开接口与玩家可授权的读取 | 写入、合作伙伴与未公开能力 | LISA 适用性与依据 |
|---|---|---|---|
| Steam | 商店目录 `IStoreService/GetAppList` 可用 Web API key 按 AppID 翻页。OpenID 2.0 返回已登录者的 64 位 SteamID。持适用 key 可读对调用方可见的拥有游戏、近期游玩及指定 AppID 的个人成就。 | `SetUserStatsForGame` 需要拥有该 AppID 的发行商密钥及安全服务端。Steamworks OAuth 的 Client ID 由 Valve 按用途发放，文档限定跨平台云同步或 Workshop 场景。未见允许个人助手通读私密游戏详情或改任意游戏成就的用户授权。 | 可做“总结我选定的可见游戏”。SteamID 用字符串保存。启动前分别验明身份、详情可见性和密钥归属。[OpenID][steam-auth] · [玩家接口][steam-player] · [成就与统计][steam-stats] · [商店目录][steam-store] · [OAuth 用途][steam-oauth] |
| Epic Games / Epic Games Store | Epic Account Services 的 Basic Profile 可读身份与显示名。Friends、Presence 另按权限及相关账号同意范围开放。应用面向组织外的一般用户前要完成品牌审核。 | Online Presence 权限可设置状态。商店 Ecom 按客户端策略、sandbox 和商品核验 ownership、查 entitlement，适用产品可兑换权益。公开资料未给出任意助手读取玩家全商城游戏库的授权。 | 若只想整理游戏，Epic 账号设置可由本人下载资料 PDF。先验明其中确有的字段，再考虑本机摘取。仅有身份、好友功能时，接入价值有限。[账号权限][epic-privacy] · [品牌审核][epic-review] · [Ecom 读写边界][epic-ecom] · [账号资料下载][epic-export] |
| PlayStation | 玩家可在隐私设置控制游戏活动、奖杯等可见性。SIE 英国支持页说明本人可从账号请求关键个人资料并下载 Excel。下载格式有官方依据，具体工作表、字段与地区覆盖仍待样本验证。 | PlayStation Partners 申请获批并签署 GDPA 后才开放开发及发行文档。在公开材料中未发现通用 PSN 用户委托读取全库、奖杯或好友，或写入奖杯、愿望单的接口。合作伙伴实际权限按协议和标题核实。 | 优先验证本人导出，按工作表和列预览。仅在 Sony 明确认可个人助手用途后评估在线连接。[隐私设置][ps-privacy] · [资料请求][ps-export] · [SIE 合作伙伴说明][ps-partners] |
| Xbox / Microsoft Store | 微软为游戏配套网站记录了发行方 Entra 应用注册、玩家同意、Xbox User Token 和 XSTS 流程，可按授权读资料、统计等。`history/titles` v2 仅覆盖玩家有成就进度或已解锁成就的游戏。 | 完整 Xbox services 的配置及成就写入依赖开发者计划、具体 title 和服务权限。Microsoft Store Collections 按关联到应用客户端 ID 的产品查权益，需要代表该用户的 Store ID key。未证实普通助手可列出全部 Xbox 购买或订阅游戏。 | 可向微软验证获准的只读资料或成就场景。分别测试开发 sandbox 和 RETAIL，并明确“有成就记录”“买过”“目前可玩”的含义。[网站授权][xbox-auth] · [成就历史][xbox-history] · [服务配置][xbox-config] · [Store 权益][ms-collections] |
| Nintendo | 玩家可在 Nintendo Store App 查看游玩活动，在 Nintendo Account 查看 eShop 交易。游玩记录受关联账号时间和主机同步影响。所引自助说明适用于英国地区。 | 开发门户注册并接受 NDA，Switch 开发及发行资源另需申请。可提交本游戏、更新及 DLC。未找到通用用户授权读取 Switch 全库、时长或写入 eShop 愿望单、购买的官方接口。 | 支持用户主动提供的选定记录。若要求自动同步，须先取得 Nintendo 对数据类型、地区和第三方应用用途的说明。[游玩活动说明][nintendo-play] · [交易记录][nintendo-orders] · [开发流程][nintendo-process] · [Switch 权限申请][nintendo-register] |

**Steam 在线读取的开放范围取决于密钥部署。** 用户的 OpenID 登录证明和应用的 Web API key 属于两条信任链。Valve 要求只按玩家请求取数、密钥保密且限定登记应用，告知存储哪些数据，并在隐私政策说明存储国家等事项。文档给出的上限为每日 100,000 次。可先在密钥持有人运营的自托管实例验证。向公众分发的客户端若无法保守同一发行密钥，需另行验证服务端保管与数据流，或保留文件导入。查询时记录是否包含玩过的免费游戏。单个私密游戏、隐藏游玩时间或资料不可见都可能造成缺项。上游没有给出原因时，统一标注“无法确认”。[Web API 密钥][steam-key] · [使用条款][steam-terms] · [私密游戏][steam-private] · [游戏库筛选参数][steam-player]

## 第三方平台、商店与聚合服务

| 服务及用途 | 可读数据、凭据和范围 | 可写数据、限制及 LISA 决策 |
|---|---|---|
| itch.io · 独立游戏商店 | 对本人的 OAuth 申请 `profile:me` 和 `profile:owned`。`/profile/owned-keys` 枚举已发布项目中由购买、领取、礼包或赠送产生的下载权记录。一个游戏可能有多个记录，未领到单独 key 的礼包项目可能缺席。`profile:games` 是上传或有编辑权的作品。 | `collection:edit` 可增删、排序收藏。有编辑权的开发者可按相应权限查自己游戏的购买。玩家库驱动仅取游戏 ID、标题和所需展示字段，不申请这两类能力。无游玩时长证据。[服务端接口][itch-api] · [权限与撤销][itch-auth] |
| GOG / GOG GALAXY · 商店与客户端聚合 | GALAXY SDK 可在开发者自己的游戏中读取统计和成就。Integrations Python API 是 **GALAXY 调用插件**，将其他平台拥有或安装的游戏、时长及成就等导入 GALAXY。各来源覆盖程度取决于插件。 | 游戏 SDK 可提交该游戏的统计和成就变更。该插件协议没有授予 LISA 从 GOG 云端导出全库的权限。先采用用户导出的清单，持有明确 GOG 合作范围后再研究直连。[游戏 SDK][gog-stats] · [GOG 官方插件协议][gog-plugins] |
| Battle.net · 游戏专属平台 | 暴雪以 WoW 为例公开了游戏数据及角色资料端点。受保护的角色资料需要玩家通过授权码流程授予 `wow.profile`。它能回答关于该角色的问题，覆盖范围限于相应游戏和地区。 | 未见可用同一许可写回角色数据或读取整个商店订单。条款限制向第三方传输数据，要求 API 数据最长 30 天 TTL，并对营销及变现作出限制。普通 LISA 流程会把结果交给配置的模型并保存会话。先搁置，直到接收方和所有持久化副本的生命周期满足条款。[暴雪开发团队公告][blizzard-api] · [Blizzard API 条款][blizzard-terms] |
| TapTap · 商店与开发者服务 | 玩家登录后可按 scope 获取应用内的用户 ID、昵称、头像等资料。PC SDK 面向由 TapTap 启动器运行的游戏，可验证本游戏和指定 DLC 的所有权，读取游戏排行榜。 | 开发者可以为本游戏上报分数、解锁成就和写入云存档。所列接口未提供第三方助手枚举玩家完整游戏库的权限。LISA 可先接受用户选定的清单，若要读特定游戏，先向开发者确认授权范围。[登录权限][tap-login] · [PC SDK 能力及运行条件][tap-pc] |
| 腾讯 WeGame · PC 商店与启动器 | 官方流程要求开发者注册、提交游戏项目并通过审核后接入 SDK。公开 FAQ 列出了成就、云存档和排行榜，详细文档需通过开发者账号访问。 | 对独立助手，公开材料尚未确认可读写哪些玩家数据或列出跨游戏库。在线方案须先取得具体项目、读接口和生产许可。首版支持用户选定的清单。[开发者流程及 SDK 说明][wegame] |
| EA app / EA Account · 发行商平台 | 玩家可以在账号设置中请求 HTML 格式的个人资料。EA 还列出可供本人查看的关联账号、游戏专属身份、退款和支付等资料。导出中哪些字段可用于整理游戏，需用样本验证。 | 官方自助说明未列出独立助手读写完整游戏库的授权。候选方案是本机解析用户选择的 HTML，预览后只提取选定游戏字段，排除支付、登录及联系信息。[EA 账号资料下载][ea-data] |
| Ubisoft Connect · 发行商平台 | Ubisoft 隐私中心允许玩家申请下载个人数据。官方列举会处理游戏分数、偏好和游玩交互。每次导出是否含可识别的游戏 ID 或游玩统计仍待样本核对。 | 公开的资料下载途径没有给出助手自动同步或写回游戏进度的权限。拿到脱敏样本后再决定能否支持特定导入格式。[Ubisoft 个人数据与下载入口][ubisoft-data] |
| IGDB · 跨平台元数据 | 用 Twitch 应用 Client ID 和 app access token（client credentials）查游戏名、发行日期、平台、版本及外部游戏 ID。与玩家账号无关。文档限每秒 4 次、同时最多 8 个请求。 | 标准查询使用 HTTP POST 提交检索条件，操作语义是只读。未见允许此查询凭据修改公共条目的接口。非商业使用遵循开发协议。商业项目联系 IGDB 建立合作并在用户可见处署名。适合补全用户明确查询的标题。[IGDB 认证、字段、限额与商用 FAQ][igdb] |
| IsThereAnyDeal · 多商店比价 | 注册应用后用 API key 查游戏匹配、指定国家的各商店报价和可用价格历史。用户自己的 Waitlist、Collection 有独立的 OAuth 能力。价格和库存依赖商店及地区覆盖。 | Waitlist 有新增和删除接口。首版仅查报价。保留国家、币种、商店、原价与原始跳转链接。条款允许公开商用应用和私人个人使用，非个人的私下使用需批准，要求保留原始数据及联盟标记，并限制竞品用途。[接口、鉴权及配额][itad] · [使用条款][itad-terms] |
| Playnite · Windows 本机聚合器 | 用户库保存在自己的 PC。SDK 的 `Game` 有来源插件、游戏 ID、上次活动、以秒计的游玩时长等字段。可选的 Library Exporter Advanced 扩展支持选择字段生成 CSV。 | 本地 SDK 可改库字段，导出扩展写出本地文件。LISA 建议只打开用户选定的 CSV，支持从 Windows 手动交给 Mac。手工条目、插件记录、过期订阅都可能出现，导入结果标注来源和快照时间。[Playnite 隐私说明][playnite] · [SDK 字段][playnite-game] · [导出扩展作者说明][playnite-export] |

## 与现有 Connector 和隐私控制的衔接

| 代码基线已有的行为 | 游戏接入需要补上的部分 |
|---|---|
| `CONNECTOR_CATALOG` 声明只读提供方。Web 服务在非云端的 `local-owner` 配置下创建驱动。聊天入口识别用户读请求，通用 HTTP 路由校验本机回环、账号上下文及跨站来源。目录摘要只看本地配置、已保存授权和资源数量。 | 游戏驱动同时接入目录、服务注册、读意图和连接卡。提供中英文示例、范围名称及稳定错误码。刷新目录不触发平台查询。“已授权”只说明有本地授权记录。公开目录或比价查询单独实现按需只读入口，避免为应用凭据伪造玩家账号。[目录][lisa-catalog] · [入口与续跑][lisa-server] · [HTTP 控制面][lisa-api] |
| `ReadonlyDriver<A,R>` 有 `authorize/account/resources/resource/read`。服务暂存凭据，确认时重新核对账号并解析每个资源。每个提供方只有一个当前连接，一次可确认 1–30 个资源。已有授权可用于后续的明确读请求。 | 将 `A` 绑定不可变平台用户 ID，将 `R` 绑定该账号下选定的游戏 ID。分页列举只在本机选取器显示最少字段。确认后驱动对模型输入再次校验，优先按获准 ID 向上游过滤。把“整个游戏库”另设为明确范围，首版先支持逐款选择。候选列表另设翻页预算，触顶时显示“结果不完整”。[驱动契约][lisa-types] · [授权生命周期][lisa-service] · [分页约定][lisa-pagination] |
| 授权状态存于 `connectors/<provider>/state.json`，包含原请求、账号及所选资源。目录和状态文件权限分别为 `0700`、`0600`。凭据另存 Warden `SecretStore`。断开先删除本地密钥和连接、取消未结束请求，再对支持的驱动尽力撤销上游。 | 密钥、下载权凭证、订单号、支付资料、好友清单及未选择的游戏不上送模型。用字段白名单构造响应，错误只给固定码。已完成请求仍可能保留账号或所选资源的副本。首版尽量仅持久化 ID。拟提供清理请求卡元数据的操作，并验证断开和清理各自的效果。[凭据接口][lisa-secrets] · [连接与断开][lisa-service] |
| `resumeConnector` 通过配置的模型继续原请求。它限制工具集合，将工具结果当作不可信数据，并写入会话的 `connector_trace` 和最终答复。现有 Forget 在 Connector 状态中匹配的是 `requests[].prompt`，已有账号及所选资源字段保留原样。会话中的匹配文本可通过预览后执行 Forget 处理。 | 在确认界面说明接收模型、发送哪些字段、哪些信息会进入历史。完整导出文件先在本机解析和预览。普通聊天附件会进入另一条数据流。验证断开、清除所选资源、遗忘聊天内容及外部模型留存各自的边界。Pocket 的 AI 分享许可按服务器、接收方和用途管理，不能替代本机 Connector 授权。[模型续跑][lisa-server] · [会话存储][lisa-sessions] · [Forget 实现][lisa-forget] · [隐私控制说明][lisa-sovereignty] · [Pocket 同意模型][lisa-pocket] |

游戏匹配应保留原始来源、来源游戏 ID 和版本。PS5/PS4 版、重制版、DLC 与本体可能同名。只有发行方外部 ID 或用户确认匹配时才合并。以商店或启动器记录为准注明“有领取记录”“曾玩过”“有成就进度”或“用户导入”。时长保留原单位，缺失值记为“未知”，跨启动器可能重叠的时段分来源展示。查价只发送用户选中的标题或公开商品 ID、明确的地区，不附玩家 ID 或完整库。

## 本机配置与验收状态

**0.33.0 的发布范围为已在本机验收的界面和文件导入。** itch.io、Steam、IGDB 和 IsThereAnyDeal 均默认关闭。要测试某项服务，需在主机上显式配置该服务的应用凭据并重启。真实账号和脱敏样本的验收列在下表，作为后续事项。

在 Mac 或自托管本机所有者的聊天中，从**总览 → 应用连接器**进入。搜索 PlayStation、Xbox、Nintendo 等平台时，可以找到游戏清单导入器。选中游戏后，界面会说明接收结果的聊天模型。断开游戏连接会删除本机授权、已保存的快照和请求卡上的游戏选择。发送过的聊天结果仍存于会话，清理方式见 [Forget 说明][lisa-sovereignty]。

| 入口 | 本机配置与使用 | 后续真实账号与样本验收 |
|---|---|---|
| Game Library · Playnite | 导入本机 CSV/TSV，或下载空白模板填写选定记录。只需标题，可选来源、平台、版本、来源 ID、秒数和导出时间。原始文件保留在浏览器中，两次确认分别控制本机快照和聊天读取。 | 已按导出器源码、脱敏模拟数据和浏览器文件选择流程验证。仍需核对玩家从 Windows 实际导出的多语言清单。 |
| itch.io | 为自己的桌面应用注册回环地址 `http://127.0.0.1/oauth/connector`。设置 `LISA_ITCH_CLIENT_ID` 后重启。仅请求 `profile:me`、`profile:owned`。授权入口可在[应用管理页](https://itch.io/user/settings/oauth-apps)创建。[注册与回调规范][itch-auth] | 已用模拟上游和真实回环监听器验证授权及断开。注册应用、玩家拒绝和上游撤销的真实验收待办。 |
| Steam | 由主机运营者设置自己登记的 `LISA_STEAM_WEB_API_KEY`。通过浏览器登录 Steam 后逐款选择。安装包不含共用密钥。运营者应在申请、配置和公布隐私说明时核对用途、存储国家、保存的数据及提供给模型的字段。[密钥][steam-key] · [条款][steam-terms] | 已用模拟上游核对身份和可见游戏字段。真实公开资料、私密游戏和隐藏时长账号，以及运营者的密钥部署说明待验。 |
| IGDB | 在运行服务的主机设置 Twitch 应用的 `LISA_IGDB_CLIENT_ID` 和 `LISA_IGDB_CLIENT_SECRET`。在目录内选择“查询游戏资料与价格”。公开查询仅使用输入的标题或 Steam AppID，结果保留 IGDB 署名和链接。 | 需要在已注册应用上验收真实请求。商业用途先向 IGDB 确认合作范围。[IGDB 商用条件][igdb] |
| IsThereAnyDeal | 设置 `LISA_ITAD_API_KEY`。搜索并选定版本，输入国家代码后查询报价。保留商店、原始链接和币种，历史面板显示近期可用记录。 | 需要真实应用密钥及地区价格验收。公开商用、个人私用、非个人私下使用的条件不同，非个人私下使用需获准。[接口][itad] · [应用条款][itad-terms] |

将以上变量设在启动 LISA 后端的环境中。Mac 应用也从本机 `~/.lisa/config.env` 读取配置。配置完成后重启 LISA。公开查询默认为未配置，目录浏览和手动文件导入无需任何平台密钥。

Epic、PlayStation、EA 和 Ubisoft 的账号原始导出需要脱敏样本才能确定字段。在已知的游戏行和列中选取数据，填入通用模板即可使用本地导入。Xbox 的 RETAIL 权限、Epic 的应用审核、Sony/Nintendo/GOG 的第三方用途及 Battle.net 的留存条件见上方矩阵。应用仅提供通过验证的文件入口和已配置的公开查询。生产账号验证时，记录日期、地区、授权范围、结果与失败情况，无需把玩家凭据写入仓库。

**本机候选验收（2026-11-22）。** 已在 Mac 上用同一 Developer ID 签名的 0.33.0 候选替换原应用，核对内置 CLI 版本、运行中后端的健康检查和 25 项 Connector 目录。未配置任何游戏服务凭据时，本机导入可用，Steam、itch.io 显示待配置，IGDB 与 IsThereAnyDeal 的状态均为未配置。Chromium 覆盖了挑选文件和字段、导入另一份清单以及断开清理；Mac 原生 WebView 验证了中英文模板的保存和取消。独立评审复核了模型和服务地址变更后重新授权、读取期间撤销，以及已选数据的本机存储位置。此项记录对应本机候选，表中列出的生产验收仍待实际账号和样本。

## 实施顺序与放行条件

| 顺序与首个问题 | 实现路径 | 放行所需证据 |
|---|---|---|
| 1 · itch.io，“我选的这些独立游戏有哪些？” | 注册桌面 OAuth 应用，复用回环监听、state 和 S256 PKCE。注册的 host 和 path 须匹配，端口可动态。用 `/credentials/info` 核对实际 scope，按已发布游戏的 `game_id` 去重，确认后用 `game_ids` 限制查询。token 不过期，同一账号再次授权可能累积 scope，应拒收越权 token 并提示撤销旧授权。 | 在一个自愿测试账号走通授权、拒绝、取消、断开和上游撤销。验证短页后仍有下一页、重复领取、空页、有礼包但没有单独领取记录。只让已选游戏的获准字段进入工具结果和会话。用原注册 client ID 验证撤销接口。说明同一应用共用 token 时对其他安装的影响。[授权及撤销][itch-auth] · [分页和过滤][itch-api] · [LISA 回环工具][lisa-loopback] |
| 2 · 本机导入，“把我的跨平台清单按来源整理” | 先支持 Playnite 可选字段 CSV，验证表头、编码、行数和文件上限。本机选文件、预览列和行，确认后才把选定字段交给模型。后续用真实且脱敏的 PlayStation Excel 和 Epic PDF 验证单独解析器。Nintendo 可先用玩家自选清单。 | Windows 导出的真实样本在 Mac 可读。多语言、重名、重复记录、无来源和无时长都有明确结果。权限只给选中文件或其确认快照。拒绝更换文件、未知结构和超限文件。首轮不需要平台凭据。[Playnite 导出扩展][playnite-export] · [本地资源绑定先例][lisa-obsidian] |
| 3 · Steam，“这几款我玩了多久、有哪些成就？” | 用 OpenID 2.0 校验服务端断言并绑定本人 SteamID，按声明用途单独管理 Web API key。OpenID 不返回供后续读库的玩家 bearer。现有回环授权码处理器不足以验签。先读可见条目，再按 AppID 限定已选游戏。对近期游玩等无法在上游限定的响应先在驱动内过滤。 | 证明登记应用和密钥部署符合条款。用公开、隐藏时长、私密单款、全库不可见和无成就游戏分别测试。拒绝冒用他人 SteamID、重放回调和跨账号选取。取消可见性后重新读取应尊重最新结果。[OpenID][steam-auth] · [可见游戏与 AppID 过滤][steam-player] · [Valve 条款][steam-terms] |
| 4 · 标题补全和按地区查价 | 分别做 IGDB 元数据查询与 IsThereAnyDeal 比价查询。先用已知外部 ID，只有候选标题时列出平台、版本和发行年份让用户选择。缓存公开信息时标明来源和采集时间。 | 商用合作、署名、缓存期限及数据交给模型的用途按各服务条款核对。实测同名不同版、无匹配、切换地区/币种、无报价、配额耗尽与 429。回复区分“有覆盖的商店中最低”及“历史价格记录”。能从结果追溯到原报价。[IGDB][igdb] · [ITAD][itad] |
| 5 · 平台限定的在线功能 | 有明确需求再验证 Xbox 已授权的资料/成就、Epic 账号功能或单款发行商接口。PSN、Nintendo 和 GOG 直连等待用途获准。Battle.net 等待可执行的数据留存方案。 | 对每个候选取得应用标识、准许的数据和使用场景，在非开发者测试账号或指定测试环境验证。涉及合作伙伴权限时同时取得生产范围或零售环境证据。开发者自己产品的成功响应仅支持该产品结论。 |

**共同验收。** 复用已有服务测试和端到端用例的结构，用模拟平台响应覆盖以下四条边界。真实账号联调另记日期、地区、授权范围、脱敏字段与失败情形。[服务测试][lisa-service-tests] · [本机与来源校验测试][lisa-api-tests] · [端到端先例][lisa-e2e]

1. 浏览目录不发平台请求。首次请求在用户确认前不将候选资源交给模型。非本机所有者、跨站请求和云端入口均无法启动个人库连接。
2. 确认 2 款游戏后，用模型请求第 3 款或另一个账号必须失败。改用昵称、拼接资源名、列表分页及重复确认均不能扩大范围。核对本机状态、会话跟踪和模型请求体中的字段。
3. 授权被撤销、网络超时、达到限额或只拿到部分结果时，保留可验证范围并注明缺口。上游未揭示是隐私设置还是空库时，返回“数据不可用”。有 `Retry-After` 时遵从其等待时间并保留取消能力。
4. 用户发新指令、读到一半断开或进程重启时，旧请求不得越过当前授权提交结果。恢复后同一请求最多出现一次最终答复。断开后确认新读被拒绝，逐项核查资源元数据和历史的清理结果。

[steam-auth]: https://partner.steamgames.com/doc/features/auth
[steam-store]: https://partner.steamgames.com/doc/webapi/IStoreService
[steam-player]: https://partner.steamgames.com/doc/webapi/IPlayerService
[steam-stats]: https://partner.steamgames.com/doc/webapi/ISteamUserStats
[steam-oauth]: https://partner.steamgames.com/doc/webapi_overview/oauth
[steam-key]: https://partner.steamgames.com/doc/webapi_overview/auth
[steam-private]: https://help.steampowered.com/en/faqs/view/1150-C06F-4D62-4966
[steam-terms]: https://steamcommunity.com/dev/apiterms
[epic-privacy]: https://dev.epicgames.com/docs/epic-online-services/accounts-and-social/eos-epic-account-services/eos-data-privacy-visibility?lang=en-US
[epic-review]: https://dev.epicgames.com/docs/epic-online-services/accounts-and-social/eos-epic-account-services/brand-review/brand-review-process?lang=en-US
[epic-ecom]: https://dev.epicgames.com/docs/epic-games-store/services/ecom/ecom-overview?lang=en-US
[epic-export]: https://www.epicgames.com/help/c-1/a19124322
[ps-privacy]: https://www.playstation.com/en-us/support/account/privacy-settings/
[ps-export]: https://www.playstation.com/en-gb/support/account/data-request/
[ps-partners]: https://sonyinteractive.com/en/news/blog/showing-your-game-to-playstation/
[xbox-auth]: https://learn.microsoft.com/en-us/gaming/gdk/docs/services/fundamentals/s2s-auth-calls/service-authentication/live-website-authentication?view=gdk-2604
[xbox-history]: https://learn.microsoft.com/en-us/xbox/gdk/docs/reference/live/rest/uri/titlehistory/uri-titlehistoryusersxuidhistorytitlesgetv2?view=gdk-2604
[xbox-config]: https://learn.microsoft.com/en-us/gaming/game-publishing/concepts/xbox-services
[ms-collections]: https://learn.microsoft.com/en-us/windows/uwp/monetize/query-for-products
[nintendo-play]: https://www.nintendo.com/en-gb/Support/Purchases-Subscriptions/Nintendo-Store-App-Overview-and-FAQ-2954197.html
[nintendo-orders]: https://www.nintendo.com/en-gb/Support/Troubleshooting/How-to-View-Nintendo-eShop-Purchase-History-on-Nintendo-Switch-2-or-Nintendo-Switch-1508501.html
[nintendo-process]: https://developer.nintendo.com/the-process
[nintendo-register]: https://developer.nintendo.com/register
[itch-api]: https://itch.io/docs/api/serverside
[itch-auth]: https://itch.io/docs/api/oauth
[gog-stats]: https://docs.gog.com/sdk-stats-and-achievements/
[gog-plugins]: https://github.com/gogcom/galaxy-integrations-python-api
[blizzard-api]: https://us.forums.blizzard.com/en/blizzard/t/world-of-warcraft-api-update-visions-of-nzoth/3461
[blizzard-terms]: https://www.blizzard.com/en-us/legal/a2989b50-5f16-43b1-abec-2ae17cc09dd6/blizzard-developer-api-terms-of-use
[tap-login]: https://developer.taptap.cn/docs/sdk/taptap-login/taptap-oauth/
[tap-pc]: https://developer.taptap.cn/docs/pc/cpp-sdk/overview/
[wegame]: https://developer.wegame.com/developer/static/faq_cn.html
[ea-data]: https://help.ea.com/en/articles/ea-account/access-your-ea-account-data/
[ubisoft-data]: https://www.ubisoft.com/legal/privacy/en-US
[igdb]: https://api-docs.igdb.com/
[itad]: https://docs.isthereanydeal.com/
[itad-terms]: https://github.com/IsThereAnyDeal/API/blob/master/TERMS_OF_SERVICE.md
[playnite]: https://playnite.link/
[playnite-game]: https://api.playnite.link/docs/api/Playnite.SDK.Models.Game.html
[playnite-export]: https://github.com/darklinkpower/PlayniteExtensionsCollection
[lisa-catalog]: ../src/connectors/catalog.ts
[lisa-server]: ../src/web/server.ts
[lisa-api]: ../src/web/connectors-api.ts
[lisa-types]: ../src/connectors/types.ts
[lisa-service]: ../src/connectors/service.ts
[lisa-pagination]: ../src/connectors/resource-pagination.ts
[lisa-secrets]: ../src/warden/secrets.ts
[lisa-sessions]: ../src/sessions/store.ts
[lisa-forget]: ../src/sovereignty/forget.ts
[lisa-sovereignty]: ./DESIGN_MEMORY_SOVEREIGNTY.md
[lisa-pocket]: ../packaging/ios-companion/Sources/AISharingConsent.swift
[lisa-loopback]: ../src/connectors/oauth-loopback.ts
[lisa-obsidian]: ../src/connectors/obsidian.ts
[lisa-service-tests]: ../src/connectors/service.test.ts
[lisa-api-tests]: ../src/web/connectors-api.test.ts
[lisa-e2e]: ../tests/e2e/documents-connectors.spec.ts
