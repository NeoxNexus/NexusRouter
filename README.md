<div align="center">
  <img src="https://avatars.githubusercontent.com/u/258567441?v=4" alt="NeoxNexus Logo" width="300"/>
</div>


<h1 align="center">🕹️ NexusRouter</h1>

<p align="center">
  <strong>—— 为 <a href="https://github.com/anthropics/claude-code">Claude Code</a> 与 <a href="https://github.com/BlockRunAI/OpenClaw">OpenClaw</a> 量身打造的极速本地路由"外挂" ——</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/STYLE-8--BIT-ff69b4?style=for-the-badge" alt="8-bit Style">
  <img src="https://img.shields.io/badge/COST_SAVED-92%25-00ff00?style=for-the-badge" alt="Cost">
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TYPESCRIPT-5.7-3178c6?style=for-the-badge&logo=typescript" alt="TypeScript"></a>
</p>

<br>

> 👾 **警告：你的 API 账单正在被吞噬！** 
> 
> 当你挂机使用 **Claude Code** 或 **OpenClaw** 这类全自动 Agent 时，它们每分钟都在后台狂刷无数的"微型 Prompt"（查询目录、确认系统状态、解析简单错误）。如果每一次微小的系统试探都去调用顶配的 `Claude Opus 4.6` 或 `GPT-5.4`，你的 Token 费用会以肉眼可见的速度蒸发。💸
>
> ⚡️ **装上 NexusRouter 吧！** 它像是一个极其聪明的"网络守门员"，在本地基于 15 个维度的启发式算法，瞬间鉴别传入 Prompt 的真实难度，将简单闲杂的请求转投给廉价模型（如 `gpt-4o-mini` 或 `gemini-flash`），仅仅在真正的代码架构推理时，才唤醒最强旗舰模型。

---

## 🎮 玩家指南：核心属性

| 技能点 | NexusRouter | 传统路由方案 |
|:---|:---|:---|
| 🏎️ **判定毫秒差** | **<1ms**（纯本地内存判定，无前摇） | ~100ms - 3s (需调用云端 Embedding) |
| 🪜 **路由阶梯** | **四级跳**（简单杂鱼 → 普通怪 → 精英怪 → 终极Boss） | 多数只有两级 (Simple/Complex) |
| 💸 **蓝耗(分析成本)**| **0 MP**（绝对免费的离线漏斗） | 需花费 Token 用于重写或嵌入手册 |
| 🌍 **国际语言支持** | **全服务器 9 语系精讲**（中英日韩等） | 通常偏科英文 |
| 🕹️ **被动技能** | **Agentic 连击识别** (自动察觉多步动作) | 无状态 |

---

## � 联机模式：无缝接入热门 Agent

NexusRouter 完全模拟标准的 `OpenAI Completions API`，即插即用，不用修改任何 Agent 源码！

### 🤖 接入 Claude Code
由于 Claude Code 经常发狂似地列举文件结构，设置 `baseURL` 到路由器，把简单分析分流至成本为原来的 1/100 的模型：
```bash
# 修改你的客户端配置或环境变量
export ANTHROPIC_BASE_URL="http://127.0.0.1:8402/v1"
```

### 🦀 接入 OpenClaw & Cursor
在设置面板的 API 配置处：
1. **Base URL**: `http://127.0.0.1:8402/v1`
2. **Model**: 锁定为 `auto`
3. **API Key**: 随便填一个字符串（NexusRouter 在本地配置中托管你的真实 Keys！）

---

## 🗺️ 隐秘地图：三层路由网络

```text
                     [ 🚀 NexusRouter 分发控制台 ]
                    =============================
[玩家 API 请求] 
       │      ┌──────────────────────────────────────────────┐
       └────▶ │ 🛡️ L0: 静态魔法防御     (<0.1ms 瞬发)        │ ──▶ [Tier 1] 杂鱼清理 (GPT-mini 等)
              │ ⚔️ L1: 15维特征附魔      (0.5-1ms 施法)      │ ──▶ [Tier 2] 常规输出 (Claude Haiku)
              │ 🔮 L2: Ollama 先知预判   (5-8ms 召唤)        │ ──▶ [Tier 3] 精英攻坚 (Claude Sonnet 4.6)
              └──────────────────────────────────────────────┘ ──▶ [Tier 4] 终极神兵 (Claude Opus 4.6 / GPT-5.4)
```

**战术核心：** 高达 90% 的自动化请求会在 `L1` 阶段即被粉碎并低成本执行，保证开发者在享受极致自动化的同时，无惧高昂成本！

---

## � 游戏载入 (快速运行)

### 1. 插入卡带 (全局安装)

```bash
npm install -g nexusrouter
```

### 2. 存档配置 (`config.yaml`)

在你喜欢的本地路径创建一个配置文件：

```yaml
router:
  port: 8402
  classifier: hybrid     # 选用三层混合核心

providers:
  openai:
    apiKey: ${OPENAI_API_KEY}
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}

tiers:
  SIMPLE:
    primary: openai/gpt-4o-mini
  MEDIUM:
    primary: openai/gpt-5.4
  COMPLEX:
    primary: anthropic/claude-opus-4.6
  REASONING:
    primary: openai/o3
```

### 3. 开始游戏

```bash
nexusrouter --config ./config.yaml
```

然后，只需让你的 AI 代理往 `localhost:8402` 用 `model: "auto"` 开火即可。

---

## 📊 角色面板 (15维雷达评分)

这不是简单的字数阈值，NexusRouter 通过强大的规则检测引擎从 15 个维度对你的指令进行"体检"：

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
11. 📝 Json/Xml 正则输出约束 
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
