/**
 * Dashboard aggregator — pure rolling-window aggregation.
 *
 * Keeps a 60-second rolling window of requests for throughput and latency
 * percentiles, plus cumulative totals for today. All functions are pure: no
 * clock reads, no I/O.
 */

import type { ParsedUsageEntry } from "./tailer.js";

export type TierAggregate = { count: number; cost: number };
export type ModelAggregate = { count: number; cost: number };

export type DashboardAggregates = {
  totalRequests: number;
  totalCost: number;
  totalBaselineCost: number;
  totalSavings: number;
  upstreamRequests: number;
  estimatedRequests: number;
  partialRequests: number;
  truncatedRequests: number;
  entriesWithBaseline: number;
  byTier: Record<string, TierAggregate>;
  byModel: Record<string, ModelAggregate>;
  /** Samples in the rolling window. */
  windowSamples: { timestamp: number; latencyMs: number }[];
  /** Request rate over the last full window (req/s). */
  windowThroughput: number;
  /** p50 latency in ms, or null when there are no upstream samples. */
  p50Latency: number | null;
  /** p95 latency in ms, or null when there are no upstream samples. */
  p95Latency: number | null;
};

export const WINDOW_MS = 60_000;

function coalesce(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

export function emptyAggregates(): DashboardAggregates {
  return {
    totalRequests: 0,
    totalCost: 0,
    totalBaselineCost: 0,
    totalSavings: 0,
    upstreamRequests: 0,
    estimatedRequests: 0,
    partialRequests: 0,
    truncatedRequests: 0,
    entriesWithBaseline: 0,
    byTier: {},
    byModel: {},
    windowSamples: [],
    windowThroughput: 0,
    p50Latency: null,
    p95Latency: null,
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  const weight = idx - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function pruneWindow(samples: { timestamp: number; latencyMs: number }[], now: number) {
  const cutoff = now - WINDOW_MS;
  let i = 0;
  while (i < samples.length && samples[i].timestamp < cutoff) i++;
  if (i === 0) return samples;
  return samples.slice(i);
}

/**
 * Add new entries to the aggregates and recompute the rolling window.
 *
 * @param now - current timestamp in ms (injected for testability)
 */
export function updateAggregates(
  agg: DashboardAggregates,
  entries: ParsedUsageEntry[],
  now: number,
): DashboardAggregates {
  let totalRequests = agg.totalRequests;
  let totalCost = agg.totalCost;
  let totalBaselineCost = agg.totalBaselineCost;
  let totalSavings = agg.totalSavings;
  let upstreamRequests = agg.upstreamRequests;
  let estimatedRequests = agg.estimatedRequests;
  let partialRequests = agg.partialRequests;
  let truncatedRequests = agg.truncatedRequests;
  let entriesWithBaseline = agg.entriesWithBaseline;
  const byTier: Record<string, TierAggregate> = { ...agg.byTier };
  const byModel: Record<string, ModelAggregate> = { ...agg.byModel };
  const windowSamples = pruneWindow([...agg.windowSamples], now);

  for (const e of entries) {
    totalRequests++;
    const cost = coalesce(e.cost);
    totalCost += cost;

    if (e.usageSource === "upstream") upstreamRequests++;
    else if (e.usageSource === "estimated") estimatedRequests++;
    else if (e.usageSource === "partial") partialRequests++;

    if (e.truncated) truncatedRequests++;

    if (e.baselineCost !== null) {
      entriesWithBaseline++;
      totalBaselineCost += e.baselineCost;
      totalSavings += e.baselineCost - cost;
    }

    const tier = e.tier || "UNKNOWN";
    byTier[tier] = { count: (byTier[tier]?.count || 0) + 1, cost: (byTier[tier]?.cost || 0) + cost };

    const model = e.model || "unknown";
    byModel[model] = {
      count: (byModel[model]?.count || 0) + 1,
      cost: (byModel[model]?.cost || 0) + cost,
    };

    // Only put upstream / partial samples into the latency window; estimated
    // has no real latency number.
    if (e.usageSource !== "estimated") {
      windowSamples.push({ timestamp: now, latencyMs: e.latencyMs });
    }
  }

  const pruned = pruneWindow(windowSamples, now);
  const latencies = pruned.map((s) => s.latencyMs).sort((a, b) => a - b);

  return {
    totalRequests,
    totalCost,
    totalBaselineCost,
    totalSavings,
    upstreamRequests,
    estimatedRequests,
    partialRequests,
    truncatedRequests,
    entriesWithBaseline,
    byTier,
    byModel,
    windowSamples: pruned,
    windowThroughput: pruned.length / (WINDOW_MS / 1000),
    p50Latency: percentile(latencies, 50),
    p95Latency: percentile(latencies, 95),
  };
}
