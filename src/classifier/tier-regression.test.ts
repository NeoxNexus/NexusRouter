import { describe, it, expect } from "vitest";
import { HybridClassifier, type HybridConfig } from "./hybrid.js";
import type { AiClassifier } from "./ai-classifier.js";
import type { HeuristicContext, Tier } from "../ollama/client.js";
import { inferToolRequirement } from "../router/tool-intent.js";

/**
 * 档位回归集 —— 期望值的唯一依据是 `docs/plans/tier-taxonomy.md`，不是当前实现。
 *
 * Layer 2 关闭：本集固定 Layer 0/1/3 的确定性行为，不打网络。真实 CC 流量恒带
 * 工具表与 system prompt，故默认 context 照此设置；`requiresTools` 走
 * inferToolRequirement，与 server.ts 同一条路径。
 *
 * `gap: true` 的用例用 it.fails 标记：taxonomy 判定已写死，但当前信号不足以达到。
 * 它们是 4.4/4.6 调优的输入，不是 4.3 的范围。一旦某条开始通过，套件会转红 ——
 * 那是提示把它升级为常规用例，而非放松期望。
 */

const noAi: AiClassifier = {
  classify: () => Promise.reject(new Error("Layer 2 disabled in regression suite")),
};

const CONFIG: HybridConfig = { heuristicThreshold: 0.92, aiThreshold: 0.75, aiEnabled: false };

type CaseCtx = { long?: boolean };

type Case = {
  id: string;
  text: string;
  expected: Tier;
  ctx?: CaseCtx;
  /** taxonomy 判定当前不可达，见文件头。 */
  gap?: boolean;
  /** 为什么 taxonomy 这样判，或 gap 的成因。 */
  why?: string;
};

function buildContext(text: string, ctx: CaseCtx = {}): HeuristicContext {
  return {
    messageCount: ctx.long ? 12 : 2,
    hasSystemPrompt: true,
    hasTools: true,
    requiresTools: inferToolRequirement(text, undefined),
    conversationLength: ctx.long ? "long" : "short",
  };
}

function classify(text: string, ctx: CaseCtx = {}) {
  return new HybridClassifier(noAi, CONFIG).classify(text, buildContext(text, ctx));
}

const SIMPLE_CASES: Case[] = [
  { id: "greet-zh", text: "你好", expected: "SIMPLE" },
  { id: "greet-en", text: "hey there", expected: "SIMPLE" },
  { id: "thanks-zh", text: "谢谢", expected: "SIMPLE" },
  { id: "thanks-en", text: "thanks!", expected: "SIMPLE" },
  { id: "ack-zh", text: "好的", expected: "SIMPLE", why: "确认语，无实质任务" },
  { id: "ack-zh-2", text: "收到", expected: "SIMPLE" },
  {
    id: "ack-long-session",
    text: "好的",
    expected: "SIMPLE",
    ctx: { long: true },
    why: "taxonomy 规则 6：会话长度不携带难度",
  },
  { id: "fact-zh", text: "TypeScript 的 satisfies 关键字是哪个版本引入的？", expected: "SIMPLE" },
  { id: "fact-en", text: "what does the satisfies keyword do in TypeScript?", expected: "SIMPLE" },
  { id: "fact-cors", text: "What's the correct security header for CORS?", expected: "SIMPLE" },
  { id: "fact-doc", text: "where is the architecture doc?", expected: "SIMPLE" },
  { id: "translate", text: "把这段话翻译成英文：我们下周发布新版本。", expected: "SIMPLE" },
  { id: "reword", text: "帮我把这句改通顺一点：路由器选模型时会考虑成本", expected: "SIMPLE" },
  {
    id: "proof-doc",
    text: "工作证明材料一般怎么写",
    expected: "SIMPLE",
    why: "文书请求，非严格推理",
  },
];

const MEDIUM_CASES: Case[] = [
  {
    id: "rename-zh",
    text: "把 src/utils.ts 里的 getUserName 改名成 getUsername",
    expected: "MEDIUM",
  },
  { id: "rename-en", text: "rename getUserName to getUsername", expected: "MEDIUM" },
  { id: "typo-en", text: "fix the typo in the README", expected: "MEDIUM" },
  { id: "tweak-port", text: "把端口默认值从 8402 改成 8403", expected: "MEDIUM" },
  { id: "add-field", text: "给 RoutingLogEntry 加一个 sessionId 字段", expected: "MEDIUM" },
  { id: "explain-code", text: "解释一下这段代码在做什么", expected: "MEDIUM" },
  { id: "summarize", text: "总结一下这份评审报告的结论", expected: "MEDIUM" },
  { id: "run-tests", text: "跑一下测试看有没有挂", expected: "MEDIUM" },
  {
    id: "continue-bare",
    text: "继续",
    expected: "MEDIUM",
    why: "taxonomy 规则 3：纯 filler 判 MEDIUM",
  },
  { id: "continue-en", text: "please continue", expected: "MEDIUM" },
  { id: "continue-work", text: "接着改，把剩下两个文件也改了", expected: "MEDIUM" },
  {
    id: "greet-plus-body",
    text: "你好，帮我改个 bug",
    expected: "MEDIUM",
    why: "寒暄+正文不得短路 SIMPLE",
  },
  {
    id: "improve-readability",
    text: "改进一下这段代码的可读性",
    expected: "MEDIUM",
    why: "improve∋prove 陷阱",
  },
  {
    id: "derived-class",
    text: "Should the derived class override this method?",
    expected: "MEDIUM",
    why: "derived 是继承术语，非推导",
  },
  {
    id: "not-logical",
    text: "this error message is not logical, fix the wording",
    expected: "MEDIUM",
  },
  {
    id: "varname",
    text: "深入分析一下这个变量名合适吗",
    expected: "MEDIUM",
    why: "动作是命名判断，不是架构分析",
  },
  {
    id: "rename-ratchet",
    text: "把这个文件的函数改个名",
    expected: "MEDIUM",
    ctx: { long: true },
    why: "D-002 棘轮：long+动手意图曾顶到 REASONING",
  },
  {
    id: "vague-process",
    text: "帮我处理一下这个数据",
    expected: "MEDIUM",
    why: "taxonomy 规则 7：拿不准取低档",
  },
  // 疑问句形式的祈使句。SIMPLE 是最便宜的一档，欠档代价高于多花钱，
  // 故 isTrivialQuery 必须先被动手动词否决，不能只看句式。
  {
    id: "imperative-do-it",
    text: "Do it now.",
    expected: "MEDIUM",
    why: "祈使句；`^do\\b` 曾把它读成疑问句 → SIMPLE",
  },
  {
    id: "question-shaped-work-en",
    text: "can you make the retry logic more robust",
    expected: "MEDIUM",
    why: "疑问句式包裹的改动请求，曾落 SIMPLE",
  },
  {
    id: "question-shaped-work-zh",
    text: "如何让这套重试逻辑更健壮",
    expected: "MEDIUM",
    why: "同上，中文对照",
  },
  {
    id: "makes-is-not-mutation",
    text: "what makes this slow?",
    expected: "SIMPLE",
    why: "反向：`make` 加入动手动词表后不得误伤真查询",
  },
];

const COMPLEX_CASES: Case[] = [
  {
    id: "feature-endpoint",
    text: "帮我在 server.ts 加一个 /metrics 端点，输出各 tier 的请求计数",
    expected: "COMPLEX",
  },
  {
    id: "redesign",
    text: "重新设计分类器的分层架构，让语义层替换掉现在的启发式层",
    expected: "COMPLEX",
  },
  { id: "root-cause", text: "调用 /v1/messages 时偶发 502，帮我定位根因", expected: "COMPLEX" },
  { id: "code-review", text: "帮我 code review 一下最近这个 commit", expected: "COMPLEX" },
  { id: "deep-analysis", text: "深入分析这个模块的架构设计", expected: "COMPLEX" },
  { id: "decouple", text: "把分类逻辑和转发逻辑解耦成独立的责任链", expected: "COMPLEX" },
  { id: "security-audit", text: "帮我对这个端点做一次安全审计", expected: "COMPLEX" },
  { id: "audit-en", text: "audit this endpoint for injection risks", expected: "COMPLEX" },
  {
    id: "refactor-en",
    text: "refactor the adapter layer so each protocol is a separate strategy",
    expected: "COMPLEX",
  },
  {
    id: "proof-parser",
    text: "帮我写一个数学证明题的解析器",
    expected: "COMPLEX",
    gap: true,
    why: "造工具是工程活而非推导；但「写一个 X」的规模只能从语义读出，关键词层落 MEDIUM",
  },

  {
    id: "continue-deep-analysis",
    text: "继续深入分析这个模块的架构设计",
    expected: "COMPLEX",
    why: "D-002：reference 早于 complex 且命中即 return",
  },
  {
    id: "reference-rewrite",
    text: "上面的实现有 bug，重写整个调度器并补齐测试",
    expected: "COMPLEX",
    why: "同上，filler 遮蔽重活",
  },
  {
    id: "reference-audit",
    text: "刚才那个安全审计的结论帮我落成代码",
    expected: "COMPLEX",
    why: "同上",
  },
  {
    id: "zh-long-instruction",
    text: "帮我把这个模块的分层结构重新梳理一下，现在的实现里分类逻辑和转发逻辑耦合在一起，服务端启动时还要顺带初始化三个客户端，我希望拆成独立的责任链，每一层都能单测，并且保持现在的延迟水平不要退化，另外顺便把配置校验也挪出去。",
    expected: "COMPLEX",
    why: "D-002：split(/\\s+/) 对中文返回 1，长度维度失效",
  },
  {
    id: "en-long-instruction",
    text: "Please restructure the layering of this module, the classification logic and the forwarding logic are coupled together right now, and the server also initializes three clients at startup, I want them split into an independent chain of responsibility so each layer can be unit tested, while keeping the current latency, and please move config validation out too.",
    expected: "COMPLEX",
    why: "中文同义句的英文对照",
  },
];

const REASONING_CASES: Case[] = [
  { id: "proof-tree", text: "证明 n 个节点的二叉树高度下界是 log2(n+1)-1", expected: "REASONING" },
  { id: "proof-en", text: "prove this theorem by induction", expected: "REASONING" },
  { id: "induction-zh", text: "用数学归纳法证明这个递推式成立", expected: "REASONING" },
  { id: "derive-bound", text: "推导一下这个算法的时间复杂度上界", expected: "REASONING" },
  { id: "invariant", text: "论证这个循环不变式在每轮迭代后都成立", expected: "REASONING" },
  {
    id: "derive-en",
    text: "derive the closed form for this recurrence relation",
    expected: "REASONING",
  },
  // 中文推理词一旦被反向词否掉，Layer 1 的推理词表（纯英文）接不住，
  // 欠档不可恢复。反向词表因此只收「证明」的文书义，不收造物名词。
  {
    id: "derive-about-script",
    text: "推导一下这个脚本的复杂度",
    expected: "REASONING",
    why: "「脚本」曾在反向词表里，把真推导否成 MEDIUM",
  },
  {
    id: "prove-about-checker",
    text: "严格证明这个检查器不会漏报",
    expected: "REASONING",
    why: "同上，「检查器」",
  },
];

const ALL_CASES = [
  ["SIMPLE", SIMPLE_CASES],
  ["MEDIUM", MEDIUM_CASES],
  ["COMPLEX", COMPLEX_CASES],
  ["REASONING", REASONING_CASES],
] as const;

describe("tier regression (docs/plans/tier-taxonomy.md)", () => {
  for (const [group, cases] of ALL_CASES) {
    describe(group, () => {
      for (const c of cases) {
        const label = `${c.id}${c.why ? ` — ${c.why}` : ""}`;
        const run = async () => {
          const result = await classify(c.text, c.ctx);
          expect(result.tier, `${c.id}: "${c.text.slice(0, 40)}"`).toBe(c.expected);
        };
        if (c.gap) it.fails(label, run);
        else it(label, run);
      }
    });
  }
});
