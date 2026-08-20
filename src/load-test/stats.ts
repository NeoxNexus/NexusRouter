/**
 * Load-test statistics — pure functions, no I/O.
 */

import type { LoadTestResult, RequestSample } from "./types.js";

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  const weight = idx - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function buildResult(
  options: LoadTestResult["options"],
  samples: RequestSample[],
  durationMs: number,
  memoryStart: NodeJS.MemoryUsage,
  memoryEnd: NodeJS.MemoryUsage,
): LoadTestResult {
  const latencies = samples.filter((s) => s.ok).map((s) => s.latencyMs).sort((a, b) => a - b);
  const successes = samples.filter((s) => s.ok).length;
  const errors = samples.length - successes;
  return {
    options,
    total: samples.length,
    successes,
    errors,
    throughput: durationMs > 0 ? (samples.length / durationMs) * 1000 : 0,
    durationMs,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    minLatency: latencies.length > 0 ? latencies[0] : null,
    maxLatency: latencies.length > 0 ? latencies[latencies.length - 1] : null,
    memoryStart,
    memoryEnd,
    samples,
  };
}

function fmtMs(n: number | null): string {
  return n === null ? "—" : `${Math.round(n)}`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatReport(result: LoadTestResult): string {
  const lines: string[] = [];
  lines.push("═".repeat(62));
  lines.push(" NexusRouter Load Test Report".padEnd(62) + "═");
  lines.push("═".repeat(62));
  lines.push(`  Duration:        ${(result.durationMs / 1000).toFixed(2)} s`);
  lines.push(`  Connections:     ${result.options.connections}`);
  lines.push(`  Accounting:      ${result.options.accounting ? "ON" : "OFF"}`);
  lines.push(`  Total requests:  ${result.total}`);
  lines.push(`  Successful:      ${result.successes}`);
  if (result.errors > 0) lines.push(`  Errors:          ${result.errors}`);
  lines.push(`  Throughput:      ${result.throughput.toFixed(1)} req/s`);
  lines.push(`  Latency p50:     ${fmtMs(result.p50)} ms`);
  lines.push(`  Latency p95:     ${fmtMs(result.p95)} ms`);
  lines.push(`  Latency p99:     ${fmtMs(result.p99)} ms`);
  lines.push(`  Latency min/max: ${fmtMs(result.minLatency)} / ${fmtMs(result.maxLatency)} ms`);
  lines.push(`  Memory start:    ${fmtBytes(result.memoryStart.rss)}`);
  lines.push(`  Memory end:      ${fmtBytes(result.memoryEnd.rss)}`);
  lines.push(`  Memory delta:    ${fmtBytes(result.memoryEnd.rss - result.memoryStart.rss)}`);
  lines.push("═".repeat(62));
  return lines.join("\n");
}
