# NexusRouter 配置参考

NexusRouter 使用单一 YAML 配置文件（默认 `./config.yaml`），通过 Zod 在启动时校验。

## 目录

- [环境变量](#环境变量)
- [完整配置示例](#完整配置示例)
- [配置字段详解](#配置字段详解)
  - [router](#router)
  - [providers](#providers)
  - [tiers](#tiers)
  - [hints](#hints)
  - [ollama](#ollama)
- [认证方式](#认证方式)
- [常见问题](#常见问题)

---

## 环境变量

| 变量                | 默认值 | 说明                                |
| :------------------ | :----- | :---------------------------------- |
| `NEXUSROUTER_PORT`  | `8402` | 服务监听端口（`--port` 优先级更高） |
| `OPENAI_API_KEY`    | -      | OpenAI 协议 provider 的默认 key     |
| `ANTHROPIC_API_KEY` | -      | Anthropic 协议 provider 的默认 key  |
| `GOOGLE_API_KEY`    | -      | Google provider 的默认 key          |

所有 provider 的 `apiKey` 都可以在 YAML 中直接写 `${ENV_NAME}` 引用环境变量。

---

## 完整配置示例

```yaml
router:
  port: 8402
  classifier: hybrid # hybrid | heuristic
  timeout: 300000 # 上游超时（毫秒），生产必须显式设置
  layers:
    rules:
      enabled: true
    heuristic:
      confidenceThreshold: 0.92
    ai:
      fallbackConfidence: 0.75

providers:
  openai:
    apiKey: ${OPENAI_API_KEY}
    baseUrl: https://api.openai.com/v1
    maxRetries: 3
    passthroughApiKey: false

  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}
    baseUrl: https://api.anthropic.com
    maxRetries: 3
    passthroughApiKey: false

  # 对接 new-api 的示例（远程团队部署）
  newapi-openai:
    baseUrl: https://new-api.example.com/v1
    passthroughApiKey: true

  newapi-anthropic:
    baseUrl: https://new-api.example.com
    passthroughApiKey: true

tiers:
  SIMPLE:
    primary: openai/gpt-4o-mini
    fallback: []
  MEDIUM:
    primary: openai/gpt-4o
    fallback: []
  COMPLEX:
    primary: anthropic/claude-sonnet-4-5
    fallback: []
  REASONING:
    primary: openai/o3-mini
    fallback: []

hints:
  thinking: off # off | complex | reasoning

ollama:
  enabled: false
  baseUrl: http://localhost:11434
  models:
    fast: qwen2.5:3b
    accurate: qwen2.5:14b
  timeout: 30000
```

---

## 配置字段详解

### router

| 字段                                   | 类型    | 默认值     | 说明                                                         |
| :------------------------------------- | :------ | :--------- | :----------------------------------------------------------- |
| `port`                                 | number  | `8402`     | 监听端口                                                     |
| `classifier`                           | string  | `"hybrid"` | `"hybrid"`（三层）或 `"heuristic"`（仅启发式）               |
| `timeout`                              | number  | `1000`     | 上游请求超时（毫秒）。**真实 LLM 调用必须改大，建议 300000** |
| `layers.rules.enabled`                 | boolean | `true`     | 是否启用规则层                                               |
| `layers.heuristic.confidenceThreshold` | number  | `0.92`     | 启发式层直接判定阈值                                         |
| `layers.ai.fallbackConfidence`         | number  | `0.75`     | AI 层兜底置信度                                              |

### providers

`providers` 是一个键值对，键名自定义，在 `tiers` 中用 `"键名/模型"` 引用。

| 字段                | 类型    | 默认值             | 说明                                                      |
| :------------------ | :------ | :----------------- | :-------------------------------------------------------- |
| `apiKey`            | string  | `""`               | 上游密钥。支持 `${ENV}` / `${ENV:-default}` / `$ENV` 展开 |
| `baseUrl`           | string  | 按 provider 名默认 | 自定义上游地址，可指向 new-api / vLLM / LM Studio         |
| `maxRetries`        | number  | `3`                | 上游失败重试次数                                          |
| `passthroughApiKey` | boolean | `false`            | 是否透传客户端自带的 API key（见下文）                    |

provider 名对应的默认 `baseUrl`：

| provider 名 | 默认 baseUrl                                       |
| :---------- | :------------------------------------------------- |
| `openai`    | `https://api.openai.com/v1`                        |
| `anthropic` | `https://api.anthropic.com`                        |
| `google`    | `https://generativelanguage.googleapis.com/v1beta` |

### tiers

| 字段        | 类型   | 说明       |
| :---------- | :----- | :--------- |
| `SIMPLE`    | object | 简单请求   |
| `MEDIUM`    | object | 中等复杂度 |
| `COMPLEX`   | object | 复杂任务   |
| `REASONING` | object | 推理任务   |

每个 tier：

```yaml
TIER_NAME:
  primary: provider/model
  fallback: []
```

> 当前主链路暂未使用 `fallback` 列表，配置了也不会自动切换。上游故障转移建议依赖 new-api 的渠道能力。

### hints

用于控制 Agent 透传的 hint 对 tier 的影响。

| 字段       | 类型   | 默认值  | 说明                                                                               |
| :--------- | :----- | :------ | :--------------------------------------------------------------------------------- |
| `thinking` | string | `"off"` | `"off"` 忽略 thinking 标志；`"complex"` 至少 COMPLEX；`"reasoning"` 至少 REASONING |

> Claude Code 在 `CLAUDE_CODE_EFFORT_LEVEL=max` 等全局配置下会为每个请求附加 `thinking`，默认 `"off"` 可避免该信号过度拉高 tier。

### ollama

| 字段              | 类型    | 默认值                   | 说明                      |
| :---------------- | :------ | :----------------------- | :------------------------ |
| `enabled`         | boolean | `false`                  | 是否启用 Ollama AI 分类层 |
| `baseUrl`         | string  | `http://localhost:11434` | Ollama 服务地址           |
| `models.fast`     | string  | `qwen2.5:3b`             | 快速分类模型              |
| `models.accurate` | string  | `qwen2.5:14b`            | 高精度分类模型            |
| `timeout`         | number  | `30000`                  | Ollama 调用超时           |

> 如果服务器没有运行 Ollama，请务必保持 `enabled: false`，否则每个请求都会等待连接失败后降级，造成明显延迟。

---

## 认证方式

### 本地模式（NexusRouter 托管 key）

```yaml
providers:
  openai:
    apiKey: ${OPENAI_API_KEY}
```

客户端请求里的 key 不会被使用；NexusRouter 用配置里的 key 访问上游。

### 远程 passthrough 模式（new-api）

```yaml
providers:
  newapi-openai:
    baseUrl: https://new-api.example.com/v1
    passthroughApiKey: true
```

- OpenAI 协议客户端带 `Authorization: Bearer sk-xxx`，NexusRouter 原样转发
- Anthropic 协议客户端带 `x-api-key: sk-xxx`，NexusRouter 原样转发
- 用户没带 key → NexusRouter 直接返回 401，不会到达 new-api
- 上游 `baseUrl` 由服务端钉死，用户 key 不可能被转发到其他地方

> **硬性要求：用户到 NexusRouter 之间必须走 HTTPS。** passthrough 模式下链路上跑的是真实令牌，裸 HTTP 等于广播。

---

## 常见问题

**Q: 启动报 `Environment variable OPENAI_API_KEY is not set`**
配置里写了 `${OPENAI_API_KEY}` 但环境里没有。要么 `export`，要么改用 `${OPENAI_API_KEY:-默认值}`。

**Q: 所有请求都报 `Upstream timed out after 1000ms`**
没设置 `router.timeout`，schema 默认 1000ms。在 `config.yaml` 里加 `timeout: 300000`。

**Q: 每个请求都慢几秒才响应**
大概率是 `ollama.enabled: true` 但本机没跑 Ollama，分类器在等连接失败后降级。关掉它或启动 Ollama。

**Q: 上游 404，模型不存在**
`tiers` 里的模型名和上游平台（尤其 new-api）里的名字不一致。转发时 `provider/` 前缀会被剥掉，上游收到的是 `/` 后面的部分，按那个核对。

**Q: passthrough 模式返回 401 `API key required`**
客户端没带 key。Claude Code 检查 `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`，OpenAI 客户端检查 API Key 配置项。
