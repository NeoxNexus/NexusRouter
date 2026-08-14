import {
  OllamaClient,
  type HeuristicContext,
  type ClassificationResult as OllamaResult,
  type Tier,
} from "../ollama/client.js";

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

// 引用上文模式
const REFERENCE_PATTERNS = [
  /上面的|之前的|刚才|继续|那个|此文件|该文件/i,
  /\b(above|previous|that|this) (file|code|function|class)\b/i,
  /\bcontinue (with|editing)?/i,
];

// 辅助函数：提升 tier
function upgradeTier(current: Tier): Tier {
  const rank: Record<Tier, number> = { SIMPLE: 0, MEDIUM: 1, COMPLEX: 2, REASONING: 3 };
  const currentRank = rank[current];
  if (currentRank >= 3) return current;
  const tiers: Tier[] = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];
  return tiers[currentRank + 1];
}

export class HybridClassifier {
  constructor(
    private ollama: OllamaClient,
    private config: HybridConfig,
  ) {}

  async classify(
    prompt: string,
    context: HeuristicContext,
  ): Promise<OllamaResult & { layer: "rule" | "heuristic" | "ai" | "fallback" }> {
    // Layer 0: Rules (very fast, < 1ms)
    const ruleResult = this.checkRules(prompt, context);
    if (ruleResult.hit && ruleResult.tier) {
      return {
        tier: ruleResult.tier,
        confidence: 1.0,
        latency: 0.05,
        layer: "rule",
      };
    }

    // Layer 1: Heuristic (fast, < 2ms)
    const heuristicResult = this.heuristicClassify(prompt, context);
    if (heuristicResult.confidence >= this.config.heuristicThreshold) {
      return {
        ...heuristicResult,
        layer: "heuristic",
      };
    }

    // Layer 2: AI (Ollama fast model, < 10ms)
    try {
      const aiResult = await this.ollama.classify(prompt, context);
      if (aiResult.confidence >= this.config.aiThreshold) {
        return {
          ...aiResult,
          layer: "ai",
        };
      }
    } catch {
      // Fall through to fallback
    }

    // Layer 3: Fallback (heuristic with lower threshold)
    return {
      ...heuristicResult,
      confidence: 0.5,
      layer: "fallback",
    };
  }

  private checkRules(prompt: string, context: HeuristicContext): RuleResult {
    const normalized = prompt.trim().toLowerCase();

    // ★ hasTools 时跳过问候语和感谢语检测
    // 因为有 tools 表示是代理请求，即使是简单消息也需要更高级的模型
    if (!context.hasTools) {
      // 问候语检测
      if (GREETING_PATTERNS.test(normalized)) {
        return { hit: true, tier: "SIMPLE" };
      }

      // 感谢语检测
      if (THANK_PATTERNS.test(normalized)) {
        return { hit: true, tier: "SIMPLE" };
      }
    }

    // 推理关键词检测 (优先级最高)
    const reasoningKeywords = [
      "prove",
      "proof",
      "theorem",
      "mathematical",
      "logical",
      "derive",
      "show that",
    ];
    if (reasoningKeywords.some((kw) => normalized.includes(kw))) {
      return { hit: true, tier: "REASONING" };
    }

    // ★ 引用上文检测
    if (REFERENCE_PATTERNS.some((p) => p.test(normalized))) {
      return { hit: true, tier: upgradeTier("SIMPLE") };
    }

    // ★ hasTools 强制 COMPLEX (只有在不是 REASONING 时)
    if (context.hasTools) {
      return { hit: true, tier: "COMPLEX" };
    }

    // 复杂代码分析关键词
    const complexKeywords = [
      "analyze",
      "security",
      "implications",
      "architecture",
      "design patterns",
    ];
    if (complexKeywords.some((kw) => normalized.includes(kw))) {
      return { hit: true, tier: "COMPLEX" };
    }

    return { hit: false };
  }

  private heuristicClassify(prompt: string, context: HeuristicContext): OllamaResult {
    const start = Date.now();
    const normalized = prompt.toLowerCase();
    const words = prompt.split(/\s+/).length;

    let tier: Tier = "SIMPLE";
    let confidence = 0.5;

    // Check length
    if (words > 200) {
      tier = "COMPLEX";
      confidence = 0.7;
    } else if (words > 50) {
      tier = "MEDIUM";
      confidence = 0.65;
    }

    // Check for code patterns
    if (
      /```[\s\S]*```/.test(prompt) ||
      /function\s+\w+/.test(prompt) ||
      /class\s+\w+/.test(prompt)
    ) {
      if (tier === "SIMPLE") {
        tier = "MEDIUM";
        confidence = 0.7;
      } else if (tier === "MEDIUM") {
        tier = "COMPLEX";
        confidence = 0.8;
      }
    }

    // Check for reasoning keywords
    const reasoningKeywords = [
      "prove",
      "proof",
      "theorem",
      "mathematical",
      "logical",
      "derive",
      "calculate",
      "solve equation",
    ];
    if (reasoningKeywords.some((kw) => normalized.includes(kw))) {
      tier = "REASONING";
      confidence = 0.85;
    }

    // Check for multi-step analysis
    const analysisKeywords = ["analyze", "compare", "evaluate", "assess", "review"];
    if (analysisKeywords.some((kw) => normalized.includes(kw))) {
      if (tier === "SIMPLE" || tier === "MEDIUM") {
        tier = "COMPLEX";
        confidence = Math.max(confidence, 0.75);
      }
    }

    // ★ conversationLength 影响 tier (如果没有传，用 messageCount 判断)
    const convLength = context.conversationLength ||
      (context.messageCount <= 2 ? "short" : context.messageCount <= 6 ? "medium" : "long");

    if (convLength === "long") {
      if (tier === "SIMPLE") {
        tier = "MEDIUM";
        confidence = Math.min(confidence + 0.1, 1.0);
      } else {
        confidence = Math.min(confidence + 0.05, 1.0);
      }
    } else if (convLength === "medium" && tier === "SIMPLE") {
      confidence = Math.min(confidence + 0.05, 1.0);
    }

    // ★ hasTools 强制提升 (双重保险)
    if (context.hasTools && tier !== "REASONING") {
      tier = upgradeTier(tier);
      confidence = Math.min(confidence + 0.15, 1.0);
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
