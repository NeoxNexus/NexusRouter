# NexusRouter SPEC

## 项目概述

NexusRouter 是一个智能 LLM 路由器，为每个请求选择最合适的模型。支持 41+ 模型 (OpenAI、Anthropic、DeepSeek、Google 等)。

## 配置系统

### Config 接口定义

```typescript
export interface Config {
  router: RouterConfig;
  providers: Record<string, ProviderConfig>;
  tiers: Record<Tier, TierConfig>;
  ollama: OllamaConfig;
}

export interface RouterConfig {
  port: number;
  classifier: "heuristic" | "hybrid";
  layers: {
    rules: { enabled: boolean };
    heuristic: { confidenceThreshold: number };
    ai: { fallbackConfidence: number };
  };
}

export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  maxRetries: number;
}

export interface TierConfig {
  primary: string;
  fallback: string[];
}

export interface OllamaConfig {
  enabled: boolean;
  baseUrl: string;
  models: {
    fast: string;
    accurate: string;
  };
  timeout: number;
}
```

### config.yaml 格式

```yaml
router:
  port: 8402
  classifier: hybrid
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
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}

tiers:
  SIMPLE:
    primary: openai/gpt-4o-mini
    fallback: []
  MEDIUM:
    primary: openai/gpt-4o
    fallback: []
  COMPLEX:
    primary: anthropic/claude-sonnet-4.6
    fallback: []
  REASONING:
    primary: openai/o3-mini
    fallback: []

ollama:
  enabled: false
  baseUrl: http://localhost:11434
  models:
    fast: qwen2.5:3b
    accurate: qwen2.5:14b
  timeout: 30000
```

### 环境变量覆盖规则

- 配置文件中使用 `${ENV_VAR}` 语法引用环境变量
- 环境变量优先级高于配置文件
- 支持嵌套变量（如 `${OPENAI_API_KEY}`）

### Zod 验证错误格式

```typescript
interface ValidationError {
  code: "VALIDATION_ERROR";
  errors: Array<{
    path: string;
    message: string;
  }>;
}
```

## Ollama 客户端

### OllamaClient.classify() 接口

```typescript
interface ClassificationResult {
  tier: Tier;
  confidence: number;
  latency: number;
}

class OllamaClient {
  async classify(prompt: string, context: HeuristicContext): Promise<ClassificationResult>;
}
```

### OllamaClient.healthCheck() 接口

```typescript
class OllamaClient {
  async healthCheck(): Promise<boolean>;
}
```

### 超时和错误处理

- 默认超时: 30000ms
- 超时返回 fallback 结果
- 网络错误返回 false

## 混合分类器

### HybridClassifier.classify() 接口

```typescript
interface ClassificationResult {
  tier: Tier;
  confidence: number;
  layer: "rule" | "heuristic" | "ai" | "fallback";
  latency: number;
}

class HybridClassifier {
  async classify(prompt: string, context: HeuristicContext): Promise<ClassificationResult>;
}
```

### Layer 分层逻辑

- **Layer 0 (rule)**: 规则引擎，< 0.1ms
- **Layer 1 (heuristic)**: 14维启发式，0.5-1ms
- **Layer 2 (ai)**: Ollama 快速模型，5-8ms
- **Layer 3 (fallback)**: Ollama 精确模型，10-15ms

### 延迟统计

每个分类结果包含 `latency` 字段，记录各层处理时间。

## Fastify 服务器

### POST /v1/chat/completions 接口

```typescript
// 请求
interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string;
  }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

// 响应 (非流式)
interface ChatCompletionResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      role: "assistant";
      content: string;
    };
    finish_reason: "stop" | "length";
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
```

### 流式响应格式

使用 SSE 格式，逐块返回 `data: ` 前缀的 JSON。

### 错误响应格式

```typescript
interface ErrorResponse {
  error: {
    message: string;
    type: string;
    code?: string;
  };
}
```

## 验收标准

- [ ] 配置加载成功
- [ ] 环境变量覆盖生效
- [ ] Zod 验证失败返回清晰错误
- [ ] Ollama 可用性检测正确
- [ ] 分类返回正确 tier + confidence + latency
- [ ] Layer 0/1/2/3 分层逻辑正确
- [ ] 服务器正确路由请求
