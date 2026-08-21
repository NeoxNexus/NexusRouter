# NexusRouter 架构

NexusRouter 是一个处于 Agent 与上游模型之间的**智能路由代理层**。它在本地对请求进行复杂度分类，然后在 <1ms 内决定应该把请求转发给哪个档位的模型。

## 目录

- [系统概览](#系统概览)
- [请求流水线](#请求流水线)
- [分类器](#分类器)
- [协议适配层](#协议适配层)
- [Agent 画像](#agent-画像)
- [Provider 转发](#provider-转发)
- [部署形态](#部署形态)
- [源码结构](#源码结构)

---

## 系统概览

```text
┌─────────────────────────────────────────────────────────────────────┐
│                        Agent 客户端                                  │
│   Claude Code / Cursor / OpenClaw / 任意 OpenAI-Compatible 客户端   │
└─────────────────────────────────────────────────────────────────────┘
                               │
                               ▼  HTTPS / HTTP
┌─────────────────────────────────────────────────────────────────────┐
│                        NexusRouter                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────────────┐   │
│  │ Protocol     │  │ AgentProfile │  │ HybridClassifier        │   │
│  │ Adapter      │→ │ (hints /     │→ │ 规则层 → 启发式层 → AI层 │   │
│  │ (OpenAI/     │  │  weights)    │  │ → Tier 决策              │   │
│  │  Anthropic)  │  │              │  │                         │   │
│  └──────────────┘  └──────────────┘  └─────────────────────────┘   │
│                               │                                     │
│                               ▼                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ ProviderForwarder → 按 config.tiers 选择模型并转发上游        │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│           上游模型 / 网关 / new-api                                  │
│   OpenAI / Anthropic / Google / DeepSeek / 本地 vLLM / new-api       │
└─────────────────────────────────────────────────────────────────────┘
```

**核心原则：**

- **纯本地分类** — 路由决策不调用任何外部 API，零额外 token 成本
- **协议透明** — 对客户端保持 OpenAI / Anthropic 原生协议
- **按复杂度选档** — 简单请求交给高效轻量模型，复杂推理自动升级到旗舰模型
- **可插拔画像** — 不同 Agent 可拥有不同的加权策略

---

## 请求流水线

### 1. 接收请求

```text
POST /v1/chat/completions        # OpenAI 协议
POST /anthropic/v1/messages      # Anthropic 协议（Claude Code 用 /anthropic）
```

`model` 字段为 `auto` 时触发自动路由；填 `provider/model` 时跳过分类直接转发。

### 2. 协议归一化

`ProtocolAdapter` 把 OpenAI / Anthropic 请求统一成 `UnifiedRequest`：

- 提取最后一条 user 消息作为分类输入
- 提取 `tools`、`stream`、`max_tokens` 等元信息
- 识别请求来源的 Agent 类型

### 3. Agent 画像加权

`AgentProfile` 根据入口路径或特征识别 Agent：

| Agent         | 行为特征                       | 默认权重倾向                               |
| :------------ | :----------------------------- | :----------------------------------------- |
| `claude-code` | 大量后台系统消息、工具调用频繁 | 压低 SIMPLE 阈值，避免把闲聊误判为复杂任务 |
| `openclaw`    | 标准 OpenAI 协议客户端         | 100% 信任分类器                            |
| `cursor`      | OpenAI 协议，上下文较长        | 框架已注册，画像待完善                     |

### 4. 三层分类器

```text
[请求] → L0 规则层 (<0.1ms) → 命中则直接返回 Tier
       → L1 启发式层 (~1ms)   → 15 维评分 + 置信度
       → L2 Ollama AI 层      → 本地 LLM 兜底（可选）
```

分类结果：

```text
{
  tier: "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING",
  layer: "rule" | "heuristic" | "ai" | "fallback",
  confidence: 0..1,
  agent: "claude-code" | "openclaw" | ...
}
```

### 5. Provider 转发

按 `config.tiers[tier].primary` 选择模型，去掉 `provider/` 前缀后转发到对应 provider：

- OpenAI 协议 provider：带 `Authorization: Bearer <apiKey>`
- Anthropic 协议 provider：带 `x-api-key: <apiKey>`
- `passthroughApiKey: true` 时，使用客户端自带的 key

---

## 分类器

### 15 维启发式评分

分类器从以下维度评估请求复杂度：

1. 总 Token 规模
2. 代码块 / 技术关键词
3. 逻辑推理诉求
4. 底层技术浓度
5. 创造发散度
6. 闲聊与简单问询
7. 多步协作关联
8. 语法分支复杂度
9. 绝对命令强度
10. 返回值强约束
11. JSON/XML/正则输出约束
12. 资料引用广度
13. 否定与对抗逻辑
14. 特定工业词频
15. Agentic 意图雷达

### Tier 判定

| Tier      | 典型特征                         | 示例                |
| :-------- | :------------------------------- | :------------------ |
| SIMPLE    | 问候、列文件、状态确认、简单翻译 | "hi" / "ls 一下"    |
| MEDIUM    | 单文件代码补全、解释、普通对话   | "解释这段代码"      |
| COMPLEX   | 多文件重构、架构设计、复杂 debug | "重构这个模块"      |
| REASONING | 数学证明、逻辑推导、多步规划     | "证明 sqrt(2) 无理" |

---

## 协议适配层

NexusRouter 同时暴露两种协议端点：

| 协议          | 路径           | 用途                         |
| :------------ | :------------- | :--------------------------- |
| Anthropic     | `/anthropic`   | Claude Code                  |
| OpenAI        | `/v1`          | Cursor、OpenClaw、通用客户端 |
| OpenClaw 兼容 | `/openclaw/v1` | 旧版 OpenClaw                |

同协议请求在转发时尽量保持原始 body，减少序列化开销。

---

## Agent 画像

`AgentProfile` 是一种插件化扩展点。每个画像可以：

- 从请求中提取 hints（如 `thinking` 标志）
- 根据画像特点调整分类器权重
- 对最终 tier 做上下限约束

当前内置画像：

- `claude-code`
- `openclaw`
- `cursor`（框架占位）

新增画像只需实现 `AgentProfile` 接口并注册到 `src/adapter/profile.ts`。

---

## Provider 转发

Provider 配置示例：

```yaml
providers:
  openai:
    apiKey: ${OPENAI_API_KEY}
    baseUrl: https://api.openai.com/v1
    maxRetries: 3
    passthroughApiKey: false

  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}
    baseUrl: https://api.anthropic.com
    passthroughApiKey: false
```

转发时：

- `openai/gpt-4o` → 发给 `openai` provider，模型名保留 `gpt-4o`
- `anthropic/claude-sonnet-4-5` → 发给 `anthropic` provider，模型名保留 `claude-sonnet-4-5`

---

## 部署形态

### 本地单人模式

```text
[Agent] → http://127.0.0.1:8402/...
```

API key 由 NexusRouter 本地 `config.yaml` 管理。

### 远程团队模式（推荐）

```text
[成员 Agent] ──自己的 sk──▶ [nginx :443] ──▶ [NexusRouter :8402] ──透传 sk──▶ [new-api] ──▶ [上游]
```

- 每个成员使用自己的 new-api 令牌
- NexusRouter 只负责分类和选档
- new-api 负责认证、配额、计费、渠道管理

完整方案见 [`deploy/new-api/README.md`](../deploy/new-api/README.md)。

---

## 源码结构

```text
src/
├── server.ts              # Fastify HTTP 服务器、请求流水线
├── cli.ts                 # 命令行入口
├── config/
│   ├── schema.ts          # Zod 配置校验
│   └── loader.ts          # YAML 加载与环境变量展开
├── adapter/
│   ├── adapter.ts         # ProtocolAdapter 策略工厂
│   ├── anthropic.ts       # Anthropic 协议适配
│   ├── openai.ts          # OpenAI 协议适配
│   ├── profile.ts         # AgentProfile 注册表
│   └── types.ts           # 统一请求/响应类型
├── classifier/
│   ├── hybrid.ts          # 三层分类器入口
│   ├── rules.ts           # 规则层
│   └── ...                # 启发式 / AI 层
├── router/
│   ├── selector.ts        # Tier → 模型选择
│   ├── tool-intent.ts     # 工具调用意图识别
│   └── config.ts          # 默认路由配置
├── models.ts              # 模型元数据注册表
├── errors.ts              # 错误类型
├── logger.ts              # 日志
└── ...                    # 其他能力模块
```

### 关键文件

| 文件                       | 职责                                 |
| :------------------------- | :----------------------------------- |
| `src/server.ts`            | 请求流水线编排、响应头注入、错误处理 |
| `src/adapter/adapter.ts`   | 协议检测与 Adapter 分发              |
| `src/adapter/profile.ts`   | Agent 画像注册与加权融合             |
| `src/classifier/hybrid.ts` | 三层分类器                           |
| `src/router/selector.ts`   | 按 tier 选择模型                     |
| `src/models.ts`            | 模型注册表与能力信息                 |
