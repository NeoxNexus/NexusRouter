import type {
  HeuristicContext,
  ClassificationResult as OllamaResult,
  Tier,
} from "../ollama/client.js";
import type { AiClassifier } from "./ai-classifier.js";

export interface HybridConfig {
  heuristicThreshold: number;
  aiThreshold: number;
  /**
   * Layer 2（AI 分类层）总开关。false 时整块跳过，不会向分类后端
   * （Ollama 或 OpenAI 兼容网关）发任何请求，低置信流量直接落 Layer 3 兜底。
   */
  aiEnabled: boolean;
  /**
   * Layer 2 分类失败的告警钩子。只在进程内首个错误时调用一次，之后抑制：
   * Ollama 本地暂时性失败可忽略，但 openai-compat 远程网关的配置错误
   * （400/401/404）每请求必现，一次性 warn 即可暴露，无需每请求刷日志。
   */
  onAiError?: (err: unknown) => void;
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
  | "low-confidence-fallback"
  | "uncertain-upgrade";

const GREETING_PATTERNS =
  /^((hi|hello|hey|howdy|good (morning|afternoon|evening)|what's up|yo|greetings)[\s,!]*)+$/i;
const THANK_PATTERNS = /^(thanks?|thank you|thx|ty|much appreciated|appreciate it)[\s!*]*$/i;

// 中文寒暄/感谢，与英文同策略：整句锚定（^...$）。「你好，帮我改个 bug」
// 这类寒暄+正文的句子不该被短路到 SIMPLE——它要走完整分类。
const GREETING_PATTERNS_ZH = /^(你好|您好|嗨|哈喽|早上好|上午好|下午好|晚上好)[\s~!！。,.，]*$/;
const THANK_PATTERNS_ZH = /^(谢谢|感谢|多谢|辛苦了|谢了)[\s~!！。,.，]*$/;

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
 * `\b` 只对 ASCII 词边界有效，对中文无效，故关键词走双通路：英文用整词
 * 正则（本表），中文用 `includes()`（见下方 *_ZH 表），任一路径命中即算。
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

/**
 * 中文推理关键词。中文没有词边界，`\b` 无效，故用 `includes()` 匹配；
 * 词表宁精勿滥，只收语义具体、日常指令中误伤率低的词。
 * 裸词「证明」已移除——「工作证明/证明材料」这类文书请求会被误伤；
 * 只保留指向严格推理的词组（严格证明/数学证明/归纳证明/证明题）。
 */
const REASONING_KEYWORDS_ZH = [
  "推导",
  "论证",
  "定理",
  "数学归纳",
  "归纳证明",
  "复杂度分析",
  "严格证明",
  "数学证明",
  "证明题",
];

// 复杂代码分析关键词
const COMPLEX_KEYWORDS = ["analyze", "security", "implications", "architecture", "design patterns"];

const COMPLEX_PATTERN = new RegExp(`\\b(?:${COMPLEX_KEYWORDS.join("|")})\\b`, "i");

/**
 * 中文复杂分析关键词，同样用 `includes()` 匹配。
 * 避免“分析”这类超高频词误伤，只收更具体的词组。
 * 裸词「重构」已移除——「帮我重构这个函数」是常规编码请求而非方案级分析；
 * 只保留「重构方案/架构重构」这类明确指向架构层面的词组。
 */
const COMPLEX_KEYWORDS_ZH = [
  "深入分析",
  "架构设计",
  "系统架构",
  "安全隐患",
  "安全审计",
  "设计模式",
  "重构方案",
  "架构重构",
  "代码评审",
  "性能瓶颈",
];

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
  /** 首个 AI 层错误后置位，onAiError 只触发一次。 */
  private aiErrorNotified = false;

  constructor(
    private ai: AiClassifier,
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

    // Layer 2: AI（Ollama 或 OpenAI 兼容网关，< 10ms）。aiEnabled === false 时整块跳过。
    if (this.config.aiEnabled) {
      try {
        const aiResult = await this.ai.classify(prompt, context);
        if (aiResult.confidence >= this.config.aiThreshold) {
          return {
            ...aiResult,
            layer: "ai",
            reason: "ai-classified",
          };
        }
      } catch (err) {
        // 吞错落兜底照旧，但首个错误上报一次：远程网关的配置错误
        // （400/401/404）每请求必现，静默吞掉会让 Layer 2 永久失效而无人察觉。
        if (!this.aiErrorNotified) {
          this.aiErrorNotified = true;
          this.config.onAiError?.(err);
        }
        // Fall through to fallback
      }
    }

    // Layer 3: Fallback —— 拿不准时升一档。代价是非对称的：该弱给强只是
    // 静默多花钱，该强给弱则是质量可见崩；已是 REASONING 则封顶不变。
    // 空文本伪兜底（server.ts 在无文本可分类时手工构造的 fallback 条目）
    // 不走这里，保持 SIMPLE / "low-confidence-fallback" 以区分两类兜底。
    return {
      ...heuristicResult,
      tier: upgradeTier(heuristicResult.tier),
      confidence: 0.5,
      layer: "fallback",
      reason: "uncertain-upgrade",
    };
  }

  private checkRules(prompt: string): RuleResult {
    const normalized = prompt.trim().toLowerCase();

    // 问候语检测（中英文，均为整句匹配）
    if (GREETING_PATTERNS.test(normalized) || GREETING_PATTERNS_ZH.test(normalized)) {
      return { hit: true, tier: "SIMPLE", reason: "greeting" };
    }

    // 感谢语检测（中英文，均为整句匹配）
    if (THANK_PATTERNS.test(normalized) || THANK_PATTERNS_ZH.test(normalized)) {
      return { hit: true, tier: "SIMPLE", reason: "thanks" };
    }

    // 推理关键词检测 (优先级最高，中英文双通路任一命中即算)
    if (
      REASONING_PATTERN.test(normalized) ||
      REASONING_KEYWORDS_ZH.some((k) => normalized.includes(k))
    ) {
      return { hit: true, tier: "REASONING", reason: "reasoning-keyword" };
    }

    // ★ 引用上文检测
    if (REFERENCE_PATTERNS.some((p) => p.test(normalized))) {
      return { hit: true, tier: upgradeTier("SIMPLE"), reason: "reference-pattern" };
    }

    // 复杂代码分析关键词 (中英文双通路任一命中即算)
    if (
      COMPLEX_PATTERN.test(normalized) ||
      COMPLEX_KEYWORDS_ZH.some((k) => normalized.includes(k))
    ) {
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
