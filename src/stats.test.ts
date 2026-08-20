import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getStats } from "./stats.js";
import type { UsageEntry } from "./logger.js";

const original = process.env.NEXUSROUTER_LOG_DIR;

function entry(over: Partial<UsageEntry> = {}): UsageEntry {
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
    // Defect 11: stats.ts froze the dir in a module-level const, so the write
    // side wrote to A while the read side read B — reports silently showed 0.
    await writeFile(
      join(dir, "usage-2026-08-20.jsonl"),
      [JSON.stringify(entry()), JSON.stringify(entry({ cost: 0.02, baselineCost: 0.06 }))].join(
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

    await writeFile(join(dir, "usage-2026-08-20.jsonl"), JSON.stringify(entry()) + "\n");
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
      `${JSON.stringify(entry())}\nnot json at all\n${JSON.stringify(entry())}\n`,
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
