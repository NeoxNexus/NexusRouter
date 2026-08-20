import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OllamaClient } from "../ollama/client.js";

describe("OllamaClient", () => {
  const originalFetch = global.fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockFetch: any;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("healthCheck", () => {
    it("should return true when Ollama is available", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      const client = new OllamaClient({ baseUrl: "http://localhost:11434" });
      const result = await client.healthCheck();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith("http://localhost:11434/api/tags");
    });

    it("should return false when Ollama is not available", async () => {
      mockFetch.mockRejectedValue(new Error("Connection refused"));

      const client = new OllamaClient({ baseUrl: "http://localhost:11434" });
      const result = await client.healthCheck();

      expect(result).toBe(false);
    });

    it("should return false when API returns error", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      const client = new OllamaClient({ baseUrl: "http://localhost:11434" });
      const result = await client.healthCheck();

      expect(result).toBe(false);
    });
  });

  describe("classify", () => {
    it("should return classification result with latency", async () => {
      const mockResponse = {
        response: JSON.stringify({
          tier: "SIMPLE",
          confidence: 0.95,
        }),
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response);

      const client = new OllamaClient({ baseUrl: "http://localhost:11434" });
      const context = {
        messageCount: 1,
        hasSystemPrompt: false,
      };

      const result = await client.classify("Hello", context);

      expect(result.tier).toBe("SIMPLE");
      expect(result.confidence).toBe(0.95);
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });

    it("should send the configured model and keep_alive in the request body", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            response: JSON.stringify({ tier: "MEDIUM", confidence: 0.8 }),
          }),
      } as Response);

      const client = new OllamaClient({
        baseUrl: "http://localhost:11434",
        model: "qwen3:4b",
      });
      await client.classify("test", { messageCount: 1, hasSystemPrompt: false });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:11434/api/generate");
      const body = JSON.parse(init.body);
      expect(body.model).toBe("qwen3:4b");
      expect(body.keep_alive).toBe("30m");
      expect(body.format).toBe("json");
      expect(body.prompt).toContain("no explanation");
    });

    it("should fall back to the historical default model when none is given", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            response: JSON.stringify({ tier: "SIMPLE", confidence: 0.9 }),
          }),
      } as Response);

      const client = new OllamaClient({ baseUrl: "http://localhost:11434" });
      await client.classify("test", { messageCount: 1, hasSystemPrompt: false });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe("qwen2.5:3b");
    });

    it("should handle network errors gracefully", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      const client = new OllamaClient({ baseUrl: "http://localhost:11434" });

      await expect(
        client.classify("test", { messageCount: 1, hasSystemPrompt: false }),
      ).rejects.toThrow("Network error");
    });

    it("should throw timeout error when request exceeds timeout", async () => {
      // Mock fetch that rejects with AbortError after a delay
      mockFetch.mockImplementation(() =>
        new Promise((_, reject) => {
          setTimeout(() => {
            const error = new Error("Aborted");
            error.name = "AbortError";
            reject(error);
          }, 50);
        })
      );

      const client = new OllamaClient({ baseUrl: "http://localhost:11434", timeout: 10 }); // 10ms timeout

      await expect(
        client.classify("test", { messageCount: 1, hasSystemPrompt: false }),
      ).rejects.toThrow("Request timeout");
    });

    it("should throw error for invalid JSON response", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: "not valid json" }),
      } as Response);

      const client = new OllamaClient({ baseUrl: "http://localhost:11434" });

      await expect(
        client.classify("test", { messageCount: 1, hasSystemPrompt: false }),
      ).rejects.toThrow("Invalid Ollama response");
    });
  });
});
