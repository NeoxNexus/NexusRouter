<div align="center">
  <img src="https://avatars.githubusercontent.com/u/258567441?v=4" alt="NexusRouter Logo" width="300"/>
</div>

<h1 align="center">🕹️ NexusRouter</h1>

<p align="center">
  <strong>—— 为 <a href="https://github.com/anthropics/claude-code">Claude Code</a>、<a href="https://www.cursor.com/">Cursor</a> 及任何 OpenAI/Anthropic 兼容 Agent 打造的极速智能路由层 ——</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/STYLE-8--BIT-ff69b4?style=for-the-badge" alt="8-bit Style">
  <img src="https://img.shields.io/badge/ROUTING-<1ms-00ff00?style=for-the-badge" alt="Latency">
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TYPESCRIPT-5.7-3178c6?style=for-the-badge&logo=typescript" alt="TypeScript"></a>
</p>

<br>

> 👾 **每个请求都值得被认真对待。**
>
> 当你使用 **Claude Code**、**Cursor** 等全自动 Agent 时，它们每分钟都在后台产生大量背景请求：查询目录、确认状态、解析简单错误、构思复杂架构。这些请求的复杂度天差地别，却常常被无差别地丢给同一个顶配模型。
>
> ⚡️ **装上 NexusRouter 吧！** 它像是一位经验丰富的"模型调度员"，在本地基于 15 个维度的启发式算法，瞬间判断每个 Prompt 的真实复杂度，把简单的背景请求交给轻量高效的模型，把真正的架构推理、数学证明和复杂设计留给旗舰模型。让每个请求都**恰到好处**地落在合适的模型上。

---

## 🎮 玩家指南：核心属性

| 技能点            | NexusRouter                                         | 传统路由方案                       |
| :---------------- | :-------------------------------------------------- | :--------------------------------- |
| 🏎️ **判定毫秒差** | **<1ms**（纯本地内存判定，无前摇）                  | ~100ms - 3s (需调用云端 Embedding) |
| 🪜 **路由阶梯**   | **四级跳**（SIMPLE → MEDIUM → COMPLEX → REASONING） | 多数只有两级 (Simple/Complex)      |
| 🧠 **匹配精度**   | **15 维本地评估**，零额外 token 开销                | 云端重写或嵌入，增加调用成本       |
| 🌍 **协议兼容**   | **OpenAI + Anthropic 双协议**                       | 通常只支持一种                     |
| 🕹️ **被动技能**   | **Agent Profile 插件**（按不同 Agent 动态加权）     | 无状态                             |

---

## 🌐 联机模式：无缝接入热门 Agent

NexusRouter 同时支持标准 `OpenAI Completions API` 与 `Anthropic Messages API`，即插即用，无需修改 Agent 源码。

### 🤖 接入 Claude Code

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8402/anthropic"
export ANTHROPIC_AUTH_TOKEN="sk-你的-api-key"
```

> 远程部署时，把 `http://127.0.0.1:8402/anthropic` 换成你的 HTTPS 域名，例如 `https://nexusrouter.example.com/anthropic`。

### 🦀 接入 Cursor / OpenClaw / 其他 OpenAI 客户端

| 配置项   | 值                                                                                      |
| :------- | :-------------------------------------------------------------------------------------- |
| Base URL | `http://127.0.0.1:8402/v1`（本地）或 `https://nexusrouter.example.com/v1`（远程）       |
| Model    | `auto`                                                                                  |
| API Key  | 本地模式填 `config.yaml` 中 provider 的 key；远程 new-api 模式填用户自己的 new-api 令牌 |

---

## 🚀 生产部署：nginx + NexusRouter + new-api（推荐）

对于团队或远程服务器，我们推荐把 NexusRouter 部署在 **new-api** 前面，使用 **passthrough API Key** 模式：

```text
[成员 Agent] ──自己的 sk──▶ [nginx :443 TLS] ──▶ [NexusRouter :8402] ──透传 sk──▶ [new-api] ──▶ [上游模型]
```

- **NexusRouter**：只负责按复杂度选 Tier
- **new-api**：负责模型管理、认证、配额、计费
- **nginx**：TLS 终止、限流、证书管理
- **passthroughApiKey**：每个成员使用自己的 new-api 令牌，按个人配额计费

完整部署方案与配置文件见 [`deploy/new-api/`](./deploy/new-api/)。

```bash
cd deploy/new-api
# 修改 config.yaml、docker-compose.yml、nginx.conf 中的域名与证书
vim config.yaml docker-compose.yml nginx.conf
docker compose up -d --build
```

---

## 🗺️ 隐秘地图：三层路由网络

```text
                     [ 🚀 NexusRouter 分发控制台 ]
                    =============================
[玩家 API 请求]
       │      ┌──────────────────────────────────────────────┐
       └────▶ │ 🛡️ L0: 规则层              (<0.1ms 瞬发)     │ ──▶ [Tier 1] SIMPLE   (gpt-4o-mini 等)
              │ ⚔️ L1: 15维启发式评分       (0.5-1ms 施法)   │ ──▶ [Tier 2] MEDIUM   (gpt-4o 等)
              │ 🔮 L2: Ollama 本地 LLM     (5-8ms 召唤)     │ ──▶ [Tier 3] COMPLEX  (Claude Sonnet 等)
              └──────────────────────────────────────────────┘ ──▶ [Tier 4] REASONING (o3-mini 等)
```

**战术核心：** 高达 90% 的自动化请求会在 `L1` 阶段被精准识别并匹配到合适的轻量模型，而真正的复杂推理则会自动升级到最强旗舰。避免"大材小用"，也避免"小马拉大车"。

---

## 📀 游戏载入 (快速运行)

### 1. 插入卡带 (全局安装)

```bash
npm install -g nexusrouter
```

### 2. 存档配置 (`config.yaml`)

首次运行 `nexusrouter` 会自动在用户主目录下创建默认配置（跨平台）：

- macOS / Linux：`~/.nexus-router/config.yaml`
- Windows：`%USERPROFILE%\.nexus-router\config.yaml`

打开该文件填入你的 API Key（或设置对应环境变量）即可。默认模板节选：

```yaml
router:
  port: 8402
  classifier: hybrid # 选用三层混合核心
  timeout: 300000 # 真实 LLM 调用建议 300s

providers:
  openai:
    apiKey: ${OPENAI_API_KEY}
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}

tiers:
  SIMPLE:
    primary: openai/gpt-4o-mini
  MEDIUM:
    primary: openai/gpt-4o
  COMPLEX:
    primary: anthropic/claude-sonnet-4-5
  REASONING:
    primary: openai/o3-mini
```

### 3. 开始游戏

```bash
# 使用默认配置（~/.nexus-router/config.yaml，首启自动创建）
nexusrouter

# 或显式指定其它配置文件
nexusrouter --config ./config.yaml
```

然后，让你的 Agent 往 `localhost:8402` 用 `model: "auto"` 发送请求即可。

---

## 📊 角色面板 (15维雷达评分)

NexusRouter 通过规则检测引擎从 15 个维度对指令进行"体检"：

1. 👾 总 Token 规模
2. 💻 代码强相关性
3. 🤔 逻辑推理诉求
4. ⚙️ 底层技术浓度
5. 🎨 创造发散度
6. 🐟 闲聊与简单问询
7. 🔄 **多步协作关联**
8. 🧩 语法分支复杂度
9. 🕹️ **绝对命令强度**
10. 🚧 返回值强约束
11. 📝 JSON/XML/正则输出约束
12. 📚 资料引用广度
13. 🚫 否定与对抗逻辑
14. 🏭 特定工业词频
15. 🤖 **Agentic 意图雷达**

---

<p align="center">
  <small>
  <i>"Don't waste a wizard's mana on lighting a candle."</i><br><br>
  Released under the <a href="LICENSE">MIT License</a>. <br>
  Engineered by passionate nerds for the modern AI hacking era.
  </small>
</p>
