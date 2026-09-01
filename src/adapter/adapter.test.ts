import { describe, test, expect } from "vitest";
import { detectProtocol, extractAgentFromPath } from "./adapter.js";
import { AnthropicAdapter } from "./anthropic.js";
import { OpenAIAdapter, buildOpenAIUpstreamBody } from "./openai.js";
import type { OpenAIRequestBody } from "./openai.js";
import {
  claudeCodeProfile,
  openClawProfile,
  resolveProfile,
  getHintsAndWeights,
  sanitizeForClassification,
} from "./profile.js";
import type { UnifiedRequest } from "./types.js";

// ─── Helpers ───

function makeAnthropicBody(overrides = {}) {
  return {
    model: "claude-sonnet-4-20250514",
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 8192,
    ...overrides,
  };
}

function makeOpenAIBody(overrides: Partial<OpenAIRequestBody> = {}): OpenAIRequestBody {
  return {
    model: "gpt-4o",
    messages: [{ role: "user" as const, content: "Hello" }],
    ...overrides,
  };
}

const emptyHeaders = {};

// ─── Protocol Detection ───

describe("detectProtocol", () => {
  test("detects anthropic for /v1/messages", () => {
    expect(detectProtocol("/v1/messages")).toBe("anthropic");
  });

  test("detects anthropic for /anthropic/v1/messages", () => {
    expect(detectProtocol("/anthropic/v1/messages")).toBe("anthropic");
  });

  test("detects openai for /v1/chat/completions", () => {
    expect(detectProtocol("/v1/chat/completions")).toBe("openai");
  });

  test("detects openai for /openclaw/v1/chat/completions", () => {
    expect(detectProtocol("/openclaw/v1/chat/completions")).toBe("openai");
  });

  test("returns null for unknown path", () => {
    expect(detectProtocol("/v1/embeddings")).toBeNull();
  });
});

// ─── Agent Path Extraction ───

describe("extractAgentFromPath", () => {
  test("extracts anthropic from /anthropic/v1/messages", () => {
    expect(extractAgentFromPath("/anthropic/v1/messages")).toBe("anthropic");
  });

  test("extracts openclaw from /openclaw/v1/chat/completions", () => {
    expect(extractAgentFromPath("/openclaw/v1/chat/completions")).toBe("openclaw");
  });

  test("returns null for standard /v1/messages path", () => {
    expect(extractAgentFromPath("/v1/messages")).toBeNull();
  });

  test("returns null for standard /v1/chat/completions path", () => {
    expect(extractAgentFromPath("/v1/chat/completions")).toBeNull();
  });
});

// ─── AnthropicAdapter ───

describe("AnthropicAdapter.toUnified", () => {
  const adapter = new AnthropicAdapter();

  test("converts basic request", () => {
    const unified = adapter.toUnified(makeAnthropicBody(), emptyHeaders);
    expect(unified.protocol).toBe("anthropic");
    expect(unified.model).toBe("claude-sonnet-4-20250514");
    expect(unified.messages[0].role).toBe("user");
    expect(unified.messages[0].content).toBe("Hello");
    expect(unified.hasTools).toBe(false);
    expect(unified.stream).toBe(false);
  });

  test("extracts text from content blocks", () => {
    const body = makeAnthropicBody({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Line one" },
            { type: "text", text: "Line two" },
          ],
        },
      ],
    });
    const unified = adapter.toUnified(body, emptyHeaders);
    expect(unified.messages[0].content).toBe("Line one\nLine two");
  });

  test("detects tools", () => {
    const body = makeAnthropicBody({
      tools: [{ name: "read_file", input_schema: {} }],
    });
    const unified = adapter.toUnified(body, emptyHeaders);
    expect(unified.hasTools).toBe(true);
  });

  test("extracts system text", () => {
    const body = makeAnthropicBody({ system: "You are a helpful assistant." });
    const unified = adapter.toUnified(body, emptyHeaders);
    expect(unified.system).toBe("You are a helpful assistant.");
  });

  test("extracts system from content blocks", () => {
    const body = makeAnthropicBody({
      system: [{ type: "text", text: "System prompt." }],
    });
    const unified = adapter.toUnified(body, emptyHeaders);
    expect(unified.system).toBe("System prompt.");
  });
});

// ─── OpenAIAdapter ───

describe("OpenAIAdapter.toUnified", () => {
  const adapter = new OpenAIAdapter();

  test("converts basic request", () => {
    const unified = adapter.toUnified(makeOpenAIBody(), emptyHeaders);
    expect(unified.protocol).toBe("openai");
    expect(unified.model).toBe("gpt-4o");
    expect(unified.messages[0].role).toBe("user");
    expect(unified.messages[0].content).toBe("Hello");
  });

  test("extracts system message into unified.system", () => {
    const body = makeOpenAIBody({
      messages: [
        { role: "system", content: "Be helpful." },
        { role: "user", content: "Hi" },
      ],
    });
    const unified = adapter.toUnified(body, emptyHeaders);
    expect(unified.system).toBe("Be helpful.");
    expect(unified.messages.every((m) => m.role !== "system")).toBe(true);
  });

  test("detects streaming", () => {
    const unified = adapter.toUnified(makeOpenAIBody({ stream: true }), emptyHeaders);
    expect(unified.stream).toBe(true);
  });
});

describe("buildOpenAIUpstreamBody", () => {
  test("replaces model while preserving other fields", () => {
    const body = makeOpenAIBody({ stream: true });
    const upstream = buildOpenAIUpstreamBody(body, "openai/gpt-4o-mini", false);
    expect(upstream.model).toBe("openai/gpt-4o-mini");
    expect(upstream.stream).toBe(true);
    expect(upstream.messages).toEqual(body.messages);
  });

  test("does not inject stream_options for non-streaming requests", () => {
    const body = makeOpenAIBody();
    const upstream = buildOpenAIUpstreamBody(body, "openai/gpt-4o-mini", true);
    expect(upstream.stream_options).toBeUndefined();
  });

  test("injects include_usage when injectStreamUsage is true and stream is true", () => {
    const body = makeOpenAIBody({ stream: true });
    const upstream = buildOpenAIUpstreamBody(body, "openai/gpt-4o-mini", true);
    expect(upstream.stream_options).toEqual({ include_usage: true });
  });

  test("preserves existing stream_options when injecting include_usage", () => {
    const body = makeOpenAIBody({ stream: true, stream_options: { foo: "bar" } });
    const upstream = buildOpenAIUpstreamBody(body, "openai/gpt-4o-mini", true);
    expect(upstream.stream_options).toEqual({ foo: "bar", include_usage: true });
  });

  test("overrides client-provided include_usage: false when injectStreamUsage is enabled", () => {
    const body = makeOpenAIBody({ stream: true, stream_options: { include_usage: false } });
    const upstream = buildOpenAIUpstreamBody(body, "openai/gpt-4o-mini", true);
    expect(upstream.stream_options).toEqual({ include_usage: true });
  });
});

// ─── AgentProfile ───

describe("claudeCodeProfile", () => {
  function makeUnified(model: string, thinking = false): UnifiedRequest {
    return {
      protocol: "anthropic",
      model,
      messages: [{ role: "user", content: "test" }],
      stream: false,
      hasTools: false,
      rawBody: thinking ? { thinking: { type: "enabled" } } : {},
      rawHeaders: {},
    };
  }

  test("haiku → 80% hint weight (background task)", () => {
    const req = makeUnified("claude-haiku-4-20250514");
    const { hints, weights } = getHintsAndWeights(claudeCodeProfile, req);
    expect(hints.isBackgroundTask).toBe(true);
    expect(weights.hintWeight).toBe(0.8);
    expect(weights.classifierWeight).toBe(0.2);
  });

  test("thinking mode → 50% hint weight", () => {
    const req = makeUnified("claude-sonnet-4-20250514", true);
    const { hints, weights } = getHintsAndWeights(claudeCodeProfile, req);
    expect(hints.preferThinking).toBe(true);
    expect(weights.hintWeight).toBe(0.5);
    expect(weights.classifierWeight).toBe(0.5);
  });

  test("default sonnet → 10% hint weight (classifier rules)", () => {
    const req = makeUnified("claude-sonnet-4-20250514");
    const { hints, weights } = getHintsAndWeights(claudeCodeProfile, req);
    expect(hints.isBackgroundTask).toBe(false);
    expect(hints.preferThinking).toBe(false);
    expect(weights.classifierWeight).toBe(0.9);
  });
});

describe("openClawProfile", () => {
  test("pure classifier routing (no hints)", () => {
    const req: UnifiedRequest = {
      protocol: "openai",
      model: "auto",
      messages: [{ role: "user", content: "test" }],
      stream: false,
      hasTools: false,
      rawBody: {},
      rawHeaders: {},
    };
    const { weights } = getHintsAndWeights(openClawProfile, req);
    expect(weights.hintWeight).toBe(0);
    expect(weights.classifierWeight).toBe(1);
  });
});

describe("resolveProfile", () => {
  test("anthropic prefix → claude-code profile", () => {
    const profile = resolveProfile("anthropic", "anthropic");
    expect(profile.name).toBe("claude-code");
  });

  test("openclaw prefix → openclaw profile", () => {
    const profile = resolveProfile("openclaw", "openai");
    expect(profile.name).toBe("openclaw");
  });

  test("null prefix + openai protocol → openclaw fallback", () => {
    const profile = resolveProfile(null, "openai");
    expect(profile.protocolType).toBe("openai");
  });

  test("null prefix + anthropic protocol → claude-code fallback", () => {
    const profile = resolveProfile(null, "anthropic");
    expect(profile.name).toBe("claude-code");
  });
});

// ─── Host Boilerplate Stripping ───

describe("sanitizeForClassification", () => {
  test("claude-code strips a system-reminder block", () => {
    const text =
      "<system-reminder>\nSessionStart hook: improve existing skills\n</system-reminder>\nhi";
    expect(sanitizeForClassification(claudeCodeProfile, text)).toBe("hi");
  });

  test("claude-code strips several blocks and keeps the user's own words", () => {
    const text = [
      "<system-reminder>first injection</system-reminder>",
      "rename foo to bar",
      "<system-reminder>trailing injection</system-reminder>",
    ].join("\n");
    expect(sanitizeForClassification(claudeCodeProfile, text)).toBe("rename foo to bar");
  });

  test("claude-code returns empty string when the turn is only boilerplate", () => {
    const text = "<system-reminder>nothing but injection</system-reminder>";
    expect(sanitizeForClassification(claudeCodeProfile, text)).toBe("");
  });

  test("claude-code leaves an unterminated block alone rather than eating the prompt", () => {
    const text = "<system-reminder>no closing tag, then: prove this theorem";
    expect(sanitizeForClassification(claudeCodeProfile, text)).toBe(text);
  });

  test("claude-code leaves ordinary prompts untouched", () => {
    expect(sanitizeForClassification(claudeCodeProfile, "hi")).toBe("hi");
  });

  test("profiles without the hook pass text through unchanged", () => {
    const text = "<system-reminder>injection</system-reminder>\nhi";
    expect(sanitizeForClassification(openClawProfile, text)).toBe(text);
  });
});

// ─── Skill Injection Recognition (D-009) ───

describe("matchSkillInjection", () => {
  const body = "# Systematic Debugging\n\nRandom fixes prove nothing.";

  test("claude-code recognizes a skill document and extracts the name from a windows path", () => {
    const text = `Base directory for this skill: C:\\Users\\Administrator\\.claude\\skills\\superpowers-5.0.7\\skills\\systematic-debugging\n\n${body}`;
    expect(claudeCodeProfile.matchSkillInjection?.(text)).toBe("systematic-debugging");
  });

  test("claude-code extracts the name from a posix path", () => {
    const text = `Base directory for this skill: /home/neo/.claude/skills/brainstorming\n\n${body}`;
    expect(claudeCodeProfile.matchSkillInjection?.(text)).toBe("brainstorming");
  });

  test("claude-code returns null for ordinary user text", () => {
    expect(claudeCodeProfile.matchSkillInjection?.("prove this theorem by induction")).toBeNull();
  });

  test("claude-code returns null when the header appears mid-text, not at the start", () => {
    const text = `look at this:\nBase directory for this skill: /skills/foo`;
    expect(claudeCodeProfile.matchSkillInjection?.(text)).toBeNull();
  });

  test("profiles without the hook are simply not consulted", () => {
    expect(openClawProfile.matchSkillInjection).toBeUndefined();
  });
});
