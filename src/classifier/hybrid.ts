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
  reason?: ClassificationReason;
}

/** 命中原因。用于日志分析各层与各规则的实际触发分布。 */
export type ClassificationReason =
  | "greeting"
  | "thanks"
  | "reasoning-keyword"
  | "reference-pattern"
  | "complex-keyword"
  | "heuristic-score"
  | "ai-classified"
  | "low-confidence-fallback";

const GREETING_PATTERNS =
  /^((hi|hello|hey|howdy|good (morning|afternoon|evening)|what's up|yo|greetings)[\s,!]*)+$/i;
const THANK_PATTERNS = /^(thanks?|thank you|thx|ty|much appreciated|appreciate it)[\s!*]*$/i;

// 引用上文模式
const REFERENCE_PATTERNS = [
  /上面的|之前的|刚才|继续|那个|此文件|该文件/i,
  /\b(above|previous|that|this) (file|code|function|class)\b/i,
  /\bcontinue (with|editing)?/i,
];

/**
 * 推理关键词按整词匹配。
 *
 * 曾用 `includes()`，于是 "improve" 内含的 "prove" 会命中 —— Claude Code
 * 每轮都注入 skills 清单（必含 "improve"），全部流量因此钉在 REASONING。
 * `\b` 只对 ASCII 词边界有效，中文关键词需另立通路，故此表保持纯英文。
 */
const REASONING_KEYWORDS = [
  "prove",
  "proves",
  "proved",
  "proving",
  "proof",
  "proofs",
  "theorem",
  "theorems",
  "mathematical",
  "mathematically",
  "logical",
  "logically",
  "derive",
  "derives",
  "derived",
  "show that",
];

const REASONING_PATTERN = new RegExp(`\\b(?:${REASONING_KEYWORDS.join("|")})\\b`, "i");

// 复杂代码分析关键词
const COMPLEX_KEYWORDS = ["analyze", "security", "implications", "architecture", "design patterns"];

const COMPLEX_PATTERN = new RegExp(`\\b(?:${COMPLEX_KEYWORDS.join("|")})\\b`, "i");

// Layer 1 用的推理词表比 Layer 0 更宽（含 calculate / solve equation），
// 因为启发式层只加权、不直接定档，误判代价更低。
const HEURISTIC_REASONING_PATTERN = new RegExp(
  `\\b(?:${[...REASONING_KEYWORDS, "calculate", "solve equation"].join("|")})\\b`,
  "i",
);

const ANALYSIS_PATTERN = /\b(?:analyze|compare|evaluate|assess|review)\b/i;

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
  ): Promise<
    OllamaResult & {
      layer: "rule" | "heuristic" | "ai" | "fallback";
      reason: ClassificationReason;
    }
  > {
    // Layer 0: Rules (very fast, < 1ms)
    const ruleResult = this.checkRules(prompt);
    if (ruleResult.hit && ruleResult.tier) {
      return {
        tier: ruleResult.tier,
        confidence: 1.0,
        latency: 0.05,
        layer: "rule",
        reason: ruleResult.reason!,
      };
    }

    // Layer 1: Heuristic (fast, < 2ms)
    const heuristicResult = this.heuristicClassify(prompt, context);
    if (heuristicResult.confidence >= this.config.heuristicThreshold) {
      return {
        ...heuristicResult,
        layer: "heuristic",
        reason: "heuristic-score",
      };
    }

    // Layer 2: AI (Ollama fast model, < 10ms)
    try {
      const aiResult = await this.ollama.classify(prompt, context);
      if (aiResult.confidence >= this.config.aiThreshold) {
        return {
          ...aiResult,
          layer: "ai",
          reason: "ai-classified",
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
      reason: "low-confidence-fallback",
    };
  }

  private checkRules(prompt: string): RuleResult {
    const normalized = prompt.trim().toLowerCase();

    // 问候语检测
    if (GREETING_PATTERNS.test(normalized)) {
      return { hit: true, tier: "SIMPLE", reason: "greeting" };
    }

    // 感谢语检测
    if (THANK_PATTERNS.test(normalized)) {
      return { hit: true, tier: "SIMPLE", reason: "thanks" };
    }

    // 推理关键词检测 (优先级最高)
    if (REASONING_PATTERN.test(normalized)) {
      return { hit: true, tier: "REASONING", reason: "reasoning-keyword" };
    }

    // ★ 引用上文检测
    if (REFERENCE_PATTERNS.some((p) => p.test(normalized))) {
      return { hit: true, tier: upgradeTier("SIMPLE"), reason: "reference-pattern" };
    }

    // 复杂代码分析关键词
    if (COMPLEX_PATTERN.test(normalized)) {
      return { hit: true, tier: "COMPLEX", reason: "complex-keyword" };
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
    if (HEURISTIC_REASONING_PATTERN.test(normalized)) {
      tier = "REASONING";
      confidence = 0.85;
    }

    // Check for multi-step analysis
    if (ANALYSIS_PATTERN.test(normalized)) {
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

    // ★ 这一轮真的要动手时提升档位。
    // 用 requiresTools 而非 hasTools：后者对 Claude Code 恒为 true，恒真的
    // 条件不是分类特征。工具「能力」约束归 filterByToolCalling，不归档位。
    if (context.requiresTools && tier !== "REASONING") {
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
