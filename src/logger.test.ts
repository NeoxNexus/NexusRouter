import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { logRoutingDecision, type RoutingLogEntry } from "./logger.js";

describe("logRoutingDecision", () => {
  let logDir: string;

  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), "nexusrouter-log-"));
  });

  afterEach(async () => {
    await rm(logDir, { recursive: true, force: true });
  });

  const baseEntry: RoutingLogEntry = {
    timestamp: "2026-08-17T10:30:00.000Z",
    agent: "claude-code",
    protocol: "anthropic",
    requestedModel: "auto",
    classifierTier: "COMPLEX",
    finalTier: "COMPLEX",
    finalModel: "anthropic/claude-opus-5",
    layer: "rule",
    reason: "reference-pattern",
    confidence: 1,
    hasTools: true,
    toolCount: 14,
    requiresTools: false,
    hasThinking: false,
    hasSystemPrompt: true,
    messageCount: 3,
    promptChars: 42,
    promptCharsSanitized: 42,
    promptPreview: "list the files in src/",
    stream: true,
    classifyLatencyMs: 0.05,
    upstreamStatus: 200,
    totalLatencyMs: 812,
  };

  it("writes one JSON line to routing-YYYY-MM-DD.jsonl named by entry date", async () => {
    await logRoutingDecision(baseEntry, logDir);

    const content = await readFile(join(logDir, "routing-2026-08-17.jsonl"), "utf-8");
    const lines = content.trim().split("\n");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(baseEntry);
  });

  it("appends subsequent entries instead of overwriting", async () => {
    await logRoutingDecision(baseEntry, logDir);
    await logRoutingDecision({ ...baseEntry, finalTier: "SIMPLE" }, logDir);

    const content = await readFile(join(logDir, "routing-2026-08-17.jsonl"), "utf-8");
    const lines = content.trim().split("\n");

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).finalTier).toBe("SIMPLE");
  });

  it("records classifierTier and finalTier separately so hint fusion is measurable", async () => {
    await logRoutingDecision(
      { ...baseEntry, classifierTier: "COMPLEX", finalTier: "REASONING", hasThinking: true },
      logDir,
    );

    const content = await readFile(join(logDir, "routing-2026-08-17.jsonl"), "utf-8");
    const entry = JSON.parse(content.trim());

    expect(entry.classifierTier).toBe("COMPLEX");
    expect(entry.finalTier).toBe("REASONING");
    expect(entry.hasThinking).toBe(true);
  });

  it("truncates promptPreview to 200 chars so logs stay readable", async () => {
    await logRoutingDecision({ ...baseEntry, promptPreview: "x".repeat(500) }, logDir);

    const content = await readFile(join(logDir, "routing-2026-08-17.jsonl"), "utf-8");
    const entry = JSON.parse(content.trim());

    expect(entry.promptPreview).toHaveLength(200);
  });

  it("never throws when the log directory is unwritable", async () => {
    await expect(
      logRoutingDecision(baseEntry, "/proc/nexusrouter-cannot-write-here"),
    ).resolves.toBeUndefined();
  });
});
