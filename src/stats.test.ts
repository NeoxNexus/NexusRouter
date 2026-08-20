import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getStats } from "./stats.js";
import type { UsageEntry, UsageEntryV2 } from "./logger.js";

const original = process.env.NEXUSROUTER_LOG_DIR;

function entryV1(over: Partial<UsageEntry> = {}): UsageEntry {
  return {
    timestamp: "2026-08-20T10:00:00.000Z",
    model: "anthropic/claude-sonnet-4-5",
    tier: "COMPLEX",
    cost: 0.01,
    baselineCost: 0.05,
    savings: 0.8,
    latencyMs: 900,
    ...over,
  };
}

function entryV2(over: Partial<UsageEntryV2> = {}): UsageEntryV2 {
  return {
    schema: 2,
    timestamp: "2026-08-20T10:00:00.000Z",
    model: "anthropic/claude-sonnet-4.6",
    tier: "COMPLEX",
    usage: { inputUncached: 1000, output: 200, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    usageSource: "upstream",
    costUsd: 0.01,
    baselineModel: "anthropic/claude-opus-4.6",
    baselineCostUsd: 0.05,
    baselineMethod: "same-usage-repricing",
    savedUsd: 0.04,
    latencyMs: 900,
    ...over,
  };
}

describe("getStats — log directory resolution (defect 11)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nexusrouter-stats-"));
  });

  afterEach(async () => {
    if (original === undefined) delete process.env.NEXUSROUTER_LOG_DIR;
    else process.env.NEXUSROUTER_LOG_DIR = original;
    await rm(dir, { recursive: true, force: true });
  });

  it("reads from NEXUSROUTER_LOG_DIR, the same dir the logger writes to", async () => {
    await writeFile(
      join(dir, "usage-2026-08-20.jsonl"),
      [JSON.stringify(entryV2()), JSON.stringify(entryV2({ costUsd: 0.02, baselineCostUsd: 0.06 }))].join(
        "\n",
      ) + "\n",
    );
    process.env.NEXUSROUTER_LOG_DIR = dir;

    const stats = await getStats(7);

    expect(stats.totalRequests).toBe(2);
    expect(stats.totalCost).toBeCloseTo(0.03, 10);
    expect(stats.totalBaselineCost).toBeCloseTo(0.11, 10);
    expect(stats.totalSavings).toBeCloseTo(0.08, 10);
  });

  it("resolves the variable per call, so a later change is picked up", async () => {
    process.env.NEXUSROUTER_LOG_DIR = join(dir, "empty");
    expect((await getStats(7)).totalRequests).toBe(0);

    await writeFile(join(dir, "usage-2026-08-20.jsonl"), JSON.stringify(entryV2()) + "\n");
    process.env.NEXUSROUTER_LOG_DIR = dir;
    expect((await getStats(7)).totalRequests).toBe(1);
  });

  it("returns zeros instead of throwing when the log dir does not exist", async () => {
    process.env.NEXUSROUTER_LOG_DIR = join(dir, "nope");
    const stats = await getStats(7);

    expect(stats.totalRequests).toBe(0);
    expect(stats.savingsPercentage).toBe(0);
    expect(Number.isNaN(stats.avgLatencyMs)).toBe(false);
  });

  it("skips malformed lines and keeps the valid ones", async () => {
    await writeFile(
      join(dir, "usage-2026-08-20.jsonl"),
      `${JSON.stringify(entryV2())}\nnot json at all\n${JSON.stringify(entryV2())}\n`,
    );
    process.env.NEXUSROUTER_LOG_DIR = dir;

    expect((await getStats(7)).totalRequests).toBe(2);
  });

  it("ignores routing-*.jsonl so the two log kinds never cross-contaminate", async () => {
    await writeFile(join(dir, "routing-2026-08-20.jsonl"), JSON.stringify({ agent: "x" }) + "\n");
    process.env.NEXUSROUTER_LOG_DIR = dir;

    expect((await getStats(7)).totalRequests).toBe(0);
  });
});

describe("getStats — v1 / v2 mix", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nexusrouter-stats-mix-"));
  });

  afterEach(async () => {
    if (original === undefined) delete process.env.NEXUSROUTER_LOG_DIR;
    else process.env.NEXUSROUTER_LOG_DIR = original;
    await rm(dir, { recursive: true, force: true });
  });

  it("mixes legacy v1 entries with schema-v2 entries", async () => {
    await writeFile(
      join(dir, "usage-2026-08-20.jsonl"),
      [JSON.stringify(entryV1({ cost: 0.01, baselineCost: 0.05 })), JSON.stringify(entryV2({ costUsd: 0.02, baselineCostUsd: 0.06 }))].join("\n") + "\n",
    );
    process.env.NEXUSROUTER_LOG_DIR = dir;

    const stats = await getStats(7);
    expect(stats.totalRequests).toBe(2);
    expect(stats.totalCost).toBeCloseTo(0.03, 10);
    expect(stats.totalBaselineCost).toBeCloseTo(0.11, 10);
  });

  it("does not produce NaN when all baselines are null", async () => {
    await writeFile(
      join(dir, "usage-2026-08-20.jsonl"),
      [
        JSON.stringify(entryV2({ baselineCostUsd: null, savedUsd: null })),
        JSON.stringify(entryV2({ baselineCostUsd: null, savedUsd: null })),
      ].join("\n") + "\n",
    );
    process.env.NEXUSROUTER_LOG_DIR = dir;

    const stats = await getStats(7);
    expect(stats.totalBaselineCost).toBe(0);
    expect(stats.savingsPercentage).toBe(0);
    expect(Number.isNaN(stats.savingsPercentage)).toBe(false);
    expect(stats.entriesWithBaseline).toBe(0);
  });

  it("separates real upstream usage from estimated counts", async () => {
    await writeFile(
      join(dir, "usage-2026-08-20.jsonl"),
      [
        JSON.stringify(entryV2({ usageSource: "upstream" })),
        JSON.stringify(entryV2({ usageSource: "upstream" })),
        JSON.stringify(entryV2({ usageSource: "estimated" })),
        JSON.stringify(entryV2({ usageSource: "estimated", truncated: true })),
      ].join("\n") + "\n",
    );
    process.env.NEXUSROUTER_LOG_DIR = dir;

    const stats = await getStats(7);
    expect(stats.upstreamRequests).toBe(2);
    expect(stats.estimatedRequests).toBe(2);
    expect(stats.truncatedRequests).toBe(1);
  });
});
