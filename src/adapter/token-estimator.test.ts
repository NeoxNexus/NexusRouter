import { describe, it, expect } from "vitest";
import { estimateTokenCount, extractRequestText, providerFromModel } from "./token-estimator.js";

describe("providerFromModel", () => {
  it("maps known families", () => {
    expect(providerFromModel("openai/gpt-4o")).toBe("openai");
    expect(providerFromModel("anthropic/claude-sonnet-4-20250514")).toBe("claude");
    expect(providerFromModel("google/gemini-1.5-pro")).toBe("gemini");
    expect(providerFromModel("openai-compat/qwen")).toBe("openai");
  });

  it("falls back to openai for unknown providers", () => {
    expect(providerFromModel("minimax/text-01")).toBe("openai");
    expect(providerFromModel("")).toBe("openai");
  });
});

describe("estimateTokenCount — character classes", () => {
  it("counts CJK higher than ASCII per character", () => {
    const ascii = "a".repeat(100);
    const cjk = "中".repeat(100);
    expect(estimateTokenCount(cjk, "claude")).toBeGreaterThan(estimateTokenCount(ascii, "claude"));
  });

  it("treats consecutive Latin letters as one token-like unit", () => {
    // First word token + spaces. Should be roughly ceil(Word + 4*Space).
    const tokens = estimateTokenCount("word word word word", "openai");
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(18); // generous upper bound
  });

  it("counts numbers as separate runs from letters", () => {
    const letterNumber = "abc123";
    const allLetters = "abcxyz";
    expect(estimateTokenCount(letterNumber, "openai")).toBeGreaterThan(
      estimateTokenCount(allLetters, "openai"),
    );
  });

  it("returns 0 for empty text", () => {
    expect(estimateTokenCount("", "openai")).toBe(0);
  });

  it("handles emoji, math symbols and url delimiters", () => {
    const text = "Hello @user! Visit https://example.com/path?x=1 😀 ∑x";
    expect(estimateTokenCount(text, "claude")).toBeGreaterThan(0);
  });

  it("is deterministic across calls", () => {
    const text = "deterministic 测试 123 @ #";
    expect(estimateTokenCount(text, "gemini")).toBe(estimateTokenCount(text, "gemini"));
  });
});

describe("extractRequestText — strips base64 multimodal payloads", () => {
  it("extracts plain string messages", () => {
    const text = extractRequestText({
      messages: [
        { role: "system", content: "system instruction" },
        { role: "user", content: "hello world" },
      ],
    });
    expect(text).toContain("system instruction");
    expect(text).toContain("hello world");
  });

  it("extracts text from OpenAI content array", () => {
    const text = extractRequestText({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is in this image" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,AAAA" },
            },
          ],
        },
      ],
    });
    expect(text).toContain("what is in this image");
    expect(text).not.toContain("AAAA");
    expect(text).not.toContain("image/png");
  });

  it("extracts text from Anthropic content array", () => {
    const text = extractRequestText({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: "AAAA",
              },
            },
          ],
        },
      ],
    });
    expect(text).toContain("describe this");
    expect(text).not.toContain("AAAA");
    expect(text).not.toContain("image/jpeg");
  });

  it("ignores unknown content shapes", () => {
    const text = extractRequestText({
      messages: [{ role: "user", content: { weird: "object" } }],
    });
    expect(text).toBe("");
  });

  it("gracefully handles non-object bodies", () => {
    expect(extractRequestText(null)).toBe("");
    expect(extractRequestText("plain string")).toBe("");
  });

  it("strips base64 from deep image_url strings", () => {
    const text = extractRequestText({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: "data:image/png;base64,SGVsbG8=",
            },
          ],
        },
      ],
    });
    expect(text).not.toContain("SGVsbG8=");
  });
});

describe("estimateTokenCount — model-aware dispatch", () => {
  it("uses provider-specific weights", () => {
    const text = "中文测试123";
    const openai = estimateTokenCount(text, "openai/gpt-4o");
    const claude = estimateTokenCount(text, "anthropic/claude-sonnet-4");
    const gemini = estimateTokenCount(text, "google/gemini-pro");
    // Claude weights CJK higher than OpenAI; Gemini weights it lower.
    expect(claude).toBeGreaterThan(openai);
    expect(gemini).not.toEqual(openai);
  });
});
