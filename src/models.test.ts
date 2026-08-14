import { describe, expect, it } from "vitest";

import { resolveModelAlias, MODELS } from "./models.js";

describe("resolveModelAlias", () => {
  it("maps GPT-5 aliases to the latest flagship", () => {
    expect(resolveModelAlias("gpt5")).toBe("openai/gpt-5.4");
    expect(resolveModelAlias("codex")).toBe("openai/gpt-5.4");
    expect(resolveModelAlias("gpt-5.3-codex")).toBe("openai/gpt-5.4");
  });

  it("maps Claude aliases to newest 4.6 versions", () => {
    // Use newest versions (4.6) with full provider prefix
    expect(resolveModelAlias("claude")).toBe("anthropic/claude-sonnet-4.6");
    expect(resolveModelAlias("sonnet")).toBe("anthropic/claude-sonnet-4.6");
    expect(resolveModelAlias("opus")).toBe("anthropic/claude-opus-4.6");
    expect(resolveModelAlias("haiku")).toBe("anthropic/claude-haiku-4.5");
  });

  it("returns provider/model format unchanged", () => {
    expect(resolveModelAlias("openai/gpt-4o")).toBe("openai/gpt-4o");
    expect(resolveModelAlias("anthropic/claude-sonnet-4.6")).toBe("anthropic/claude-sonnet-4.6");
  });

  it("returns unknown aliases as-is", () => {
    expect(resolveModelAlias("unknown-model")).toBe("unknown-model");
    expect(resolveModelAlias("some/custom/model")).toBe("some/custom/model");
  });

  it("maps legacy Claude IDs to 4.6", () => {
    expect(resolveModelAlias("anthropic/claude-sonnet-4")).toBe("anthropic/claude-sonnet-4.6");
    expect(resolveModelAlias("anthropic/claude-opus-4")).toBe("anthropic/claude-opus-4.6");
    expect(resolveModelAlias("anthropic/claude-opus-4.5")).toBe("anthropic/claude-opus-4.6");
  });
});

describe("MODELS", () => {
  it("should not contain any blockrun/ prefix model IDs", () => {
    for (const model of MODELS) {
      expect(model.id).not.toMatch(/^blockrun\//);
    }
  });

  it("all real model IDs should use provider/model format", () => {
    const realModels = MODELS.filter(
      (m) => !["auto", "free", "eco", "premium"].includes(m.id),
    );
    for (const model of realModels) {
      expect(model.id).toMatch(/^[a-z]+\//);
    }
  });
});
