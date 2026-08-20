import { describe, it, expect } from "vitest";
import { percentile, buildResult, formatReport } from "./stats.js";
import type { LoadTestOptions, RequestSample } from "./types.js";

function sample(latencyMs: number, ok = true): RequestSample {
  return { latencyMs, status: ok ? 200 : 500, ok };
}

function memory(): NodeJS.MemoryUsage {
  return {
    rss: 0,
    heapTotal: 0,
    heapUsed: 0,
    external: 0,
    arrayBuffers: 0,
  };
}

const opts: LoadTestOptions = {
  durationMs: 1000,
  connections: 10,
  routerPort: 8402,
  accounting: false,
};

describe("percentile", () => {
  it("returns null for an empty array", () => {
    expect(percentile([], 50)).toBeNull();
  });

  it("returns the single element", () => {
    expect(percentile([42], 95)).toBe(42);
  });

  it("interpolates for intermediate percentiles", () => {
    const sorted = [1, 2, 3, 4];
    expect(percentile(sorted, 50)).toBe(2.5);
  });

  it("computes p95 and p99 correctly", () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 95)).toBe(95.05);
    expect(percentile(sorted, 99)).toBe(99.01);
  });
});

describe("buildResult", () => {
  it("aggregates throughput and percentiles", () => {
    const samples = [sample(10), sample(20), sample(30), sample(40), sample(50)];
    const result = buildResult(opts, samples, 1000, memory(), memory());
    expect(result.total).toBe(5);
    expect(result.successes).toBe(5);
    expect(result.errors).toBe(0);
    expect(result.throughput).toBe(5);
    expect(result.p50).toBe(30);
    expect(result.p95).toBe(48);
  });

  it("excludes error latencies from percentile calculations", () => {
    const samples = [sample(10), sample(100, false), sample(20)];
    const result = buildResult(opts, samples, 1000, memory(), memory());
    expect(result.total).toBe(3);
    expect(result.successes).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.p50).toBe(15);
  });

  it("handles zero samples gracefully", () => {
    const result = buildResult(opts, [], 1000, memory(), memory());
    expect(result.total).toBe(0);
    expect(result.p50).toBeNull();
    expect(result.throughput).toBe(0);
  });
});

describe("formatReport", () => {
  it("includes throughput and latency", () => {
    const samples = [sample(10), sample(20), sample(30)];
    const result = buildResult(opts, samples, 1000, memory(), memory());
    const report = formatReport(result);
    expect(report).toContain("NexusRouter Load Test Report");
    expect(report).toContain("3");
    expect(report).toContain("req/s");
    expect(report).toContain("ms");
  });
});
