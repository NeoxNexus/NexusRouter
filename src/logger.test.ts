import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  logRoutingDecision,
  queueRoutingDecision,
  flushLogs,
  type RoutingLogEntry,
  logOutcome,
  type OutcomeLogEntry,
} from "./logger.js";

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

describe("logRoutingDecision", () => {
  let logDir: string;

  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), "nexusrouter-log-"));
  });

  afterEach(async () => {
    await rm(logDir, { recursive: true, force: true });
  });

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

describe("queueRoutingDecision", () => {
  let logDir: string;

  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), "nexusrouter-queued-"));
  });

  afterEach(async () => {
    await flushLogs();
    await rm(logDir, { recursive: true, force: true });
  });

  it("returns void synchronously without performing I/O (决策 5)", () => {
    // The request path must never await the disk, and never receive a Promise.
    const returned = queueRoutingDecision(baseEntry, logDir);
    expect(returned).toBeUndefined();
  });

  it("writes the same line as logRoutingDecision once flushed", async () => {
    queueRoutingDecision(baseEntry, logDir);
    await flushLogs();

    const content = await readFile(join(logDir, "routing-2026-08-17.jsonl"), "utf-8");
    expect(JSON.parse(content.trim())).toEqual(baseEntry);
  });

  it("batches N entries into one file, order preserved", async () => {
    for (let i = 0; i < 5; i++) queueRoutingDecision({ ...baseEntry, promptChars: i }, logDir);
    await flushLogs();

    const lines = (await readFile(join(logDir, "routing-2026-08-17.jsonl"), "utf-8"))
      .trim()
      .split("\n");
    expect(lines.map((l) => JSON.parse(l).promptChars)).toEqual([0, 1, 2, 3, 4]);
  });

  it("truncates promptPreview on the queued path too", async () => {
    queueRoutingDecision({ ...baseEntry, promptPreview: "y".repeat(500) }, logDir);
    await flushLogs();

    const content = await readFile(join(logDir, "routing-2026-08-17.jsonl"), "utf-8");
    expect(JSON.parse(content.trim()).promptPreview).toHaveLength(200);
  });

  it("splits entries from different dates into their own daily files", async () => {
    queueRoutingDecision(baseEntry, logDir);
    queueRoutingDecision({ ...baseEntry, timestamp: "2026-08-18T01:00:00.000Z" }, logDir);
    await flushLogs();

    expect((await readFile(join(logDir, "routing-2026-08-17.jsonl"), "utf-8")).trim()).toContain(
      "2026-08-17",
    );
    expect((await readFile(join(logDir, "routing-2026-08-18.jsonl"), "utf-8")).trim()).toContain(
      "2026-08-18",
    );
  });

  it("never throws when the target directory cannot be created", async () => {
    // A regular file standing where a directory segment must be: fails on both
    // POSIX (ENOTDIR) and Windows, so the swallow path is genuinely exercised.
    const blocker = join(logDir, "blocker");
    await writeFile(blocker, "not a directory");

    expect(() => queueRoutingDecision(baseEntry, join(blocker, "logs"))).not.toThrow();
    await expect(flushLogs()).resolves.toBeUndefined();
  });
});

describe("logOutcome", () => {
  let logDir: string;

  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), "nexusrouter-outcome-log-"));
  });

  afterEach(async () => {
    await rm(logDir, { recursive: true, force: true });
  });

  const baseOutcome: OutcomeLogEntry = {
    timestamp: "2026-08-17T10:30:00.000Z",
    outcome: "retried",
    retryReason: "same-text",
  };

  it("writes routing-outcome-YYYY-MM-DD.jsonl named by the referenced entry's date", async () => {
    await logOutcome(baseOutcome, logDir);

    const content = await readFile(join(logDir, "routing-outcome-2026-08-17.jsonl"), "utf-8");
    const lines = content.trim().split("\n");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(baseOutcome);
  });

  it("appends subsequent outcomes instead of overwriting", async () => {
    await logOutcome(baseOutcome, logDir);
    await logOutcome({ ...baseOutcome, retryReason: "model-switch" }, logDir);

    const content = await readFile(join(logDir, "routing-outcome-2026-08-17.jsonl"), "utf-8");
    const lines = content.trim().split("\n");

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).retryReason).toBe("model-switch");
  });

  it("never throws when the log directory is unwritable", async () => {
    await expect(
      logOutcome(baseOutcome, "/proc/nexusrouter-cannot-write-here"),
    ).resolves.toBeUndefined();
  });
});
