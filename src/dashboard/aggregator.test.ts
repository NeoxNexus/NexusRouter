import { describe, it, expect } from "vitest";
import { emptyAggregates, updateAggregates, WINDOW_MS } from "./aggregator.js";
import type { ParsedUsageEntry } from "./tailer.js";

function entry(over: Partial<ParsedUsageEntry> = {}): ParsedUsageEntry {
  return {
    timestamp: "2026-08-20T10:00:00.000Z",
    model: "anthropic/claude-sonnet-4.6",
    tier: "COMPLEX",
    cost: 0.01,
    baselineCost: 0.05,
    savings: 0.04,
    latencyMs: 900,
    usageSource: "upstream",
    truncated: false,
    ...over,
  };
}

describe("aggregator", () => {
  it("starts empty", () => {
    const agg = emptyAggregates();
    expect(agg.totalRequests).toBe(0);
    expect(agg.windowThroughput).toBe(0);
    expect(agg.p50Latency).toBeNull();
  });

  it("accumulates totals and tier/model breakdowns", () => {
    let agg = emptyAggregates();
    agg = updateAggregates(
      agg,
      [entry(), entry({ tier: "SIMPLE", model: "gpt-4o-mini", cost: 0.002 })],
      0,
    );

    expect(agg.totalRequests).toBe(2);
    expect(agg.totalCost).toBeCloseTo(0.012, 10);
    expect(agg.byTier.COMPLEX.count).toBe(1);
    expect(agg.byTier.SIMPLE.count).toBe(1);
    expect(agg.byModel["anthropic/claude-sonnet-4.6"].count).toBe(1);
  });

  it("separates upstream and estimated counts", () => {
    let agg = emptyAggregates();
    agg = updateAggregates(
      agg,
      [
        entry({ usageSource: "upstream" }),
        entry({ usageSource: "upstream" }),
        entry({ usageSource: "estimated" }),
        entry({ usageSource: "partial" }),
      ],
      0,
    );

    expect(agg.upstreamRequests).toBe(2);
    expect(agg.estimatedRequests).toBe(1);
    expect(agg.partialRequests).toBe(1);
  });

  it("counts truncated requests", () => {
    let agg = emptyAggregates();
    agg = updateAggregates(
      agg,
      [entry({ truncated: true }), entry({ truncated: true }), entry()],
      0,
    );
    expect(agg.truncatedRequests).toBe(2);
  });

  it("does not count null baseline as 0 in totals", () => {
    let agg = emptyAggregates();
    agg = updateAggregates(agg, [entry({ baselineCost: null, savings: null })], 0);
    expect(agg.totalBaselineCost).toBe(0);
    expect(agg.totalSavings).toBe(0);
    expect(agg.entriesWithBaseline).toBe(0);
  });

  it("computes rolling-window throughput and latency percentiles", () => {
    let agg = emptyAggregates();
    const now = 1_000_000;
    agg = updateAggregates(
      agg,
      [
        entry({ latencyMs: 100 }),
        entry({ latencyMs: 200 }),
        entry({ latencyMs: 300 }),
        entry({ latencyMs: 400 }),
        entry({ latencyMs: 500 }),
      ],
      now,
    );

    expect(agg.windowThroughput).toBeCloseTo(5 / 60, 10);
    expect(agg.p50Latency).toBe(300);
    expect(agg.p95Latency).toBeCloseTo(480, 0);
  });

  it("drops samples outside the 60s window", () => {
    let agg = emptyAggregates();
    const now = 1_000_000;
    agg = updateAggregates(agg, [entry({ latencyMs: 100 })], now - WINDOW_MS - 1);
    agg = updateAggregates(agg, [entry({ latencyMs: 200 })], now);

    expect(agg.windowSamples).toHaveLength(1);
    expect(agg.p50Latency).toBe(200);
  });

  it("does not produce NaN with fewer than 2 latency samples", () => {
    let agg = emptyAggregates();
    agg = updateAggregates(agg, [entry({ latencyMs: 100 })], 0);
    expect(agg.p50Latency).toBe(100);
    expect(agg.p95Latency).toBe(100);
    expect(Number.isNaN(agg.p50Latency)).toBe(false);
  });
});
