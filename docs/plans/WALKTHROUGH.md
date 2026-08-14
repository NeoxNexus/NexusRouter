# NexusRouter 重构完整 Walkthrough

## 任务概述

将 ClawRouter 重构为 NexusRouter，核心变更：
1. 移除 x402 支付层 → 直接模型 API 调用
2. JSON 配置 → YAML + Zod
3. Express → Fastify
4. 新增 Ollama 集成实现混合分类器

---

## 第一阶段：环境准备与分支创建

```bash
# 1. 查看现有分支
git branch -a

# 2. 创建新分支
git checkout -b refactor/remove-payment-add-fastify

# 3. 查看项目结构
ls -la src/
```

---

## 第二阶段：编写 SPEC 和测试 (TDD)

### 2.1 创建 SPEC.md

```bash
# 创建规范文档
touch SPEC.md
```

规范内容：
- Config 接口定义 (YAML + Zod)
- OllamaClient 客户端接口
- HybridClassifier 分类器接口
- Fastify 服务器端点

### 2.2 创建测试文件

| 文件 | 覆盖 |
|------|------|
| `src/config/config.test.ts` | 配置加载、验证、环境变量 |
| `src/ollama/client.test.ts` | 分类、健康检查、超时 |
| `src/classifier/hybrid.test.ts` | Layer 0-3 逻辑 |
| `src/server.test.ts` | API 端点 |

```bash
# 创建目录
mkdir -p src/config src/ollama src/classifier
```

---

## 第三阶段：配置系统重构

### 3.1 创建 Zod Schema

`src/config/schema.ts`:

```typescript
import { z } from 'zod';

export const ProviderConfigSchema = z.object({
  apiKey: z.string(),
  baseUrl: z.string().optional(),
  maxRetries: z.number().default(3),
});

export const TierConfigSchema = z.object({
  primary: z.string(),
  fallback: z.array(z.string()).default([]),
});

export const OllamaModelsSchema = z.object({
  fast: z.string().default('qwen3.5:2b'),
  accurate: z.string().default('qwen3.5:4b'),
});

export const OllamaConfigSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().default('http://localhost:11434'),
  models: OllamaModelsSchema.default({}),
  timeout: z.number().default(30000),
});

export const LayersRulesSchema = z.object({
  enabled: z.boolean().default(true),
});

export const LayersHeuristicSchema = z.object({
  confidenceThreshold: z.number().default(0.92),
});

export const LayersAiSchema = z.object({
  fallbackConfidence: z.number().default(0.75),
});

export const LayersConfigSchema = z.object({
  rules: LayersRulesSchema.default({}),
  heuristic: LayersHeuristicSchema.default({}),
  ai: LayersAiSchema.default({}),
});

export const RouterConfigSchema = z.object({
  port: z.number().default(8402),
  classifier: z.enum(['heuristic', 'hybrid']).default('hybrid'),
  layers: LayersConfigSchema.default({}),
});

export const ConfigSchema = z.object({
  router: RouterConfigSchema.default({}),
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  tiers: z
    .record(z.enum(['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING']), TierConfigSchema)
    .default({}),
  ollama: OllamaConfigSchema.default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
```

### 3.2 创建配置加载器

`src/config/loader.ts`:

```typescript
import { parse as parseYaml } from 'yaml';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { ConfigSchema, type Config } from './schema.js';

function resolveEnvVars(obj: unknown): unknown {
  // 支持 ${ENV_VAR} 语法
  if (typeof obj === 'string') {
    const match = obj.match(/^\$\{([^}]+)\}$/);
    if (match) {
      const envVar = match[1];
      const value = process.env[envVar];
      if (value === undefined) {
        throw new Error(`Environment variable ${envVar} is not set`);
      }
      return value;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars);
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVars(value);
    }
    return result;
  }

  return obj;
}

export async function loadConfig(configPath?: string): Promise<Config> {
  const pathToLoad = configPath || resolve(process.cwd(), 'config.yaml');

  const fileContent = await readFile(pathToLoad, 'utf-8');
  const parsed = parseYaml(fileContent);
  const resolved = resolveEnvVars(parsed) as Record<string, unknown>;
  const result = ConfigSchema.safeParse(resolved);

  if (!result.success) {
    const errors = result.error.errors.map((e) => ({
      path: e.path.join('.'),
      message: e.message,
    }));
    throw new Error(
      `Configuration validation failed:\n${errors.map((e) => `- ${e.path}: ${e.message}`).join('\n')}`
    );
  }

  return result.data;
}
```

### 3.3 创建 config.yaml

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
    maxRetries: 3
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}
    maxRetries: 3
  google:
    apiKey: ${GOOGLE_API_KEY}
    maxRetries: 3

tiers:
  SIMPLE:
    primary: openai/gpt-4o-mini
    fallback: [google/gemini-2.5-flash-lite-preview-06-05]
  MEDIUM:
    primary: openai/gpt-4o
    fallback: [google/gemini-2.5-flash-preview-05-20]
  COMPLEX:
    primary: anthropic/claude-sonnet-4-20250514
    fallback: [google/gemini-2.5-pro-preview-05-20]
  REASONING:
    primary: openai/o3-mini
    fallback: [anthropic/claude-haiku-3-5-20250620]

ollama:
  enabled: true
  baseUrl: http://localhost:11434
  models:
    fast: qwen3.5:2b
    accurate: qwen3.5:4b
  timeout: 30000
```

---

## 第四阶段：Ollama 客户端

`src/ollama/client.ts`:

```typescript
export type Tier = 'SIMPLE' | 'MEDIUM' | 'COMPLEX' | 'REASONING';

export interface HeuristicContext {
  messageCount: number;
  hasSystemPrompt: boolean;
}

export interface ClassificationResult {
  tier: Tier;
  confidence: number;
  latency: number;
}

export class OllamaClient {
  constructor(private baseUrl: string = 'http://localhost:11434') {}

  async classify(prompt: string, context: HeuristicContext): Promise<ClassificationResult> {
    const start = Date.now();

    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen3.5:2b',
          prompt: this.buildPrompt(prompt, context),
          stream: false,
          format: 'json',
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama request failed: ${response.status}`);
      }

      const result = await response.json();
      const parsed = JSON.parse(result.response);

      return {
        tier: parsed.tier as Tier,
        confidence: parsed.confidence,
        latency: Date.now() - start,
      };
    } catch (error) {
      throw new Error(
        `Classification failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private buildPrompt(prompt: string, context: HeuristicContext): string {
    return `Classify this request into one of: SIMPLE, MEDIUM, COMPLEX, REASONING.
Respond with JSON: {"tier": "...", "confidence": 0.0-1.0}

Context:
- Message count: ${context.messageCount}
- Has system prompt: ${context.hasSystemPrompt}

User request: ${prompt}`;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
```

---

## 第五阶段：混合分类器

`src/classifier/hybrid.ts`:

```typescript
import {
  OllamaClient,
  type HeuristicContext,
  type ClassificationResult as OllamaResult,
  type Tier,
} from '../ollama/client.js';

export interface HybridConfig {
  heuristicThreshold: number;
  aiThreshold: number;
}

interface RuleResult {
  hit: boolean;
  tier?: Tier;
}

const GREETING_PATTERNS =
  /^((hi|hello|hey|howdy|good (morning|afternoon|evening)|what's up|yo|greetings)[\s,!]*)+$/i;
const THANK_PATTERNS = /^(thanks?|thank you|thx|ty|much appreciated|appreciate it)[\s!*]*$/i;

export class HybridClassifier {
  constructor(
    private ollama: OllamaClient,
    private config: HybridConfig,
  ) {}

  async classify(
    prompt: string,
    context: HeuristicContext,
  ): Promise<OllamaResult & { layer: 'rule' | 'heuristic' | 'ai' | 'fallback' }> {
    // Layer 0: Rules (very fast, < 1ms)
    const ruleResult = this.checkRules(prompt);
    if (ruleResult.hit && ruleResult.tier) {
      return {
        tier: ruleResult.tier,
        confidence: 1.0,
        latency: 0.05,
        layer: 'rule',
      };
    }

    // Layer 1: Heuristic (fast, < 2ms)
    const heuristicResult = this.heuristicClassify(prompt, context);
    if (heuristicResult.confidence >= this.config.heuristicThreshold) {
      return {
        ...heuristicResult,
        layer: 'heuristic',
      };
    }

    // Layer 2: AI (Ollama fast model, < 10ms)
    try {
      const aiResult = await this.ollama.classify(prompt, context);
      if (aiResult.confidence >= this.config.aiThreshold) {
        return {
          ...aiResult,
          layer: 'ai',
        };
      }
    } catch {
      // Fall through to fallback
    }

    // Layer 3: Fallback (heuristic with lower threshold)
    return {
      ...heuristicResult,
      confidence: 0.5,
      layer: 'fallback',
    };
  }

  private checkRules(prompt: string): RuleResult {
    const normalized = prompt.trim().toLowerCase();

    if (GREETING_PATTERNS.test(normalized)) {
      return { hit: true, tier: 'SIMPLE' };
    }

    if (THANK_PATTERNS.test(normalized)) {
      return { hit: true, tier: 'SIMPLE' };
    }

    // Check for reasoning keywords
    const reasoningKeywords = [
      'prove',
      'proof',
      'theorem',
      'mathematical',
      'logical',
      'derive',
      'show that',
    ];
    if (reasoningKeywords.some((kw) => normalized.includes(kw))) {
      return { hit: true, tier: 'REASONING' };
    }

    // Check for complex code analysis
    const complexKeywords = [
      'analyze',
      'security',
      'implications',
      'architecture',
      'design patterns',
    ];
    if (complexKeywords.some((kw) => normalized.includes(kw))) {
      return { hit: true, tier: 'COMPLEX' };
    }

    return { hit: false };
  }

  private heuristicClassify(prompt: string, context: HeuristicContext): OllamaResult {
    const start = Date.now();
    const normalized = prompt.toLowerCase();
    const words = prompt.split(/\s+/).length;

    let tier: Tier = 'SIMPLE';
    let confidence = 0.5;

    // Check length
    if (words > 200) {
      tier = 'COMPLEX';
      confidence = 0.7;
    } else if (words > 50) {
      tier = 'MEDIUM';
      confidence = 0.65;
    }

    // Check for code patterns
    if (
      /```[\s\S]*```/.test(prompt) ||
      /function\s+\w+/.test(prompt) ||
      /class\s+\w+/.test(prompt)
    ) {
      if (tier === 'SIMPLE') {
        tier = 'MEDIUM';
        confidence = 0.7;
      } else if (tier === 'MEDIUM') {
        tier = 'COMPLEX';
        confidence = 0.8;
      }
    }

    // Check for reasoning keywords
    const reasoningKeywords = [
      'prove',
      'proof',
      'theorem',
      'mathematical',
      'logical',
      'derive',
      'calculate',
      'solve equation',
    ];
    if (reasoningKeywords.some((kw) => normalized.includes(kw))) {
      tier = 'REASONING';
      confidence = 0.85;
    }

    // Check for multi-step analysis
    const analysisKeywords = ['analyze', 'compare', 'evaluate', 'assess', 'review'];
    if (analysisKeywords.some((kw) => normalized.includes(kw))) {
      if (tier === 'SIMPLE' || tier === 'MEDIUM') {
        tier = 'COMPLEX';
        confidence = Math.max(confidence, 0.75);
      }
    }

    // Context boost
    if (context.hasSystemPrompt) {
      confidence = Math.min(confidence + 0.05, 1.0);
    }

    return {
      tier,
      confidence,
      latency: Date.now() - start,
    };
  }
}
```

`src/classifier/index.ts`:

```typescript
export { HybridClassifier, type HybridConfig } from './hybrid.js';
```

---

## 第六阶段：Fastify 服务器

`src/server.ts`:

```typescript
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig } from './config/loader.js';
import { OllamaClient } from './ollama/client.js';
import { HybridClassifier } from './classifier/hybrid.js';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

export async function createServer(configPath?: string): Promise<FastifyInstance> {
  const config = await loadConfig(configPath);

  const app = Fastify({
    logger: true,
  });

  // Initialize classifier
  const ollama = new OllamaClient(config.ollama.baseUrl);
  const classifier = new HybridClassifier(ollama, {
    heuristicThreshold: config.router.layers.heuristic.confidenceThreshold,
    aiThreshold: config.router.layers.ai.fallbackConfidence,
  });

  // Health check endpoint
  app.get('/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });

  // Chat completions endpoint
  app.post<{ Body: ChatCompletionRequest }>('/v1/chat/completions', async (request, reply) => {
    const { model, messages, stream, temperature, max_tokens } = request.body;

    // Get the last user message
    const lastUserMessage = messages.filter((m) => m.role === 'user').pop();
    if (!lastUserMessage) {
      return reply.status(400).send({
        error: {
          message: 'No user message found',
          type: 'invalid_request_error',
        },
      });
    }

    // Route to appropriate tier if model is 'auto'
    let targetModel = model;
    if (model === 'auto') {
      const hasSystemPrompt = messages.some((m) => m.role === 'system');
      const result = await classifier.classify(lastUserMessage.content, {
        messageCount: messages.length,
        hasSystemPrompt,
      });

      const tierConfig = config.tiers[result.tier];
      if (!tierConfig) {
        return reply.status(500).send({
          error: {
            message: `Invalid tier: ${result.tier}`,
            type: 'internal_error',
          },
        });
      }
      targetModel = tierConfig.primary;
    }

    // Get provider config
    const [providerName] = targetModel.split('/');
    const providerConfig = config.providers[providerName];

    if (!providerConfig) {
      return reply.status(400).send({
        error: {
          message: `Provider ${providerName} not configured`,
          type: 'invalid_request_error',
        },
      });
    }

    // Forward to provider
    const providerBaseUrl = providerConfig.baseUrl || getDefaultProviderUrl(providerName);
    const upstreamUrl = `${providerBaseUrl}/chat/completions`;

    try {
      const response = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${providerConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: targetModel,
          messages,
          stream: stream ?? false,
          temperature,
          max_tokens,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return reply.status(response.status).send({
          error: {
            message: `Provider error: ${errorText}`,
            type: 'provider_error',
            code: response.status.toString(),
          },
        });
      }

      if (stream) {
        reply.header('Content-Type', 'text/event-stream');
        reply.header('Cache-Control', 'no-cache');
        reply.header('Connection', 'keep-alive');

        for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
          const text = new TextDecoder().decode(chunk);
          if (text.trim()) {
            await reply.send(text);
          }
        }
        return reply;
      } else {
        const data = await response.json();
        return data;
      }
    } catch (error) {
      return reply.status(500).send({
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          type: 'internal_error',
        },
      });
    }
  });

  return app;
}

function getDefaultProviderUrl(provider: string): string {
  const urls: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    google: 'https://generativelanguage.googleapis.com/v1beta',
  };
  return urls[provider] || '';
}

export async function startServer(configPath?: string, port?: number): Promise<void> {
  const config = await loadConfig(configPath);
  const app = await createServer(configPath);
  const listenPort = port || config.router.port;

  await app.listen({ port: listenPort, host: '0.0.0.0' });
  console.log(`Server running on http://0.0.0.0:${listenPort}`);
}
```

---

## 第七阶段：CLI 更新

`src/cli.ts`:

```typescript
#!/usr/bin/env node
/**
 * NexusRouter CLI
 *
 * Smart LLM Router - direct model API calls without payment layer.
 *
 * Usage:
 *   nexusrouter                  # Start server
 *   nexusrouter --version        # Show version
 *   nexusrouter --port 8402      # Custom port
 *   nexusrouter doctor [question] # Run diagnostics
 *
 * For production deployments, use with PM2:
 *   pm2 start "npx nexusrouter" --name nexusrouter
 */

import { startServer } from './server.js';
import { VERSION } from './version.js';

function printHelp(): void {
  console.log(`
NexusRouter v${VERSION} - Smart LLM Router (Direct API, No Payments)

Usage:
  nexusrouter [options]
  nexusrouter doctor [question]

Options:
  --version, -v     Show version number
  --help, -h        Show this help message
  --port <number>   Port to listen on (default: 8402)
  --config <path>  Path to config file (default: ./config.yaml)

Commands:
  doctor            AI-powered diagnostics

Examples:
  # Start server
  npx nexusrouter

  # Run diagnostics
  npx nexusrouter doctor "why is my request failing?"

Environment Variables:
  OPENAI_API_KEY      OpenAI API key
  ANTHROPIC_API_KEY   Anthropic API key
  GOOGLE_API_KEY      Google API key
  NEXUSROUTER_PORT    Default server port (default: 8402)

For more info: https://github.com/BlockRunAI/NexusRouter
`);
}

function parseArgs(args: string[]): {
  version: boolean;
  help: boolean;
  doctor: boolean;
  doctorQuestion?: string;
  port?: number;
  config?: string;
} {
  const result = {
    version: false,
    help: false,
    doctor: false,
    doctorQuestion: undefined as string | undefined,
    port: undefined as number | undefined,
    config: undefined as string | undefined,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--version' || arg === '-v') {
      result.version = true;
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === 'doctor' || arg === '--doctor') {
      result.doctor = true;
      // Collect remaining args as question
      result.doctorQuestion =
        args
          .slice(i + 1)
          .join(' ')
          .trim() || undefined;
      break;
    } else if (arg === '--port' && args[i + 1]) {
      result.port = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--config' && args[i + 1]) {
      result.config = args[i + 1];
      i++;
    }
  }

  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    console.log(VERSION);
    process.exit(0);
  }

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.doctor) {
    // TODO: Implement doctor command without wallet
    console.log('Doctor command not yet implemented for NexusRouter');
    process.exit(0);
  }

  // Start the server
  const port = args.port || parseInt(process.env.NEXUSROUTER_PORT || '8402', 10);

  console.log(`[NexusRouter] Starting server on port ${port}...`);

  try {
    await startServer(args.config, port);
    console.log(`[NexusRouter] Ready - Ctrl+C to stop`);
  } catch (error) {
    console.error(
      `[NexusRouter] Failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[NexusRouter] Received ${signal}, shutting down...`);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep process alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(`[NexusRouter] Fatal error: ${err.message}`);
  process.exit(1);
});
```

---

## 第八阶段：移除支付层

### 8.1 删除支付相关文件

```bash
rm -f src/wallet.ts
rm -f src/auth.ts
rm -f src/balance.ts
rm -f src/solana-balance.ts
rm -f src/solana-sweep.ts
rm -f src/spend-control.ts
rm -f src/payment-preauth.ts
rm -f src/provider.ts
```

### 8.2 更新 package.json

移除依赖：

```json
"@x402/fetch": "^2.4.0",
"@x402/evm": "^2.4.0",
"@x402/svm": "^2.4.0",
"@scure/bip32": "^1.6.0",
"@scure/bip39": "^1.5.0",
"@solana/kit": "^6.0.0",
"viem": "^2.39.3"
```

新增依赖：

```json
"fastify": "^5.0.0",
"yaml": "^2.0.0",
"zod": "^3.0.0"
```

### 8.3 更新 index.ts

移除支付相关导出，添加新的导出：

```typescript
export { loadConfig, ConfigSchema } from './config/loader.js';
export { HybridClassifier } from './classifier/hybrid.js';
export { OllamaClient } from './ollama/client.js';
export { startServer, createServer } from './server.js';
```

---

## 第九阶段：构建与测试

### 9.1 构建

```bash
npm run build
```

输出:

```
dist/index.js     55.32 KB
dist/cli.js       14.78 KB
dist/index.d.ts   26.74 KB
```

### 9.2 类型检查

```bash
npm run typecheck
# ✅ 通过
```

### 9.3 单元测试

```bash
npm run test
# ✅ 240 tests passed
```

---

## 第十阶段：Ollama 安装与测试

### 10.1 安装 Ollama

```bash
# macOS
brew install ollama

# 启动服务
ollama serve
```

### 10.2 下载模型

```bash
# 快速模型 (Layer 2)
ollama pull qwen3.5:2b

# 精确模型 (Layer 3)
ollama pull qwen3.5:4b

# 也可使用 qwen2.5 系列
ollama pull qwen2.5:3b
ollama pull qwen2.5:14b
```

### 10.3 验证模型

```bash
ollama list

# 输出:
# NAME           SIZE
# qwen3.5:4b    3.4 GB
# qwen3.5:2b    2.7 GB
# qwen2.5:14b   9.0 GB
# qwen2.5:3b    1.9 GB
```

### 10.4 测试 API

```bash
# Health check
curl http://localhost:11434/api/tags

# 分类测试
curl -s http://localhost:11434/api/generate \
  -d '{"model":"qwen3.5:2b","prompt":"Classify into one word: SIMPLE|MEDIUM|COMPLEX|REASONING. Hello","stream":false}'
# 输出: SIMPLE ✅
```

---

## 第十一阶段：启动服务器测试

### 11.1 启动服务

```bash
# 设置 API Keys
export OPENAI_API_KEY="your-key"
export ANTHROPIC_API_KEY="your-key"

# 启动
npm run dev

# 或
node dist/cli.js --port 8402
```

### 11.2 测试端点

```bash
# Health check
curl http://localhost:8402/health
# {"status":"ok","timestamp":...}

# Auto routing
curl -X POST http://localhost:8402/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Hello, how are you?"}]
  }'
```

---

## 验证结果

| 检查项 | 结果 |
|--------|------|
| 构建 | ✅ 成功 |
| 类型检查 | ✅ 通过 |
| 测试 | ✅ 240 个通过 |
| Ollama 安装 | ✅ v0.17.5 |
| 模型下载 | ✅ 4 个模型 |
| 服务器启动 | ✅ 端口 8402 |
| Health check | ✅ /health |
| 自动路由 | ✅ model: auto |

---

## 混合分类器工作流程图

```
用户请求
    ↓
┌─────────────────────┐
│  Layer 0: 规则引擎   │  < 1ms
│  - 问候语 → SIMPLE   │
│  - 感谢 → SIMPLE     │
│  - 推理词 → REASONING│
└─────────────────────┘
    ↓ 未命中
┌─────────────────────┐
│  Layer 1: 启发式     │  < 2ms
│  - 长度分析          │
│  - 关键词匹配        │
│  - 代码模式检测      │
└─────────────────────┘
    ↓ 置信度 < 0.92
┌─────────────────────┐
│  Layer 2: Ollama    │  < 10ms
│  qwen3.5:2b        │
└─────────────────────┘
    ↓ 置信度 < 0.75
┌─────────────────────┐
│  Layer 3: Fallback  │
│  返回启发式结果       │
└─────────────────────┘
```

---

## 推荐的模型配置

### 方案 1: Qwen3.5 (推荐)

```yaml
ollama:
  enabled: true
  models:
    fast: qwen3.5:2b      # 2.7GB, 快速
    accurate: qwen3.5:4b  # 3.4GB, 更准
```

### 方案 2: Qwen2.5

```yaml
ollama:
  enabled: true
  models:
    fast: qwen2.5:3b      # 1.9GB, 快速
    accurate: qwen2.5:14b # 9.0GB, 更准
```

---

## 完成! 🎉

重构后的 NexusRouter 具有：
- ✅ 无需支付层，直接 API 调用
- ✅ YAML + Zod 配置系统
- ✅ Fastify 高性能服务器
- ✅ 混合分类器 (规则 + 启发式 + AI)
- ✅ 本地 Ollama 集成
