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
  - [aiClassifier](#aiclassifier)
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
    fast: qwen3:4b
    accurate: qwen3:8b
  timeout: 800
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
| `models.fast`     | string  | `qwen3:4b`               | 快速分类模型（需先 `ollama pull`） |
| `models.accurate` | string  | `qwen3:8b`               | 高精度分类模型                     |
| `timeout`         | number  | `800`                    | Ollama 调用超时（毫秒），到点即降级兜底 |

> `enabled: false` 时分类器整块跳过 Ollama 层（Layer 2），不会向 `baseUrl` 发任何请求。`enabled: true` 而 Ollama 不可达时，每个低置信请求最多等 `timeout` 即降级兜底。

### aiClassifier

Layer 2 分类的另一种后端：OpenAI 兼容协议（`/chat/completions`），可对接 new-api 网关或 vLLM 私有部署，替代本地 Ollama。**配置了 `provider: openai-compat` 即视为启用，不看 `ollama.enabled`**（它只管 ollama 路径）；`baseUrl`/`model` 缺失则启动时告警并回退 ollama 路径。

| 字段       | 类型   | 默认值     | 说明                                                         |
| :--------- | :----- | :--------- | :----------------------------------------------------------- |
| `provider` | string | `"ollama"` | `"ollama"`（本地）或 `"openai-compat"`（OpenAI 兼容网关）    |
| `baseUrl`  | string | -          | 网关地址，**需含 `/v1`**；openai-compat 时必填               |
| `apiKey`   | string | `""`       | 网关令牌，支持 `${ENV}` 展开；留空则不携带鉴权头（内网网关） |
| `model`    | string | -          | 网关上的模型名（不带 `provider/` 前缀）；openai-compat 时必填 |
| `timeout`  | number | `800`      | 分类调用超时（毫秒），到点即降级兜底                         |

new-api 示例（用网关上的便宜模型做分类）：

```yaml
aiClassifier:
  provider: openai-compat
  baseUrl: https://new-api.example.com/v1
  apiKey: ${NEW_API_KEY}
  model: gpt-4o-mini
  timeout: 800
```

> 模型省略 `confidence` 时按 0.8 采纳，默认阈值 0.75 下必过；如需更保守可在提示词或阈值上调整。避免使用 reasoning/思维链模型——分类请求 `max_tokens` 只有 50，会被 CoT 输出吃光。

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
大概率是 `ollama.enabled: true` 但本机没跑 Ollama：Layer 2 每次请求都要等连接失败，直到 `ollama.timeout`（默认 800ms，若被调大会更慢）后降级。`enabled: false` 时该层整体跳过、完全不访问 localhost——关掉它或启动 Ollama。

**Q: 上游 404，模型不存在**
`tiers` 里的模型名和上游平台（尤其 new-api）里的名字不一致。转发时 `provider/` 前缀会被剥掉，上游收到的是 `/` 后面的部分，按那个核对。

**Q: passthrough 模式返回 401 `API key required`**
客户端没带 key。Claude Code 检查 `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`，OpenAI 客户端检查 API Key 配置项。
