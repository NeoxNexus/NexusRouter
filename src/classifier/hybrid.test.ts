import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HybridClassifier, type HybridConfig } from "../classifier/hybrid.js";
import { OllamaClient } from "../ollama/client.js";

describe("HybridClassifier", () => {
  const originalFetch = global.fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockFetch: any;
  let mockOllama: OllamaClient;
  let config: HybridConfig;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;

    mockOllama = new OllamaClient({ baseUrl: "http://localhost:11434" });
    config = {
      heuristicThreshold: 0.92,
      aiThreshold: 0.75,
      aiEnabled: true,
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("Layer 0: rule-based classification", () => {
    it("should return rule result for greetings", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("hello", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      expect(result.tier).toBe("SIMPLE");
      expect(result.layer).toBe("rule");
    });

    it("should return rule result for thanks", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("Thank you!", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      expect(result.tier).toBe("SIMPLE");
    });
  });

  describe("Layer 1: heuristic classification", () => {
    it("should use heuristic when confidence is high enough", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
      } as Response);

      const classifier = new HybridClassifier(mockOllama, config);

      // Long prompt with code should trigger MEDIUM or higher
      const result = await classifier.classify(
        "Write a function that sorts an array and returns the sorted result. Include proper error handling.",
        {
          messageCount: 1,
          hasSystemPrompt: false,
        },
      );

      // Should fall through to heuristic or AI or fallback
      expect(["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]).toContain(result.tier);
      expect(["rule", "heuristic", "ai", "fallback"]).toContain(result.layer);
    });
  });

  describe("Layer 2: AI classification", () => {
    it("should return AI layer when heuristic confidence is low", async () => {
      // The hybrid classifier will fall through layers until it finds a result
      const mockOllama = {
        classify: vi.fn().mockResolvedValue({
          tier: "MEDIUM",
          confidence: 0.88,
          latency: 10,
        }),
      } as unknown as OllamaClient;

      const classifier = new HybridClassifier(mockOllama, config);

      // Use a prompt that has low heuristic confidence
      const result = await classifier.classify("What is the weather like today?", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      // Should use AI layer or fallback
      expect(["ai", "fallback"]).toContain(result.layer);
    });
  });

  describe("Layer 2 gating via aiEnabled", () => {
    // 低置信中性句：Layer 0 不命中、Layer 1 置信 0.5 < 0.92，必走 Layer 2/3。
    const neutralPrompt = "process this data";
    const neutralContext = {
      messageCount: 1,
      hasSystemPrompt: false,
      hasTools: false,
    };

    it("never calls fetch and lands on Layer 3 when aiEnabled is false", async () => {
      const classifier = new HybridClassifier(mockOllama, {
        ...config,
        aiEnabled: false,
      });

      const result = await classifier.classify(neutralPrompt, neutralContext);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.layer).toBe("fallback");
      expect(result.reason).toBe("heuristic-uncertain");
      expect(result.tier).toBe("MEDIUM");
    });

    it("invokes Layer 2 as before when aiEnabled is true", async () => {
      const spyOllama = {
        classify: vi.fn().mockResolvedValue({
          tier: "MEDIUM",
          confidence: 0.88,
          latency: 10,
        }),
      } as unknown as OllamaClient;

      const classifier = new HybridClassifier(spyOllama, {
        ...config,
        aiEnabled: true,
      });

      const result = await classifier.classify(neutralPrompt, neutralContext);

      expect(spyOllama.classify).toHaveBeenCalledTimes(1);
      expect(result.layer).toBe("ai");
      expect(result.reason).toBe("ai-classified");
    });

    it("skips the Ollama client entirely when aiEnabled is false", async () => {
      const spyOllama = {
        classify: vi.fn(),
      } as unknown as OllamaClient;

      const classifier = new HybridClassifier(spyOllama, {
        ...config,
        aiEnabled: false,
      });

      const result = await classifier.classify(neutralPrompt, neutralContext);

      expect(spyOllama.classify).not.toHaveBeenCalled();
      expect(result.layer).toBe("fallback");
    });
  });

  describe("Layer 2 error reporting via onAiError", () => {
    it("reports only the first of consecutive AI classification failures", async () => {
      const failingAi = {
        classify: vi.fn().mockRejectedValue(new Error("OpenAI-compat request failed: 401")),
      } as unknown as OllamaClient;
      const onAiError = vi.fn();

      const classifier = new HybridClassifier(failingAi, {
        ...config,
        aiEnabled: true,
        onAiError,
      });

      // 连续两次低置信请求都走 Layer 2 并失败，onAiError 只在首个错误时触发。
      for (let i = 0; i < 2; i++) {
        const result = await classifier.classify("process this data", {
          messageCount: 1,
          hasSystemPrompt: false,
          hasTools: false,
        });
        expect(result.layer).toBe("fallback");
      }

      expect(failingAi.classify).toHaveBeenCalledTimes(2);
      expect(onAiError).toHaveBeenCalledTimes(1);
      expect(onAiError.mock.calls[0][0]).toBeInstanceOf(Error);
    });
  });

  describe("latency tracking", () => {
    it("should track latency for each layer", async () => {
      const mockResponse = {
        response: JSON.stringify({
          tier: "MEDIUM",
          confidence: 0.85,
        }),
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response);

      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("test prompt", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      expect(result.latency).toBeGreaterThanOrEqual(0);
    });
  });

  describe("multi-turn conversation handling", () => {
    it("should handle multi-turn conversations with simple final message", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      // 10 轮对话 + 简单最后消息
      const result = await classifier.classify("谢谢", {
        messageCount: 10,
        hasSystemPrompt: false,
      });

      // 多轮对话时，即使最后消息简单，也应该有适当的置信度
      expect(["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]).toContain(result.tier);
      // 验证返回了有效的置信度
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it("does not let messageCount change the tier (D-002)", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      // 「你好」命中 Layer 0 中文问候规则，无法到达启发式层；用无关键词
      // 的中性句观察 messageCount 的影响。
      const singleResult = await classifier.classify("帮我处理一下这个数据", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      const multiResult = await classifier.classify("帮我处理一下这个数据", {
        messageCount: 20,
        hasSystemPrompt: false,
      });

      // 会话长度只调置信度：真实 CC 流量 161/165 条都是长会话，恒定的信号
      // 不含难度信息。原先长会话会把档位顶上去，那是棘轮的第一级。
      // （置信度差在此不可见：兜底路径统一压成 0.5，标记「这一层拿不准」。）
      expect(singleResult.tier).toBe("MEDIUM");
      expect(multiResult.tier).toBe("MEDIUM");
    });

    it("should handle reference to previous context", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      // 引用上文的请求 - 这类请求实际上可能需要更高级的模型
      const result = await classifier.classify("用上面的代码写一个测试", {
        messageCount: 5,
        hasSystemPrompt: false,
      });

      // 这类请求应该被识别，可能触发更高 tier
      expect(["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]).toContain(result.tier);
    });

    it("should handle 'continue' or 'continue with' requests", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("继续完善那个函数", {
        messageCount: 8,
        hasSystemPrompt: false,
      });

      // 继续类请求通常需要理解前文
      expect(["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]).toContain(result.tier);
    });
  });

  describe("system prompt impact", () => {
    it("should handle requests with system prompt", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("解释一下量子计算", {
        messageCount: 1,
        hasSystemPrompt: true, // 有系统提示词
      });

      // 有系统提示词时，置信度应该有所提升
      expect(["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]).toContain(result.tier);
      expect(result.confidence).toBeGreaterThan(0);
    });

    it("should handle requests without system prompt", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("解释一下量子计算", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      expect(["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]).toContain(result.tier);
    });
  });

  describe("edge cases", () => {
    it("should handle empty message", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      // 空消息应该有默认处理
      expect(result.tier).toBeDefined();
      expect(result.confidence).toBeGreaterThan(0);
    });

    it("should handle very long prompt", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      // 超长提示词 (模拟 > 200 词)
      const longPrompt = "Write " + "a ".repeat(500) + "function";
      const result = await classifier.classify(longPrompt, {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      // 长提示词应该触发更高 tier
      expect(["MEDIUM", "COMPLEX", "REASONING"]).toContain(result.tier);
    });

    it("should handle special characters only", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("!!!???...", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      // 特殊字符应该被合理处理
      expect(result.tier).toBeDefined();
    });

    it("should handle multi-language mixed content", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("请 write a function 计算总和", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      expect(["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]).toContain(result.tier);
    });
  });

  describe("reasoning keywords detection", () => {
    it("should detect reasoning keywords like prove, theorem", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("Prove that the sum of two even numbers is even", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      // 包含证明/定理关键词应该触发 REASONING
      expect(result.tier).toBe("REASONING");
    });

    it("should detect mathematical keywords", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("Calculate the derivative of f(x) = x^2 + 2x", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      // 数学计算应该触发 REASONING
      expect(result.tier).toBe("REASONING");
    });

    it("should detect complex analysis keywords", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify(
        "Analyze the security implications of this architecture",
        {
          messageCount: 1,
          hasSystemPrompt: false,
        },
      );

      // 分析安全影响应该触发 COMPLEX
      expect(result.tier).toBe("COMPLEX");
    });
  });

  describe("code pattern detection", () => {
    it("should detect code blocks in prompt", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify(
        "Explain this code:\n```python\ndef hello():\n    print('world')\n```",
        {
          messageCount: 1,
          hasSystemPrompt: false,
        },
      );

      // 代码块应该触发更高 tier
      expect(["MEDIUM", "COMPLEX", "REASONING"]).toContain(result.tier);
    });

    it("should detect function definition", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("Write a function that calculates factorial", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      expect(["MEDIUM", "COMPLEX", "REASONING"]).toContain(result.tier);
    });

    it("should detect class definition", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("Create a class for managing user authentication", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      expect(["MEDIUM", "COMPLEX", "REASONING"]).toContain(result.tier);
    });
  });

  describe("tool presence: capability is not complexity", () => {
    // Claude Code attaches its full tool table to every request, so hasTools is
    // a constant for that traffic. Tier must be driven by the prompt instead.
    it("keeps a greeting SIMPLE even with a tool table attached", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("hi", {
        messageCount: 1,
        hasSystemPrompt: false,
        hasTools: true,
      });

      expect(result.tier).toBe("SIMPLE");
      expect(result.reason).toBe("greeting");
    });

    it("keeps thanks SIMPLE even with a tool table attached", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("thanks", {
        messageCount: 1,
        hasSystemPrompt: false,
        hasTools: true,
      });

      expect(result.tier).toBe("SIMPLE");
      expect(result.reason).toBe("thanks");
    });

    it("does not reach a rule verdict from tool presence alone", async () => {
      mockFetch.mockResolvedValue({ ok: false } as Response);

      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("process this data", {
        messageCount: 1,
        hasSystemPrompt: false,
        hasTools: true,
      });

      expect(result.layer).not.toBe("rule");
      expect(result.reason).not.toBe("has-tools");
    });

    it("raises the tier to at least MEDIUM when the turn actually requires a tool", async () => {
      mockFetch.mockResolvedValue({ ok: false } as Response);

      const classifier = new HybridClassifier(mockOllama, config);
      const context = {
        messageCount: 1,
        hasSystemPrompt: false,
        hasTools: true,
      };

      // 平凡查询（疑问句、不碰项目物件）在启发式层落 SIMPLE；同一句加上
      // 动手意图后抬到 MEDIUM 下限。用 requiresTools 而非 hasTools：后者对
      // Claude Code 恒真。
      const idle = await classifier.classify("what does this setting do?", {
        ...context,
        requiresTools: false,
      });
      const acting = await classifier.classify("what does this setting do?", {
        ...context,
        requiresTools: true,
      });

      // Asserting the layer matters: the previous version of this test passed
      // while Layer 0 short-circuited, so Layer 1 was never exercised.
      expect(acting.layer).not.toBe("rule");
      expect(idle.tier).toBe("SIMPLE");
      expect(acting.tier).toBe("MEDIUM");
    });

    it("does not stack the requiresTools floor onto an already higher tier (D-002)", async () => {
      mockFetch.mockResolvedValue({ ok: false } as Response);

      const classifier = new HybridClassifier(mockOllama, config);
      const context = {
        messageCount: 1,
        hasSystemPrompt: false,
        hasTools: true,
      };

      // 非平凡文本在启发式层已是 MEDIUM；动手意图是下限而非增量，故不动。
      const idle = await classifier.classify("帮我处理一下这个数据", {
        ...context,
        requiresTools: false,
      });
      const acting = await classifier.classify("帮我处理一下这个数据", {
        ...context,
        requiresTools: true,
      });

      expect(idle.tier).toBe("MEDIUM");
      expect(acting.tier).toBe("MEDIUM");
    });

    it("does not downgrade REASONING when tools are present", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("prove this theorem", {
        messageCount: 1,
        hasSystemPrompt: false,
        hasTools: true,
        requiresTools: true,
      });

      expect(result.tier).toBe("REASONING");
    });
  });

  describe("reasoning keywords match whole words only", () => {
    // `includes()` matching made "improve" (contains "prove") read as a
    // reasoning request. Claude Code injects "improve" on every turn via its
    // skill list, which pinned all its traffic to the most expensive tier.
    it.each([
      ["improve", "improve this function"],
      ["improvement", "suggest an improvement"],
      ["improved", "the improved version"],
      ["improves", "this improves nothing"],
      ["approve", "the user will approve or deny the execution"],
      ["disprove", "disprove is a substring trap"],
      ["proofread", "proofread this paragraph"],
    ])("does not treat %s as a reasoning keyword", async (_label, prompt) => {
      mockFetch.mockResolvedValue({ ok: false } as Response);

      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify(prompt, {
        messageCount: 1,
        hasSystemPrompt: false,
        hasTools: true,
      });

      expect(result.reason).not.toBe("reasoning-keyword");
      expect(result.tier).not.toBe("REASONING");
    });

    // D-002 收紧词表后新增的反向用例：这些词的日常义压倒推理义。
    // `derived`/`logical` 是继承术语与形容词，`mathematical` 单独出现只是
    // 学科名 —— 需要它们时用词组（mathematical proof / logically follows）。
    it.each([
      ["derived", "the derived class overrides it"],
      ["logical", "is this logical"],
      ["logically", "explain this logically"],
      ["mathematical", "a mathematical problem"],
    ])("no longer treats bare %s as a reasoning keyword", async (_label, prompt) => {
      mockFetch.mockResolvedValue({ ok: false } as Response);

      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify(prompt, {
        messageCount: 1,
        hasSystemPrompt: false,
        hasTools: true,
      });

      expect(result.reason).not.toBe("reasoning-keyword");
      expect(result.tier).not.toBe("REASONING");
    });

    it.each([
      ["prove", "prove this identity"],
      ["proves", "this proves the claim"],
      ["proved", "she proved the lemma"],
      ["proving", "proving by induction"],
      ["theorem", "state the theorem"],
      ["theorems", "the theorems in the appendix"],
      ["lemma", "state the lemma"],
      ["proof", "walk me through the proof"],
      ["proofs", "are the proofs correct"],
      ["derive", "derive the closed form"],
      ["mathematically", "show it mathematically"],
      ["mathematical proof", "give a mathematical proof"],
      ["logically follows", "show it logically follows"],
      ["by induction", "do it by induction"],
      ["show that", "show that the series converges"],
    ])("still treats %s as a reasoning keyword", async (_label, prompt) => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify(prompt, {
        messageCount: 1,
        hasSystemPrompt: false,
        hasTools: true,
      });

      expect(result.reason).toBe("reasoning-keyword");
      expect(result.tier).toBe("REASONING");
    });
  });

  describe("Chinese keyword detection (Layer 0)", () => {
    // `\b` is meaningless for Chinese, so ZH keywords go through `includes()`
    // on a parallel path; either path landing counts as a rule hit.
    it("detects Chinese reasoning keywords via includes matching", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      // 裸词「证明」已移出词表（会误伤「工作证明」类文书请求），
      // 用仍命中的具体词组「严格证明」验证 includes 通路。
      const result = await classifier.classify("严格证明这个贪心算法的正确性", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      expect(result.tier).toBe("REASONING");
      expect(result.reason).toBe("reasoning-keyword");
      expect(result.layer).toBe("rule");
    });

    it("detects Chinese complex keywords via includes matching", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("分析一下这个模块的安全隐患", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      expect(result.tier).toBe("COMPLEX");
      expect(result.reason).toBe("complex-keyword");
      expect(result.layer).toBe("rule");
    });

    it("still matches English reasoning keywords in mixed-language prompts", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("请帮我 prove 这个引理", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      expect(result.tier).toBe("REASONING");
      expect(result.reason).toBe("reasoning-keyword");
    });

    it("matches Chinese complex keywords in mixed-language prompts", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("review 这段代码的设计模式", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      expect(result.tier).toBe("COMPLEX");
      expect(result.reason).toBe("complex-keyword");
    });

    it("does not treat mixed text as reasoning via English substrings", async () => {
      mockFetch.mockResolvedValue({ ok: false } as Response);

      const classifier = new HybridClassifier(mockOllama, config);

      // "improve" contains "prove"; no Chinese reasoning keyword present.
      const result = await classifier.classify("improve 这段代码的可读性", {
        messageCount: 1,
        hasSystemPrompt: false,
        hasTools: true,
      });

      expect(result.reason).not.toBe("reasoning-keyword");
      expect(result.tier).not.toBe("REASONING");
    });

    it("does not treat a bare 重构 request as a complex-keyword rule hit", async () => {
      mockFetch.mockResolvedValue({ ok: false } as Response);

      const classifier = new HybridClassifier(mockOllama, config);

      // 裸词「重构」已移出词表：常规重构请求不再被 Layer 0 直接定 COMPLEX，
      // 走后续层（启发式低置信 → Layer 3 兜底升档）。
      const result = await classifier.classify("帮我重构这个函数", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      expect(result.layer).not.toBe("rule");
      expect(result.reason).not.toBe("complex-keyword");
      expect(result.tier).not.toBe("COMPLEX");
    });

    it("does not treat 工作证明 (paperwork) as a reasoning keyword", async () => {
      mockFetch.mockResolvedValue({ ok: false } as Response);

      const classifier = new HybridClassifier(mockOllama, config);

      // 「工作证明」的「证明」是文书语义；词表只收严格证明/数学证明等词组。
      const result = await classifier.classify("开具工作证明所需材料", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      expect(result.reason).not.toBe("reasoning-keyword");
      expect(result.tier).not.toBe("REASONING");
    });
  });

  describe("Chinese greeting/thanks (Layer 0)", () => {
    // 与英文同策略：整句匹配才短路到 SIMPLE，寒暄+正文走完整分类。
    it("routes 你好 to SIMPLE as a greeting", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("你好", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      expect(result.tier).toBe("SIMPLE");
      expect(result.layer).toBe("rule");
      expect(result.reason).toBe("greeting");
    });

    it("routes 谢谢 to SIMPLE as thanks", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("谢谢", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      expect(result.tier).toBe("SIMPLE");
      expect(result.layer).toBe("rule");
      expect(result.reason).toBe("thanks");
    });

    it("does not short-circuit a greeting followed by real content", async () => {
      mockFetch.mockResolvedValue({ ok: false } as Response);

      const classifier = new HybridClassifier(mockOllama, config);

      // 寒暄+正文不该短路到 SIMPLE——正则整句锚定，这句走完整分类。
      const result = await classifier.classify("你好，帮我分析下这个架构", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      expect(result.reason).not.toBe("greeting");
      expect(result.layer).not.toBe("rule");
    });
  });

  describe("classification reason (observability)", () => {
    it("should report greeting for greeting patterns", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("hello", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      expect(result.reason).toBe("greeting");
    });

    it("should report thanks for gratitude patterns", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("thanks", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      expect(result.reason).toBe("thanks");
    });

    it("should report reasoning-keyword when tools are also present", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("prove this theorem", {
        messageCount: 1,
        hasSystemPrompt: false,
        hasTools: true,
      });

      expect(result.reason).toBe("reasoning-keyword");
    });

    it("should report reference-pattern when tools are also present", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("继续修改上面的文件", {
        messageCount: 1,
        hasSystemPrompt: false,
        hasTools: true,
      });

      expect(result.reason).toBe("reference-pattern");
    });

    it("should report complex-keyword for complexity keywords without tools", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("analyze the security of this", {
        messageCount: 1,
        hasSystemPrompt: false,
        hasTools: false,
      });

      expect(result.reason).toBe("complex-keyword");
    });

    it("should report heuristic-uncertain when no layer reaches its threshold", async () => {
      mockFetch.mockResolvedValue({ ok: false } as Response);

      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("process this data", {
        messageCount: 1,
        hasSystemPrompt: false,
        hasTools: false,
      });

      expect(result.layer).toBe("fallback");
      expect(result.reason).toBe("heuristic-uncertain");
    });
  });

  describe("Layer 3: no unconditional upgrade (D-002)", () => {
    // 曾在此无条件 upgradeTier。但 Layer 1 的置信度门不可达（上限 0.8 <
    // 0.92），绝大多数流量落到兜底并集体 +1，叠加 Layer 1 内两处升档后真实
    // CC 流量恒落最高两档。兜底现在照原样返回启发式档位：升档必须由具体
    // 信号驱动，不得由「没有信号」驱动。
    beforeEach(() => {
      mockFetch.mockResolvedValue({ ok: false } as Response);
    });

    it("keeps the heuristic tier instead of upgrading it", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("process this data", {
        messageCount: 1,
        hasSystemPrompt: false,
        hasTools: false,
      });

      expect(result.layer).toBe("fallback");
      expect(result.tier).toBe("MEDIUM");
      expect(result.confidence).toBe(0.5);
      expect(result.reason).toBe("heuristic-uncertain");
    });

    it("keeps a length-driven MEDIUM at MEDIUM", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      // 51 个无关键词中性词 → 启发式 MEDIUM (0.65)，低于阈值走兜底。
      const prompt =
        "The quarterly report shows steady growth across all regional markets " +
        "with notable gains in customer retention and operational efficiency " +
        "during the first half of the fiscal year according to preliminary " +
        "internal estimates shared by department heads last week along with " +
        "hiring plans and budget adjustments for the coming months ahead overall";
      const result = await classifier.classify(prompt, {
        messageCount: 1,
        hasSystemPrompt: false,
        hasTools: false,
      });

      expect(result.layer).toBe("fallback");
      expect(result.tier).toBe("MEDIUM");
      expect(result.reason).toBe("heuristic-uncertain");
    });

    it("keeps a length-driven COMPLEX at COMPLEX", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      // 270 个无关键词中性词 → 启发式 COMPLEX (0.7)，低于阈值走兜底。
      const prompt = Array(30).fill("the quick brown fox jumps over the lazy dog").join(" ");
      const result = await classifier.classify(prompt, {
        messageCount: 1,
        hasSystemPrompt: false,
        hasTools: false,
      });

      expect(result.layer).toBe("fallback");
      expect(result.tier).toBe("COMPLEX");
      expect(result.reason).toBe("heuristic-uncertain");
    });

    it("keeps a heuristic REASONING at REASONING", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      // "calculate" 只在启发式词表中（Layer 0 不收），给出 REASONING 0.85，
      // 低于 0.92 阈值走兜底。
      const result = await classifier.classify("calculate the total energy consumption", {
        messageCount: 1,
        hasSystemPrompt: false,
        hasTools: false,
      });

      expect(result.layer).toBe("fallback");
      expect(result.tier).toBe("REASONING");
      expect(result.reason).toBe("heuristic-uncertain");
    });
  });

  describe("conversation length detection", () => {
    it("does not raise the tier for a long conversation (D-002)", async () => {
      mockFetch.mockResolvedValue({ ok: false } as Response);

      const classifier = new HybridClassifier(mockOllama, config);

      // 「好的」现在命中 Layer 0 确认语规则 —— 整句即全部内容，不含任务。
      // 长会话不再把它顶上去。
      const ack = await classifier.classify("好的", {
        messageCount: 10,
        hasSystemPrompt: false,
        hasTools: false,
        conversationLength: "long",
      });
      expect(ack.tier).toBe("SIMPLE");
      expect(ack.reason).toBe("acknowledgement");

      // 走到启发式层的中性句同样不因会话长度变档。
      const neutral = await classifier.classify("帮我处理一下这个数据", {
        messageCount: 10,
        hasSystemPrompt: false,
        hasTools: false,
        conversationLength: "long",
      });
      expect(neutral.layer).not.toBe("rule");
      expect(neutral.tier).toBe("MEDIUM");
    });

    it("should maintain high confidence for long conversation", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
      } as Response);

      const classifier = new HybridClassifier(mockOllama, config);

      const short = await classifier.classify("你好", {
        messageCount: 1,
        hasSystemPrompt: false,
        conversationLength: "short",
      });
      const long = await classifier.classify("你好", {
        messageCount: 10,
        hasSystemPrompt: false,
        conversationLength: "long",
      });

      expect(long.confidence).toBeGreaterThanOrEqual(short.confidence);
    });

    it("should not upgrade at Layer 1 for short conversation", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      // 「你好」现在命中 Layer 0 中文问候规则；改用无关键词的中性句。
      const result = await classifier.classify("帮我处理一下这个数据", {
        messageCount: 1,
        hasSystemPrompt: false,
        hasTools: false,
        conversationLength: "short",
      });

      // 短对话在启发式层保持 SIMPLE（无 conversationLength 提升）；
      // 最终呈现的 MEDIUM 完全来自低置信兜底的升档。
      expect(result.tier).toBe("MEDIUM");
    });
  });

  describe("reference pattern detection", () => {
    it("should detect Chinese reference patterns", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("用上面的代码写一个测试", {
        messageCount: 5,
        hasSystemPrompt: false,
        hasTools: false,
      });

      // 应该从 SIMPLE 提升到 MEDIUM
      expect(result.tier).not.toBe("SIMPLE");
    });

    it("should detect English reference patterns", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("continue with the above code", {
        messageCount: 5,
        hasSystemPrompt: false,
        hasTools: false,
      });

      expect(result.tier).not.toBe("SIMPLE");
    });

    it("should detect 'that file' pattern", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("edit that function", {
        messageCount: 3,
        hasSystemPrompt: false,
        hasTools: false,
      });

      expect(result.tier).not.toBe("SIMPLE");
    });
  });

  // Tuning material: `reason` names the rule category but not the token that
  // fired it. D-001 (the skills list containing "improve", matching "prove")
  // was only found by reading source, not logs.
  describe("tuning observability", () => {
    it("reports which keyword fired a rule hit", async () => {
      const classifier = new HybridClassifier(mockOllama, { ...config, aiEnabled: false });

      const result = await classifier.classify("请帮我证明这个算法的正确性", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      expect(result.layer).toBe("rule");
      expect(result.reason).toBe("reasoning-keyword");
      expect(result.matched).toBe("证明");
    });

    it("keeps the real heuristic score on the fallback path", async () => {
      const classifier = new HybridClassifier(mockOllama, { ...config, aiEnabled: false });

      const result = await classifier.classify("给这个函数补几个单元测试", {
        messageCount: 12,
        hasSystemPrompt: true,
        hasTools: true,
        requiresTools: true,
        conversationLength: "long",
      });

      // Layer 3 reports 0.5 so downstream cannot mistake a fallback for a
      // confident call, but the score that missed heuristicThreshold is the
      // only input for deciding whether that threshold is reachable (4.6).
      expect(result.layer).toBe("fallback");
      expect(result.confidence).toBe(0.5);
      expect(result.heuristicScore).toBeGreaterThan(0.5);
      expect(result.heuristicScore).toBeLessThan(config.heuristicThreshold);
    });
  });
});
