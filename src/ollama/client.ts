export type Tier = "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING";

export interface HeuristicContext {
  messageCount: number;
  hasSystemPrompt: boolean;
  /** A tool schema is attached. Hosts like Claude Code set this on every turn. */
  hasTools?: boolean;
  /** This turn asks for an action, not merely that tools are available. */
  requiresTools?: boolean;
  conversationLength?: "short" | "medium" | "long";
}

export interface ClassificationResult {
  tier: Tier;
  confidence: number;
  latency: number;
}

export interface OllamaClientOptions {
  baseUrl?: string;
  timeout?: number;
  model?: string;
}

export class OllamaClient {
  private baseUrl: string;
  private timeout: number;
  private model: string;

  constructor(options: OllamaClientOptions = {}) {
    // 缺省值与历史行为一致：server.ts 总是显式传 config.ollama.*，
    // 这里的默认值只在直接构造时兜底。
    this.baseUrl = options.baseUrl ?? "http://localhost:11434";
    this.timeout = options.timeout ?? 1000;
    this.model = options.model ?? "qwen2.5:3b";
  }

  async classify(prompt: string, context: HeuristicContext): Promise<ClassificationResult> {
    const start = Date.now();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt: this.buildPrompt(prompt, context),
          stream: false,
          format: "json",
          keep_alive: "30m",
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Ollama request failed: ${response.status}`);
      }

      const result = await response.json();
      let parsed: { tier: string; confidence: number };
      try {
        parsed = JSON.parse(result.response);
      } catch {
        throw new Error(`Invalid Ollama response: ${result.response.slice(0, 100)}`);
      }

      return {
        tier: parsed.tier as Tier,
        confidence: parsed.confidence,
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

  private buildPrompt(prompt: string, context: HeuristicContext): string {
    const hasTools = context.hasTools ? "Yes (tool calling request)" : "No";
    const convLength = context.conversationLength || "short";
    return `Classify this request into one of: SIMPLE, MEDIUM, COMPLEX, REASONING.
Respond with JSON: {"tier": "...", "confidence": 0.0-1.0}

Context:
- Message count: ${context.messageCount}
- Has system prompt: ${context.hasSystemPrompt}
- Has tools: ${hasTools}
- Conversation length: ${convLength}

User request: ${prompt}

Output only the JSON object, no explanation.`;
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
