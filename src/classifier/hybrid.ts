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
  /**
   * The substring that fired the rule. `reason` names the category, which is
   * not enough to tune a word list: D-001 was the skills-list word "improve"
   * matching the "prove" stem, and that was only findable by reading source.
   */
  matched?: string;
}

/** First match across a regex plus a keyword list, or undefined when neither fires. */
function firstMatch(
  text: string,
  pattern: RegExp,
  keywords: readonly string[],
): string | undefined {
  return pattern.exec(text)?.[0] ?? keywords.find((k) => text.includes(k));
}

/** 命中原因。用于日志分析各层与各规则的实际触发分布。 */
export type ClassificationReason =
  | "greeting"
  | "thanks"
  | "acknowledgement"
  | "reasoning-keyword"
  | "reference-pattern"
  | "complex-keyword"
  | "heuristic-score"
  | "ai-classified"
  | "low-confidence-fallback"
  | "heuristic-uncertain";

const GREETING_PATTERNS =
  /^((hi|hello|hey|howdy|good (morning|afternoon|evening)|what's up|yo|greetings)( there)?[\s,!]*)+$/i;
const THANK_PATTERNS = /^(thanks?|thank you|thx|ty|much appreciated|appreciate it)[\s!*]*$/i;

// 中文寒暄/感谢，与英文同策略：整句锚定（^...$）。「你好，帮我改个 bug」
// 这类寒暄+正文的句子不该被短路到 SIMPLE——它要走完整分类。
const GREETING_PATTERNS_ZH = /^(你好|您好|嗨|哈喽|早上好|上午好|下午好|晚上好)[\s~!！。,.，]*$/;
const THANK_PATTERNS_ZH = /^(谢谢|感谢|多谢|辛苦了|谢了)[\s~!！。,.，]*$/;

// 确认语。与问候/感谢同类：整句即全部内容，不含任务。单独成句才算，
// 「好的，那把这个函数重写一下」必须走完整分类。
const ACK_PATTERNS = /^(ok|okay|k|got it|sounds good|sure|yep|yes|nope|no problem)[\s!.]*$/i;
const ACK_PATTERNS_ZH = /^(好的|好|行|可以|收到|明白|明白了|知道了|了解|嗯)[\s~!！。,.，]*$/;

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
 *
 * 裸词 `logical` / `derived` 已移除：taxonomy 判据是「有无严格推导链」，
 * 而这两个词在日常英语里多为形容词与继承术语（"is this logical"、
 * "the derived class"），误伤率高于命中率。需要它们时用词组形式（见下）。
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
  "lemma",
  "derive",
  "derives",
  "mathematically",
  "show that",
  "by induction",
  "logically follows",
  "mathematical proof",
  "formal proof",
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
  "引理",
  "证明",
  "求证",
  "下界",
  "上界",
  "数学归纳",
  "复杂度分析",
];

/**
 * 反向词：命中即不算推理请求，交由后续层按内容判。
 * 只收「证明」的文书义 —— 这些词组整体就不指向推导。
 *
 * 曾把 `解析器`/`生成器`/`脚本` 等造物名词也放进来（用意是「写一个 X」是
 * 工程活不是推导），但它们会连带否掉「推导这个脚本的复杂度」这类真推理
 * 请求。中文推理词一旦被否，Layer 1 也接不住（见 heuristicClassify 的
 * 中文通路是后补的），欠档不可恢复；而误判成 REASONING 只是多花钱。
 * 代价非对称，故宁可放过。
 */
const REASONING_DEMOTE_ZH = ["证明材料", "工作证明", "证明书", "证明信"];

/**
 * 复杂分析关键词。
 *
 * 裸词 `security` / `architecture` 已移除：「CORS 的安全头是哪个」
 * 「架构文档在哪」是查询而非分析（taxonomy 规则 1：看动作，不看词汇）。
 * 保留的都是自带动作语义的词组。
 */
const COMPLEX_KEYWORDS = [
  "analyze",
  "analyse",
  "audit",
  "refactor",
  "redesign",
  "restructure",
  "implications",
  "design patterns",
  "security implications",
  "root cause",
  "code review",
  "trade-?offs?",
];

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
  "定位根因",
  "根因分析",
  "重新设计",
  "解耦",
  "责任链",
  "重写",
  "端点",
  "新增功能",
];

/**
 * 「深入分析」这类词组指向方案级工作，但也会出现在轻量提问里
 * （「深入分析一下这个变量名合适吗」）。命中这些反向词时不给 COMPLEX，
 * 交由后续层按内容判 —— taxonomy 规则 1：看动作，不看词汇。
 */
const COMPLEX_DEMOTE_ZH = ["变量名", "函数名", "命名", "拼写", "错别字", "标点"];

/**
 * 平凡查询：问一件事或改一段文字，不碰项目状态。
 *
 * 这是 taxonomy 里 SIMPLE 的正面证据。没有它，agentic host 的流量在
 * 不确定时会落 MEDIUM 先验（见 heuristicClassify 基线），事实查询与翻译
 * 便永远到不了 SIMPLE。
 *
 * 判据刻意不对称：SIMPLE 是最便宜的一档，把真活派到这里是欠档，代价比
 * 多花钱高。故先用三张否决表（动手动词/项目物件/camelCase 标识符）排除，
 * 剩下的才看是否为疑问句或文本操作。宁可漏判 SIMPLE。
 */

// 句首疑问词。`do` 不收：`^do\b` 会吃掉「Do it now.」这类祈使句。
const INTERROGATIVE =
  /^(what|which|where|when|who|whose|why|how|is|are|does|did|can|could|should)\b|[?？]\s*$|什么|哪个|哪些|哪里|怎么|如何|是不是|有没有|吗[\s?？。]*$|呢[\s?？。]*$/i;

const TEXT_OPERATION =
  /翻译|改写|润色|通顺|格式化|\b(translate|rephrase|reword|proofread|paraphrase)\b/i;

/**
 * 动手动词 —— 出现即说明要改动项目状态，不再是平凡查询。
 * 收得比直觉宽：疑问句形式的祈使句（「how about you rewrite X」
 * 「怎么把调度器重写一遍」）只有靠这里才能拦住，否则会落 SIMPLE。
 */
const MUTATION_VERB =
  /\b(add|remove|delete|rename|refactor|restructure|rewrite|redesign|implement|migrate|deploy|install|revert|commit|merge|optimize|optimise|split|extract|fix|update|upgrade|make)\b|新增|删除|改名|重命名|重构|重写|重新设计|梳理|实现|接入|部署|回滚|提交|优化|拆分|拆成|抽出|修复|改成|改得/i;

/** 项目物件引用：文件路径、代码围栏、仓库术语。 */
const PROJECT_ARTIFACT =
  /[\w-]+\.(?:ts|tsx|js|jsx|json|ya?ml|md|py|go|rs|java|sh)\b|\/[\w/.-]+|```|\b(repo|repository|codebase|commit|branch|endpoint|pipeline|scheduler|service)\b|文件|仓库|代码|端点|测试|函数|模块|配置|变量|参数|字段|类型|接口|逻辑|流水线|调度器|服务/i;

/**
 * camelCase 标识符 —— 出现即在谈具体符号而非概念。
 * 大小写敏感（无 `/i`）：加了 `/i` 会让 `[a-z]+[A-Z]` 退化成匹配任意单词，
 * 从而把每条英文请求都判成「引用了项目物件」。
 */
const CAMEL_CASE_IDENT = /\b[a-z]+[A-Z]\w*\b/;

function isTrivialQuery(prompt: string): boolean {
  if (
    MUTATION_VERB.test(prompt) ||
    PROJECT_ARTIFACT.test(prompt) ||
    CAMEL_CASE_IDENT.test(prompt)
  ) {
    return false;
  }
  return INTERROGATIVE.test(prompt) || TEXT_OPERATION.test(prompt);
}

// Layer 1 用的推理词表比 Layer 0 更宽（含 calculate / solve equation），
// 因为启发式层只加权、不直接定档，误判代价更低。
const HEURISTIC_REASONING_PATTERN = new RegExp(
  `\\b(?:${[...REASONING_KEYWORDS, "calculate", "solve equation"].join("|")})\\b`,
  "i",
);

const ANALYSIS_PATTERN = /\b(?:analyze|analyse|compare|evaluate|assess|audit|refactor)\b/i;

const TIER_RANK: Record<Tier, number> = { SIMPLE: 0, MEDIUM: 1, COMPLEX: 2, REASONING: 3 };

/** 把 tier 抬到至少 floor，已达到或更高则原样返回。 */
function raiseTo(current: Tier, floor: Tier): Tier {
  return TIER_RANK[current] >= TIER_RANK[floor] ? current : floor;
}

/**
 * 中英混排的规模估算。
 *
 * `split(/\s+/)` 对无空格的中文整句返回 1，长度维度因此只对英文生效
 * （109 字中文长指令 → 1 词）。CJK 字符按 0.6 词折算（约合常见分词粒度），
 * 非 CJK 部分按空白切分。
 *
 * 单次遍历、零分配：`match()` + `replace()` + `split()` 的写法在 36KB
 * 中文输入上要 4.3ms，占满 CLAUDE.md 给整个启发式层的 2ms 预算；单条用户
 * 消息贴一段代码或日志就能到这个量级。结果只跟 50 / 200 两个阈值比较，
 * 故超过 SCAN_CAP 后停扫 —— 那时早已判定为「长」。
 */
const WORD_SCAN_CAP = 4000;

function estimateWordCount(prompt: string): number {
  const end = Math.min(prompt.length, WORD_SCAN_CAP);
  let cjk = 0;
  let words = 0;
  let inWord = false;

  for (let i = 0; i < end; i++) {
    const code = prompt.charCodeAt(i);
    // CJK 扩展A / 统一汉字 / 日文假名 / 韩文音节，与旧字符类等价。
    const isCjk =
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af);

    if (isCjk) {
      cjk++;
      inWord = false;
    } else if (code === 32 || (code >= 9 && code <= 13)) {
      inWord = false;
    } else if (!inWord) {
      words++;
      inWord = true;
    }
  }

  return words + Math.round(cjk * 0.6);
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
      /** Substring that fired a Layer 0 rule. Absent on other layers. */
      matched?: string;
      /**
       * Raw Layer 1 score, kept even when Layer 3 reports 0.5 instead. It is
       * the only evidence for whether `heuristicThreshold` is reachable —
       * real traffic hit `layer: "heuristic"` 0 times in 658 requests.
       */
      heuristicScore?: number;
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
        ...(ruleResult.matched ? { matched: ruleResult.matched } : {}),
      };
    }

    // Layer 1: Heuristic (fast, < 2ms)
    const heuristicResult = this.heuristicClassify(prompt, context);
    if (heuristicResult.confidence >= this.config.heuristicThreshold) {
      return {
        ...heuristicResult,
        layer: "heuristic",
        reason: "heuristic-score",
        heuristicScore: heuristicResult.confidence,
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

    // Layer 3: Fallback —— 采用启发式档位本身，不再无条件升档。
    //
    // 曾在此 `upgradeTier`，理由是「拿不准升档，代价非对称」。但 Layer 1 的
    // 置信度门实际不可达（上限 0.8 < 0.92），于是绝大多数流量落到这里、
    // 集体 +1；叠加 Layer 1 内部的 long / requiresTools 两处升档，真实 CC
    // 流量恒落最高两档，路由器失去意义（D-002）。
    //
    // 升档必须由具体信号驱动，不得由「没有信号」驱动 —— 缺证据是低档的
    // 理由，不是高档的理由。信号驱动的下限已在 Layer 1 内表达
    // （requiresTools → MEDIUM 下限、代码块、词表命中）。
    //
    // 空文本伪兜底（server.ts 在无文本可分类时手工构造的 fallback 条目）
    // 不走这里，保持 SIMPLE / "low-confidence-fallback" 以区分两类兜底。
    return {
      ...heuristicResult,
      confidence: 0.5,
      layer: "fallback",
      reason: "heuristic-uncertain",
      heuristicScore: heuristicResult.confidence,
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

    // 确认语检测（中英文，均为整句匹配）。与问候/感谢同类：整句即全部内容。
    if (ACK_PATTERNS.test(normalized) || ACK_PATTERNS_ZH.test(normalized)) {
      return { hit: true, tier: "SIMPLE", reason: "acknowledgement" };
    }

    // 推理关键词检测（优先级最高，中英文双通路任一命中即算）。
    // 反向词命中时让位于后续层：见 REASONING_DEMOTE_ZH。
    const reasoningMatch = firstMatch(normalized, REASONING_PATTERN, REASONING_KEYWORDS_ZH);
    if (reasoningMatch && !REASONING_DEMOTE_ZH.some((k) => normalized.includes(k))) {
      return { hit: true, tier: "REASONING", reason: "reasoning-keyword", matched: reasoningMatch };
    }

    // 复杂分析关键词（中英文双通路任一命中即算）。反向词命中时让位于后续层：
    // 「深入分析一下这个变量名合适吗」的动作是命名判断，不是架构分析。
    const complexMatch = firstMatch(normalized, COMPLEX_PATTERN, COMPLEX_KEYWORDS_ZH);
    if (complexMatch && !COMPLEX_DEMOTE_ZH.some((k) => normalized.includes(k))) {
      return { hit: true, tier: "COMPLEX", reason: "complex-keyword", matched: complexMatch };
    }

    // 引用上文检测。必须排在 complex 之后：filler 词（继续/那个/刚才）只说明
    // 这是续轮，不说明难度，早于 complex 检查会让「继续深入分析这个模块的
    // 架构设计」被降到 MEDIUM（D-002）。命中时给 MEDIUM 下限而非定档 ——
    // 续轮至少要读上文状态，但不足以推定更高。
    for (const pattern of REFERENCE_PATTERNS) {
      const referenceMatch = pattern.exec(normalized);
      if (referenceMatch) {
        return {
          hit: true,
          tier: "MEDIUM",
          reason: "reference-pattern",
          matched: referenceMatch[0],
        };
      }
    }

    return { hit: false };
  }

  private heuristicClassify(prompt: string, context: HeuristicContext): OllamaResult {
    const start = Date.now();
    const normalized = prompt.toLowerCase();
    const words = estimateWordCount(prompt);

    // 基线是 MEDIUM，不是 SIMPLE。
    //
    // 到这一层的都是没被任何高精度规则接住的文本，而 CC 这类 agentic host 的
    // 默认流量是「对项目做点什么」——需要读状态，故至少 MEDIUM。SIMPLE 需要
    // 正面证据（isTrivialQuery：问一件事或改一段文字，不碰项目物件）。
    //
    // 原基线是 SIMPLE，靠 long 会话、requiresTools、Layer 3 兜底三处 +1 补回，
    // 那正是 D-002 的棘轮：先假设最简单，再无条件累加。
    let tier: Tier = isTrivialQuery(prompt) ? "SIMPLE" : "MEDIUM";
    let confidence = 0.5;

    // Check length
    if (words > 200) {
      tier = "COMPLEX";
      confidence = 0.7;
    } else if (words > 50) {
      tier = raiseTo(tier, "MEDIUM");
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

    // 会话长度只调置信度，不再动档位。
    // 真实 CC 流量 161/165 条都是长会话（messageCount 中位数 123），恒定的
    // 信号不含难度信息 —— 与 D-001 的 hasTools 同理。原先在此把 SIMPLE 抬到
    // MEDIUM，是棘轮的第一级（D-002）。
    const convLength =
      context.conversationLength ||
      (context.messageCount <= 2 ? "short" : context.messageCount <= 6 ? "medium" : "long");

    if (convLength === "long") {
      confidence = Math.min(confidence + 0.05, 1.0);
    }

    // 这一轮真的要动手 → MEDIUM 下限，不逐级累加。
    //
    // 用 requiresTools 而非 hasTools：后者对 Claude Code 恒为 true，恒真的
    // 条件不是分类特征。工具「能力」约束归 filterByToolCalling，不归档位。
    //
    // 原先是 upgradeTier(tier)，与 long 会话、Layer 3 兜底三处叠加后使
    // 「把这个文件的函数改个名」落到 REASONING（D-002）。动手意图说明需要读
    // 项目状态（故不能是 SIMPLE），但不说明这活比它本身更难。
    if (context.requiresTools) {
      const raised = raiseTo(tier, "MEDIUM");
      if (raised !== tier) {
        tier = raised;
        confidence = Math.min(confidence + 0.15, 1.0);
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
