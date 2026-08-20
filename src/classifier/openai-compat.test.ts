import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAICompatClassifier } from "../classifier/openai-compat.js";

describe("OpenAICompatClassifier", () => {
  const originalFetch = global.fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockFetch: any;

  const context = { messageCount: 2, hasSystemPrompt: true };

  function mockChatResponse(content: string) {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { role: "assistant", content } }],
        }),
    } as Response);
  }

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("request shape", () => {
    it("posts to {baseUrl}/chat/completions with the OpenAI chat body", async () => {
      mockChatResponse(JSON.stringify({ tier: "SIMPLE", confidence: 0.9 }));

      const client = new OpenAICompatClassifier({
        baseUrl: "https://new-api.example.com/v1",
        apiKey: "sk-gateway",
        model: "gpt-4o-mini",
      });
      await client.classify("hello there", context);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://new-api.example.com/v1/chat/completions");
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe("application/json");
      expect(init.headers["Authorization"]).toBe("Bearer sk-gateway");

      const body = JSON.parse(init.body);
      expect(body.model).toBe("gpt-4o-mini");
      expect(body.temperature).toBe(0);
      expect(body.max_tokens).toBe(50);
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe("system");
      expect(body.messages[0].content).toContain("SIMPLE, MEDIUM, COMPLEX, REASONING");
      expect(body.messages[1].role).toBe("user");
      expect(body.messages[1].content).toContain("hello there");
      expect(body.messages[1].content).toContain("Message count: 2");
      expect(body.messages[1].content).toContain("no explanation");
    });

    it("strips trailing slashes from baseUrl", async () => {
      mockChatResponse(JSON.stringify({ tier: "SIMPLE", confidence: 0.9 }));

      const client = new OpenAICompatClassifier({
        baseUrl: "http://vllm.internal:8000/v1/",
        model: "qwen3-4b",
      });
      await client.classify("test", context);

      expect(mockFetch.mock.calls[0][0]).toBe("http://vllm.internal:8000/v1/chat/completions");
    });

    it("omits the Authorization header when apiKey is empty", async () => {
      mockChatResponse(JSON.stringify({ tier: "SIMPLE", confidence: 0.9 }));

      const client = new OpenAICompatClassifier({
        baseUrl: "http://vllm.internal:8000/v1",
        model: "qwen3-4b",
      });
      await client.classify("test", context);

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers["Authorization"]).toBeUndefined();
      expect(headers["Content-Type"]).toBe("application/json");
    });
  });

  describe("response parsing", () => {
    it("parses a plain JSON classification", async () => {
      mockChatResponse(JSON.stringify({ tier: "COMPLEX", confidence: 0.92 }));

      const client = new OpenAICompatClassifier({
        baseUrl: "http://localhost:8000/v1",
        model: "m",
      });
      const result = await client.classify("test", context);

      expect(result.tier).toBe("COMPLEX");
      expect(result.confidence).toBe(0.92);
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });

    it("parses JSON wrapped in a ```json code fence", async () => {
      mockChatResponse('```json\n{"tier": "REASONING", "confidence": 0.85}\n```');

      const client = new OpenAICompatClassifier({
        baseUrl: "http://localhost:8000/v1",
        model: "m",
      });
      const result = await client.classify("test", context);

      expect(result.tier).toBe("REASONING");
      expect(result.confidence).toBe(0.85);
    });

    it("defaults confidence to 0.8 when the model omits it", async () => {
      mockChatResponse(JSON.stringify({ tier: "MEDIUM" }));

      const client = new OpenAICompatClassifier({
        baseUrl: "http://localhost:8000/v1",
        model: "m",
      });
      const result = await client.classify("test", context);

      expect(result.tier).toBe("MEDIUM");
      expect(result.confidence).toBe(0.8);
    });

    it("throws when the tier is not one of the four valid tiers", async () => {
      mockChatResponse(JSON.stringify({ tier: "HARD", confidence: 0.9 }));

      const client = new OpenAICompatClassifier({
        baseUrl: "http://localhost:8000/v1",
        model: "m",
      });

      await expect(client.classify("test", context)).rejects.toThrow("unknown tier");
    });

    it("throws when the content is not valid JSON", async () => {
      mockChatResponse("The request seems medium-ish to me");

      const client = new OpenAICompatClassifier({
        baseUrl: "http://localhost:8000/v1",
        model: "m",
      });

      await expect(client.classify("test", context)).rejects.toThrow(
        "Invalid OpenAI-compat response",
      );
    });

    it("throws when the response has no choices[0].message.content", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [] }),
      } as Response);

      const client = new OpenAICompatClassifier({
        baseUrl: "http://localhost:8000/v1",
        model: "m",
      });

      await expect(client.classify("test", context)).rejects.toThrow(
        "missing choices[0].message.content",
      );
    });
  });

  describe("error handling", () => {
    it("throws on non-ok HTTP responses", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 429 } as Response);

      const client = new OpenAICompatClassifier({
        baseUrl: "http://localhost:8000/v1",
        model: "m",
      });

      await expect(client.classify("test", context)).rejects.toThrow(
        "OpenAI-compat request failed: 429",
      );
    });

    it("wraps network errors in the Classification failed style", async () => {
      mockFetch.mockRejectedValue(new Error("Connection refused"));

      const client = new OpenAICompatClassifier({
        baseUrl: "http://localhost:8000/v1",
        model: "m",
      });

      await expect(client.classify("test", context)).rejects.toThrow(
        "Classification failed: Connection refused",
      );
    });

    it("throws a timeout error when the request exceeds the timeout", async () => {
      mockFetch.mockImplementation(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => {
              const error = new Error("Aborted");
              error.name = "AbortError";
              reject(error);
            }, 50);
          }),
      );

      const client = new OpenAICompatClassifier({
        baseUrl: "http://localhost:8000/v1",
        model: "m",
        timeout: 10,
      });

      await expect(client.classify("test", context)).rejects.toThrow("Request timeout");
    });
  });

  describe("healthCheck", () => {
    it("returns true when the gateway lists models", async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 } as Response);

      const client = new OpenAICompatClassifier({
        baseUrl: "http://localhost:8000/v1",
        apiKey: "sk-gateway",
        model: "m",
      });

      expect(await client.healthCheck()).toBe(true);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8000/v1/models");
      expect(init.headers["Authorization"]).toBe("Bearer sk-gateway");
    });

    it("returns false when the gateway is unreachable", async () => {
      mockFetch.mockRejectedValue(new Error("Connection refused"));

      const client = new OpenAICompatClassifier({
        baseUrl: "http://localhost:8000/v1",
        model: "m",
      });

      expect(await client.healthCheck()).toBe(false);
    });
  });
});
