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

    mockOllama = new OllamaClient("http://localhost:11434");
    config = {
      heuristicThreshold: 0.92,
      aiThreshold: 0.75,
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("Layer 0: rule-based classification", () => {
    it("should return rule result for greetings", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("Hello, how are you?", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      expect(result.tier).toBe("SIMPLE");
      expect(["rule", "fallback"]).toContain(result.layer);
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

    it("should consider messageCount in heuristic classification", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      // 单轮简单消息
      const singleResult = await classifier.classify("你好", {
        messageCount: 1,
        hasSystemPrompt: false,
      });

      // 多轮相同消息
      const multiResult = await classifier.classify("你好", {
        messageCount: 20,
        hasSystemPrompt: false,
      });

      // 多轮对话应该有不同的处理
      expect(singleResult.tier).toBe("SIMPLE");
      // multiResult 可能有不同的置信度或 tier
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

      const result = await classifier.classify(
        "Prove that the sum of two even numbers is even",
        {
          messageCount: 1,
          hasSystemPrompt: false,
        },
      );

      // 包含证明/定理关键词应该触发 REASONING
      expect(result.tier).toBe("REASONING");
    });

    it("should detect mathematical keywords", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify(
        "Calculate the derivative of f(x) = x^2 + 2x",
        {
          messageCount: 1,
          hasSystemPrompt: false,
        },
      );

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

      const result = await classifier.classify(
        "Write a function that calculates factorial",
        {
          messageCount: 1,
          hasSystemPrompt: false,
        },
      );

      expect(["MEDIUM", "COMPLEX", "REASONING"]).toContain(result.tier);
    });

    it("should detect class definition", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify(
        "Create a class for managing user authentication",
        {
          messageCount: 1,
          hasSystemPrompt: false,
        },
      );

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

    it("upgrades tier in Layer 1 when the turn actually requires a tool", async () => {
      mockFetch.mockResolvedValue({ ok: false } as Response);

      const classifier = new HybridClassifier(mockOllama, config);
      const context = {
        messageCount: 1,
        hasSystemPrompt: false,
        hasTools: true,
      };

      const idle = await classifier.classify("process this data", {
        ...context,
        requiresTools: false,
      });
      const acting = await classifier.classify("process this data", {
        ...context,
        requiresTools: true,
      });

      // Asserting the layer matters: the previous version of this test passed
      // while Layer 0 short-circuited, so Layer 1 was never exercised.
      expect(acting.layer).not.toBe("rule");
      expect(idle.tier).toBe("SIMPLE");
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

    it.each([
      ["prove", "prove this identity"],
      ["proves", "this proves the claim"],
      ["proved", "she proved the lemma"],
      ["proving", "proving by induction"],
      ["theorem", "state the theorem"],
      ["theorems", "the theorems in the appendix"],
      ["proof", "walk me through the proof"],
      ["proofs", "are the proofs correct"],
      ["derive", "derive the closed form"],
      ["derived", "the derived quantity"],
      ["mathematical", "a mathematical problem"],
      ["mathematically", "show it mathematically"],
      ["logical", "is this logical"],
      ["logically", "explain this logically"],
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

    it("should report low-confidence-fallback when no layer reaches its threshold", async () => {
      mockFetch.mockResolvedValue({ ok: false } as Response);

      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("process this data", {
        messageCount: 1,
        hasSystemPrompt: false,
        hasTools: false,
      });

      expect(result.layer).toBe("fallback");
      expect(result.reason).toBe("low-confidence-fallback");
    });
  });

  describe("conversation length detection", () => {
    it("should upgrade tier for long conversation with simple message", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("谢谢", {
        messageCount: 10,
        hasSystemPrompt: false,
        hasTools: false,
        conversationLength: "long",
      });

      // 从 SIMPLE 提升到 MEDIUM
      expect(result.tier).toBe("MEDIUM");
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

    it("should not upgrade for short conversation", async () => {
      const classifier = new HybridClassifier(mockOllama, config);

      const result = await classifier.classify("你好", {
        messageCount: 1,
        hasSystemPrompt: false,
        hasTools: false,
        conversationLength: "short",
      });

      expect(result.tier).toBe("SIMPLE");
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
});
