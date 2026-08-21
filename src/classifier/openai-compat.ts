import type { AiClassifier } from "./ai-classifier.js";
import type { ClassificationResult, HeuristicContext, Tier } from "../ollama/client.js";

export interface OpenAICompatClassifierOptions {
  /**
   * OpenAI 兼容服务地址，需含 /v1（new-api 网关或 vLLM 私有部署），
   * 例如 https://new-api.example.com/v1。尾斜杠会被剥掉。
   */
  baseUrl: string;
  /** 网关令牌。空串时不带 Authorization 头，兼容无鉴权的内网网关。 */
  apiKey?: string;
  /** 分类用的模型名，按上游平台上的名字（不带 provider/ 前缀）。 */
  model: string;
  /** 分类在请求关键路径上：超时即由上层降级兜底，宁短勿长。 */
  timeout?: number;
}

const VALID_TIERS: readonly string[] = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];

// 分类指令与 OllamaClient.buildPrompt 同构：tier 四选一 + 只输出 JSON。
// chat 协议天然拆成 system（任务指令）/ user（上下文 + 请求）两条消息。
const SYSTEM_INSTRUCTION = `Classify this request into one of: SIMPLE, MEDIUM, COMPLEX, REASONING.
Respond with JSON: {"tier": "...", "confidence": 0.0-1.0}
Output only the JSON object, no explanation.`;

function buildUserPrompt(prompt: string, context: HeuristicContext): string {
  const hasTools = context.hasTools ? "Yes (tool calling request)" : "No";
  const convLength = context.conversationLength || "short";
  return `Context:
- Message count: ${context.messageCount}
- Has system prompt: ${context.hasSystemPrompt}
- Has tools: ${hasTools}
- Conversation length: ${convLength}

User request: ${prompt}

Output only the JSON object, no explanation.`;
}

/** 部分模型即便开了 response_format 也会用 ```json 围栏包裹输出，剥掉再解析。 */
function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return match ? match[1].trim() : trimmed;
}

/**
 * OpenAI 兼容协议的 Layer 2 分类器：POST {baseUrl}/chat/completions。
 * 面向 new-api 网关 / vLLM 私有部署等任何实现了 Chat Completions 的服务。
 * 解析失败、tier 非法、超时一律 throw，由 HybridClassifier 落入 Layer 3 兜底。
 */
export class OpenAICompatClassifier implements AiClassifier {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private timeout: number;

  constructor(options: OpenAICompatClassifierOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? "";
    this.model = options.model;
    this.timeout = options.timeout ?? 800;
  }

  async classify(prompt: string, context: HeuristicContext): Promise<ClassificationResult> {
    const start = Date.now();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: SYSTEM_INSTRUCTION },
            { role: "user", content: buildUserPrompt(prompt, context) },
          ],
          temperature: 0,
          max_tokens: 50,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`OpenAI-compat request failed: ${response.status}`);
      }

      const result = await response.json();
      const content: unknown = result?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error("Invalid OpenAI-compat response: missing choices[0].message.content");
      }

      let parsed: { tier?: unknown; confidence?: unknown };
      try {
        parsed = JSON.parse(stripCodeFence(content));
      } catch {
        throw new Error(`Invalid OpenAI-compat response: ${content.slice(0, 100)}`);
      }

      if (typeof parsed.tier !== "string" || !VALID_TIERS.includes(parsed.tier)) {
        throw new Error(`Invalid OpenAI-compat response: unknown tier ${String(parsed.tier)}`);
      }

      return {
        tier: parsed.tier as Tier,
        // 模型省略 confidence 时缺省 0.8（≥ 默认 aiThreshold 0.75，必被采纳）。
        // 这是有意设计：chat 模型常只回 tier，远程网关既已成功给出合法 tier
        // 就采纳它；与 Ollama 路径（缺失即 undefined → 不采纳、落兜底）语义
        // 不同。需要更保守可在提示词里强制 confidence 或调高 aiThreshold。
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.8,
        latency: Date.now() - start,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Classification failed: Request timeout after ${this.timeout}ms`, {
          cause: error,
        });
      }
      throw new Error(
        `Classification failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        { cause: error },
      );
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }
      const response = await fetch(`${this.baseUrl}/models`, { headers });
      return response.ok;
    } catch {
      return false;
    }
  }
}
