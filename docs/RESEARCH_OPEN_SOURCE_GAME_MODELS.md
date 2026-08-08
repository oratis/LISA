# 开源「会玩游戏」的模型 — 综合调研报告

> 调研日期：2026-07-11 ｜ 范围：开源（代码/权重/数据可获取）且能"玩游戏"的模型、智能体与框架
> 说明：本报告由联网检索整理，重点覆盖 2022–2026 年的代表性工作。许可证与可用性以各仓库为准，商用前务必核对 LICENSE。

---

## TL;DR（快速结论）

"会玩游戏的模型"其实横跨 **6 种技术范式**，选型要先想清楚你要的是哪一种：

1. **通用视觉-动作基础模型**（真·可下载权重、看画面出操作）——最贴近"一个开源模型直接玩游戏"。代表：**NitroGen**（2025 末，1000+ 游戏，最接近"游戏界的 GPT"的开源尝试）、**VPT**（OpenAI，Minecraft）、**GROOT/ROCKET/STEVE-1**（CraftJarvis 系列）。
2. **LLM 驱动的游戏智能体**（用大模型做规划/推理，框架开源、底层可换开源 LLM）。代表：**Voyager**、**GITM**、**JARVIS-1**、**Optimus-3**、**Cradle**（玩 3A 游戏如荒野大镖客 2）、**PokéLLMon**、**Cicero**（外交游戏）。
3. **强化学习框架与样本高效智能体**（从零训练一个专精智能体）。代表：**CleanRL**、**Stable-Baselines3**、**DI-engine/DI-star**（星际争霸 2 宗师）、**PufferLib**（宝可梦红）、**DreamerV3**、**EfficientZero V2**。
4. **世界模型 / 神经游戏引擎**（模型直接"生成"可玩的游戏画面，无传统引擎）。代表：**Oasis**（实时生成 Minecraft）、**DIAMOND**（Atari/CS:GO 扩散世界模型）、**MineWorld**。
5. **棋类 / 完美信息博弈引擎**（超人水平、工业级）。代表：**KataGo**（围棋）、**Leela Chess Zero / Stockfish**（国际象棋）、**OpenSpiel**（通用博弈框架）。
6. **环境与评测基准**（不是模型，但是玩游戏模型的"训练场"和"考卷"）。代表：**MineDojo/MineRL**、**NetHack LE**、**Crafter/Craftax**、**ViZDoom**、**BALROG**、**Kaggle Game Arena**。

> **一句话选型**：想要"开箱即用、下载权重就能玩"→ 看范式 1（首推 NitroGen / VPT）；想用 LLM 做一个会玩游戏的 Agent → 看范式 2（首推 Cradle / Voyager）；想自己训一个专精某款游戏的强者 → 看范式 3；想做 AIGC 式"神经游戏"→ 看范式 4。

---

## 0. 先厘清一个关键区分

用户问"开源可以玩游戏的模型"，严格来说存在两层含义，报告中会分别标注：

- **🟢 开源权重模型**：模型参数本身开源可下载，输入游戏观测、输出动作。这是最狭义、最"硬核"的答案（如 NitroGen、VPT、DreamerV3 训练出的智能体、KataGo）。
- **🔵 开源智能体框架**：代码/流程开源，但"大脑"通常调用一个大模型（可以是闭源 API，也可以换成开源 LLM）。它们是"系统"而非"权重"（如 Voyager、Cradle、PokéLLMon）。

两者都能"玩游戏"，但可复现性、离线可用性、商用自由度差别很大，下文逐一注明。

---

## 1. 通用视觉-动作游戏基础模型（Generalist Vision-Action Models）

这一类是最接近"一个模型直接玩多种游戏"的形态：输入屏幕像素，输出手柄/键鼠动作，靠大规模游戏视频做行为克隆预训练。

| 模型 | 机构 | 时间 | 覆盖游戏 | 亮点 | 开源内容 |
|---|---|---|---|---|---|
| **NitroGen** 🟢 | NVIDIA + 斯坦福 + 加州理工 + 芝加哥大学 + UT Austin | 2025 末 | **1000+ 款**（动作 RPG/平台/动作冒险等） | 视觉→手柄动作的基础模型；500M 参数；flow-matching + GR00T 架构；40,000 小时游戏视频行为克隆 | **数据集 + 评测套件 + 权重**（HuggingFace）+ 代码（`MineDojo/NitroGen`） |
| **VPT (Video PreTraining)** 🟢 | OpenAI | 2022 | Minecraft | 70,000 小时网络视频 + 逆动力学模型（IDM）打标；纯视频半监督学"人类操作" | **代码 + 权重 + 承包商数据 + 环境**全开源 |
| **GROOT / GROOT-1** 🟢 | CraftJarvis | ICLR 2024 | Minecraft | 看游戏视频学"指令跟随"，encoder-decoder 结构，无需动作标注 | 代码 + 权重（`CraftJarvis/GROOT`） |
| **ROCKET-1 / ROCKET-2** 🟢 | CraftJarvis | CVPR 2025 | Minecraft | 视觉-时序上下文提示 + SAM-2 实时物体分割做底层策略 | 代码 + 多个权重变体（`CraftJarvis/ROCKET-1`） |
| **STEVE-1** 🟢 | 多伦多大学等 | 2023 | Minecraft | 文本/视觉指令→动作，类 unCLIP + VPT | 代码 + 权重 |
| **MineStudio** 🟢 | CraftJarvis | 2024–2025 | Minecraft | 一站式 Minecraft 智能体开发包，**预集成 VPT / STEVE-1 / GROOT / ROCKET** 权重 | 全套开源（`CraftJarvis/MineStudio`） |
| **OpenHA** 🟢 | CraftJarvis | 2025 | Minecraft | 开源的分层智能体模型系列（Hierarchical Agentic） | 代码 + 权重 |
| _(对比)_ **SIMA / SIMA 2** ⚫闭源 | Google DeepMind | 2024 / 2025.12 | 多款商业 3D 游戏 | 可跨游戏、听自然语言指令；SIMA 2 基于 Gemini、可自我改进 | **未开源**，仅论文/博客 |

**要点**
- **NitroGen 是目前最值得关注的"开源通用游戏智能体基础模型"**——它公开了数据、评测和权重三件套，定位就是"游戏界的通用视觉-动作基座"。如果你想要"下载一个权重、丢给它一款没见过的游戏"，这是当下最贴近的开源答案。
- **Minecraft 生态最成熟**：CraftJarvis（VPT/STEVE-1/GROOT/ROCKET/JARVIS/OpenHA）+ MineStudio 构成了从数据、预训练、微调到推理、评测的完整开源闭环，是想深耕的首选。
- **SIMA 系列虽强但闭源**，只能作为能力上限的参照。

---

## 2. LLM 驱动的游戏智能体（LLM-based Game Agents）

用大语言模型做"大脑"（规划、推理、写代码、用工具），框架开源，底层 LLM 可插拔（GPT/Claude/Gemini 或开源 Llama/Qwen 等）。

| 项目 | 机构 | 时间 | 游戏 | 亮点 | 开源 |
|---|---|---|---|---|---|
| **Voyager** 🔵 | NVIDIA / MineDojo | 2023 | Minecraft | 自动课程 + 可执行代码技能库 + 自我验证迭代；首个 LLM 终身学习体 | 框架开源（`MineDojo/Voyager`） |
| **GITM（Ghost in the Minecraft）** 🔵 | 上海 AI Lab（OpenGVLab） | 2023 | Minecraft | LLM + 文本知识/记忆；解锁主世界 100% 科技树，ObtainDiamond 成功率 67.5% | 代码开源（`OpenGVLab/GITM`） |
| **JARVIS-1** 🔵 | CraftJarvis | 2023 | Minecraft | 记忆增强的多模态语言模型，开放世界多任务 | 代码开源 |
| **Optimus-1 / 2 / 3** 🔵 | 中科大等 | 2024–2025 | Minecraft | 目标-观测-动作条件策略；**Optimus-3** 是集 Caption/QA/规划/动作/接地/反思于一体的通才 | 代码开源 |
| **Cradle** 🔵 | BAAI（智源）/ 昆仑万维 | 2024 | **商业 3A 游戏 + 桌面软件** | **通用计算机控制**：只靠截图 + 键鼠，无需游戏 API；首个在《荒野大镖客 2》完成 40 分钟主线任务，还能玩《都市天际线》《星露谷物语》等 | 代码开源（`BAAI-Agents/Cradle`） |
| **PokéLLMon** 🔵 | 佐治亚理工 | 2024 | 宝可梦对战 | 首个达到人类水平的 LLM 对战体；上下文强化学习 + 知识增强 + 一致性动作 | 代码开源 |
| **Cicero** 🔵 | Meta AI | 2022 | **Diplomacy（外交）** | 自然语言谈判 + 策略推理；40 局对人类得分 2×，进入前 10% | 代码开源（`facebookresearch/diplomacy_cicero`，注意使用条款） |
| **LLM Pokémon Scaffold** 🔵 | 社区（基于 Anthropic 起始代码） | 2025 | 宝可梦红（PyBoy 模拟器） | 即"Claude/Gemini Plays Pokémon"的开源脚手架；支持 Claude/Gemini/o3，含三段式 Meta-Critique 状态管理 | 代码开源（`cicero225/llm_pokemon_scaffold`） |

**要点**
- **Cradle 是"通用性"最强的一个**：它把游戏当作"一块屏幕 + 键鼠"，因此理论上能玩任何游戏和软件，不依赖游戏内 API——如果你要一个"什么都能上手"的 Agent，从这里看起。
- **这类项目本质是"编排框架"**：可复现性取决于你接的 LLM。想完全离线/开源，可把底层换成开源 LLM，但能力会随模型强弱明显波动。
- **Cicero 特别**：它是唯一在需要"语言谈判 + 背叛/结盟"的社交博弈里达到人类高水平的开源系统，价值独特（但其模型权重有使用限制，务必读许可条款）。

---

## 3. 强化学习框架与样本高效智能体（RL Frameworks & Agents）

从零（或少量数据）训练一个专精智能体。这里"模型"就是你训出来的策略网络；框架决定了你训得多快多好。

| 项目 | 机构 | 领域 | 亮点 | 许可证 |
|---|---|---|---|---|
| **CleanRL** 🟢 | 社区（vwxyzjn） | Atari 等通用 | 单文件、可读性极高的 RL 实现（PPO/DQN/SAC…），`ppo_atari.py` 仅 340 行 | MIT |
| **Stable-Baselines3** 🟢 | DLR（德国航天） | Atari 等通用 | 工业级可靠实现 + RL Baselines3 Zoo 预训练 Atari 智能体 | MIT |
| **DI-engine** 🟢 | 上海 AI Lab（OpenDILab） | 通用（号称最全） | Env/Policy/Model 模块化，异步原生；覆盖单/多智能体、MCTS、离线 RL | Apache-2.0 |
| **DI-star** 🟢 | OpenDILab | **星际争霸 2** | 大规模分布式训练 + **宗师级（Grand-master）智能体**；含预训练 SL/RL 权重（ZvZ）与训练代码 | Apache-2.0 |
| **Sample Factory** 🟢 | 社区 | Doom（ViZDoom）等 | 极高吞吐的异步 RL，适合大规模像素环境 | MIT |
| **PufferLib** 🟢 | 社区（PufferAI） | **宝可梦红**等 | 让各种 RL 库与环境"即插即用"；宝可梦红 RL 达 7000 步/秒（约 3000× 实时） | MIT |
| **DreamerV3** 🟢 | Danijar Hafner / DeepMind | 通用（150+ 任务） | **世界模型 RL 的标杆**：固定一套超参跨领域制胜；Minecraft 从零采到钻石；2025 年发表于 *Nature* | MIT |
| **EfficientZero V2** 🟢 | 上海交大等 | Atari 100k / 连续控制 | 样本效率 SOTA，约 2 小时游戏时间即超人；离散/连续、视觉/低维通吃，66 项里 50 项胜 DreamerV3 | 开源（见仓库） |
| **OpenSpiel / MiniZero** 🟢 | DeepMind / 社区 | 棋类 + Atari | AlphaZero/MuZero 的开源实现与对比框架 | Apache-2.0 |

**要点**
- 想"自己训一个玩某款游戏的强者"：通用入门用 **CleanRL / SB3**；要吞吐和规模用 **Sample Factory / PufferLib**；要世界模型/样本效率前沿用 **DreamerV3 / EfficientZero V2**；要复现《星际 2》这种即时战略巅峰用 **DI-star**。
- **DreamerV3 是这一类里"最通用的单一算法"**——一套超参打天下，是学术与工程都推荐的默认基线。

---

## 4. 世界模型 / 神经游戏引擎（World Models / Neural Game Engines）

这是新兴范式：模型不"玩"传统游戏，而是**直接生成可交互的游戏画面**——你按键，模型逐帧"想象"出下一帧。既能当训练用的"梦境模拟器"，也能当无引擎的"AI 游戏"。

| 项目 | 机构 | 时间 | 游戏 | 亮点 | 开源 |
|---|---|---|---|---|---|
| **Oasis / Oasis 2.0** 🟢 | Decart + Etched | 2024 / 2025.9 | Minecraft | 每一帧都由世界模型实时生成（20 FPS），完全无传统引擎；2.0 用动态加噪提升稳定性 | **权重开源** |
| **DIAMOND** 🟢 | Alonso 等 | NeurIPS 2024 Spotlight | Atari 100k + **CS:GO** | 扩散世界模型，视觉细节保真度高；智能体**在世界模型内部训练**；含 CS:GO 分支 | 代码 + 权重（`eloialonso/diamond`） |
| **MineWorld** 🟢 | 微软 | 2025 | Minecraft | 实时、开源的交互式 Minecraft 世界模型，主打可控性与泛化 | 代码开源 |
| **IRIS** 🟢 | 社区 | 2022 | Atari | 基于离散 token 的 Transformer 世界模型，样本高效经典 | 代码开源 |
| _(对比)_ **GameNGen** ⚫闭源 | Google Research | 2024 | DOOM | 单 TPU 实时生成 DOOM（20 FPS），神经引擎里程碑 | 未开源 |
| _(对比)_ **Genie 2 / 3** ⚫闭源 | Google DeepMind | 2024 / 2026.1 公开 | 通用 | 从文本/图片/草图生成可交互 3D 环境，30,000+ 小时训练 | 未开源 |

**要点**
- 想要"开源、可下载、能实时交互"的神经游戏引擎：**Oasis**（Minecraft）和 **DIAMOND**（Atari/CS:GO）是两个可直接上手的样板。
- 该范式与范式 3 天然互补：世界模型既是"可玩的游戏"，也是"让智能体在梦里练级"的模拟器（DIAMOND、DreamerV3 都属此思路）。

---

## 5. 棋类 / 完美信息博弈引擎（Board Game Engines）

工业级、超人水平、久经考验。要"最强且开源"，这一类最成熟。

| 引擎 | 游戏 | 亮点 | 许可证 |
|---|---|---|---|
| **KataGo** 🟢 | 围棋 | 当前**最强开源围棋引擎**（强于 Leela Zero）；不止胜率，还能估算领地/目数 | MIT |
| **Leela Zero** 🟢 | 围棋 | AlphaGo Zero 的开源复现；分布式训练已停，官方引导转向 KataGo | GPL-3.0 |
| **Leela Chess Zero (Lc0)** 🟢 | 国际象棋 | AlphaZero 路线的开源国象引擎，由 Leela Zero 改编而来 | GPL-3.0 |
| **Stockfish** 🟢 | 国际象棋 | 世界最强开源引擎，现已用 **NNUE 神经网络**做局面评估 | GPL-3.0 |
| **OpenSpiel** 🟢 | 通用博弈（含扑克/桥牌/西洋棋等） | DeepMind 的通用博弈研究框架：环境 + 算法（CFR、AlphaZero、MuZero…） | Apache-2.0 |

**要点**
- 完美信息博弈（围棋/国象）的开源方案**已经超越人类且高度成熟**，可直接用于对弈、分析、教学。
- 不完美信息博弈（扑克/桥牌/狼人杀）更难，开源侧主要靠 **OpenSpiel**（含 CFR 系列算法）；顶级德扑 AI（Libratus/Pluribus）**未开源**。

---

## 6. 环境与评测基准（Environments & Benchmarks）

这些**不是模型**，但是训练/评测"玩游戏模型"的基础设施，是任何相关工作都绕不开的一环。

**训练环境（Environments）**
- **Gymnasium**（Farama 基金会，OpenAI Gym 的官方继任者）+ **PettingZoo**（多智能体）——事实标准接口。
- **ALE（Atari）**——经典 57 游戏基准；**MineDojo / MineRL**——Minecraft 任务库。
- **NetHack Learning Environment (NLE) + MiniHack**——极难的 Roguelike，长期挑战。
- **Crafter / Craftax / Craftium**——轻量、开放式、可程序化生成的 2D 生存基准（Craftax 用 JAX，极快）。
- **ViZDoom**——第一人称视觉 Doom；**microRTS / Pommerman / Hanabi**——多智能体经典。

**评测基准（Benchmarks）**
- **BALROG**（ICLR 2025）——系统评测 LLM/VLM 在多款游戏上的**长程规划、空间推理、探索**能力；发现很多模型"给了画面反而更差"，暴露视觉决策短板。
- **SmartPlay / LMGame-Bench / GVGAI-LLM**——面向 LLM 决策与推理的游戏化评测集。
- **Kaggle Game Arena**（Google DeepMind + Kaggle，2025）——让顶尖大模型在**国际象棋、围棋、扑克、狼人杀**中捉对厮杀的擂台（截至最新一轮，Gemini 3 在象棋居首）；用于横评规划、协作、欺骗等能力。

---

## 7. 汇总对比（一张表看全景）

| 范式 | 首选开源项目 | 是否开源权重 | 离线可用 | 适合谁 |
|---|---|---|---|---|
| ① 通用视觉-动作基座 | **NitroGen**、VPT、CraftJarvis 系列 | ✅ | ✅ | 想"下载权重直接玩多款游戏" |
| ② LLM 游戏智能体 | **Cradle**、Voyager、GITM、PokéLLMon | ⚠️框架开源，脑子可换 | 取决于所接 LLM | 想用大模型做通用会玩游戏的 Agent |
| ③ RL 框架/智能体 | **DreamerV3**、CleanRL、DI-star、PufferLib | ✅（自训） | ✅ | 想自己训一个专精某游戏的强者 |
| ④ 世界模型/神经引擎 | **Oasis**、DIAMOND、MineWorld | ✅ | ✅ | 想做 AIGC 式"神经游戏"或梦境模拟器 |
| ⑤ 棋类博弈引擎 | **KataGo**、Stockfish、Lc0、OpenSpiel | ✅ | ✅ | 要超人水平、工业级、即插即用 |
| ⑥ 环境/评测 | Gymnasium、MineDojo、BALROG | — | ✅ | 训练场与考卷（配套基建） |

> ⚠️ **许可证提醒**：CleanRL/SB3/PufferLib/KataGo/Gymnasium 为 MIT；DI-engine/OpenSpiel 为 Apache-2.0；Stockfish/Lc0/Leela Zero 为 GPL-3.0（对衍生作品有传染性，商用注意）；多数研究型仓库（NitroGen/VPT/Voyager/Cradle/DIAMOND 等）许可各异，**商用前务必逐个核对 LICENSE 与模型权重条款**（Cicero 权重、部分数据集有额外使用限制）。

---

## 8. 选型建议（按你的目标对号入座）

- **"我要一个开源模型，下载下来就能玩游戏"** → **NitroGen**（多游戏通才）或 **VPT / CraftJarvis 系列**（专精 Minecraft，生态最全）。
- **"我要用 LLM 搭一个会玩游戏/操作软件的 Agent"** → **Cradle**（通用截图+键鼠，能玩 3A）或 **Voyager**（Minecraft，代码技能库范式优雅）。
- **"我要从零训练一个某款游戏的顶尖 AI"** → 通用起步 **CleanRL/SB3**；前沿/世界模型 **DreamerV3 / EfficientZero V2**；即时战略巅峰 **DI-star**。
- **"我要做 AI 生成的可玩游戏 / 训练用模拟世界"** → **Oasis**（Minecraft）、**DIAMOND**（Atari/CS:GO）。
- **"我要最强的棋类/对弈引擎"** → 围棋 **KataGo**，国际象棋 **Stockfish / Lc0**，通用博弈 **OpenSpiel**。
- **"我只是要评测大模型会不会玩游戏"** → **BALROG** + **Kaggle Game Arena**。

---

## 9. 对 LISA 的启示（可选延伸）

若考虑给 LISA 加"会玩游戏"的能力，与其现有架构（多 Provider LLM + MCP + 沙箱 bash + 子智能体 + GUI）最契合的是**范式 2（LLM 游戏智能体）**：

- **最低成本路线**：参考 **Cradle**（截图→键鼠）或 **LLM Pokémon Scaffold**（模拟器 + LLM + 状态记忆），把"玩游戏"实现为 LISA 的一个技能/子智能体，直接复用她已有的多 Provider LLM 与工具循环——不需要自己训练或托管模型权重。
- **若要离线/自主**：可在子智能体里接 **NitroGen / VPT 权重**做底层动作策略，用 LISA 的 LLM 做高层规划（分层：LLM 定目标、视觉-动作模型执行），这与 CraftJarvis「LLM 规划 + 底层策略」的思路一致。
- **趣味/人格向**：让游戏成为 REVE/Heartbeat 里"她自己想做的事"之一（她有 DESIRES），玩游戏的过程与心得写进她不给你看的日记——与 LISA 的产品叙事天然契合。

> 这一节仅为方向性建议，非承诺路线；如需落地可另开一份 `PLAN_*` 设计文档细化。

---

## 参考链接（Sources）

**通用视觉-动作基座**
- NitroGen — https://nitrogen.minedojo.org/ ｜ 代码 `MineDojo/NitroGen`
- VPT — https://openai.com/index/vpt/ ｜ https://github.com/openai/Video-Pre-Training
- CraftJarvis（GROOT/ROCKET/STEVE-1/MineStudio/OpenHA）— https://github.com/CraftJarvis ｜ https://github.com/CraftJarvis/MineStudio ｜ https://github.com/CraftJarvis/ROCKET-1
- SIMA 2（对比，闭源）— https://deepmind.google/blog/sima-2-an-agent-that-plays-reasons-and-learns-with-you-in-virtual-3d-worlds/

**LLM 游戏智能体**
- Voyager — https://github.com/MineDojo/Voyager ｜ https://voyager.minedojo.org/
- GITM — https://github.com/OpenGVLab/GITM
- JARVIS-1 — https://craftjarvis-jarvis1.github.io/
- Cradle — https://github.com/BAAI-Agents/Cradle ｜ https://baai-agents.github.io/Cradle/
- PokéLLMon — https://poke-llm-on.github.io/ ｜ https://arxiv.org/abs/2402.01118
- Cicero — https://github.com/facebookresearch/diplomacy_cicero ｜ https://ai.meta.com/research/cicero/diplomacy/
- LLM Pokémon Scaffold — https://github.com/cicero225/llm_pokemon_scaffold
- 综述：A Survey on LLM-Based Game Agents — https://github.com/git-disl/awesome-LLM-game-agent-papers ｜ https://arxiv.org/abs/2404.02039

**RL 框架与智能体**
- CleanRL — https://github.com/vwxyzjn/cleanrl
- Stable-Baselines3 — https://github.com/DLR-RM/stable-baselines3
- DI-engine — https://github.com/opendilab/DI-engine ｜ DI-star — https://github.com/opendilab/DI-star
- PufferLib — https://github.com/PufferAI/PufferLib ｜ 宝可梦红 RL — https://github.com/PWhiddy/PokemonRedExperiments
- DreamerV3 — https://github.com/danijar/dreamerv3 ｜ *Nature*(2025)
- EfficientZero V2 — https://github.com/Shengjiewang-Jason/EfficientZeroV2

**世界模型 / 神经游戏引擎**
- Oasis — https://oasis-model.github.io/ （Decart + Etched）
- DIAMOND — https://github.com/eloialonso/diamond ｜ https://diamond-wm.github.io/
- MineWorld — https://arxiv.org/html/2504.08388v1 （微软）

**棋类博弈引擎**
- KataGo — https://github.com/lightvector/KataGo
- Leela Chess Zero — https://lczero.org/
- Stockfish — https://stockfishchess.org/
- OpenSpiel — https://github.com/deepmind/open_spiel

**环境与评测**
- Gymnasium（Farama）— https://gymnasium.farama.org/
- MineDojo — https://minedojo.org/ ｜ NetHack LE / MiniHack — https://github.com/NetHack-LE/minihack
- Craftax — https://arxiv.org/abs/2402.16801 ｜ ViZDoom — https://vizdoom.cs.put.edu.pl/
- BALROG — https://balrogai.com/ ｜ https://arxiv.org/abs/2411.13543
- Kaggle Game Arena — https://www.kaggle.com/game-arena
