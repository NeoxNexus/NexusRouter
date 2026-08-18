import { describe, it, expect } from "vitest";
import { inferToolRequirement } from "./tool-intent.js";

describe("inferToolRequirement", () => {
  describe("protocol signals (authoritative)", () => {
    it("honors tool_choice: none over any prose", () => {
      expect(inferToolRequirement("run the tests now", undefined, "none")).toBe(false);
    });

    it("honors tool_choice: required over any prose", () => {
      expect(inferToolRequirement("hi", undefined, "required")).toBe(true);
    });

    it("honors a named function tool_choice", () => {
      expect(inferToolRequirement("hi", undefined, { type: "function" })).toBe(true);
    });
  });

  describe("Claude Code traffic — tools attached on every turn", () => {
    // These are the cases that D-001 mis-tiered: CC ships a full tool table
    // on every request, so `hasTools` alone cannot distinguish them.
    it.each([
      ["hi", "hi"],
      ["ok", "ok"],
      ["a bare greeting with punctuation", "hello!"],
      ["a factual question", "what is the capital of France"],
      ["a thanks", "thanks"],
    ])("does not require tools for %s", (_label, prompt) => {
      expect(inferToolRequirement(prompt)).toBe(false);
    });

    it.each([
      ["running tests", "run the tests"],
      ["executing a build", "execute the build script"],
      ["editing a file", "edit the config file"],
      ["reading the repo", "inspect the repository for stale imports"],
      ["a git action", "git status"],
      ["explicit tool call", "use the Read tool"],
    ])("requires tools for %s", (_label, prompt) => {
      expect(inferToolRequirement(prompt)).toBe(true);
    });
  });

  describe("Chinese prompts", () => {
    it("requires tools when asked to run tests", () => {
      expect(inferToolRequirement("运行测试")).toBe(true);
    });

    it("requires tools when asked to modify a file", () => {
      expect(inferToolRequirement("修改这个文件")).toBe(true);
    });

    it("does not require tools for a bare greeting", () => {
      expect(inferToolRequirement("你好")).toBe(false);
    });
  });

  describe("system prompts are not evidence of intent", () => {
    it("ignores tool descriptions living in the system prompt", () => {
      const systemPrompt = "You can edit files, run the tests, and browse the web.";
      expect(inferToolRequirement("hi", systemPrompt)).toBe(false);
    });
  });

  describe("web and stateful actions", () => {
    it("requires tools to look something up online", () => {
      expect(inferToolRequirement("search the web for the latest docs")).toBe(true);
    });

    it("requires tools to cancel an order", () => {
      expect(inferToolRequirement("cancel my order please")).toBe(true);
    });
  });
});
