/**
 * Usage Statistics Aggregator
 *
 * Reads usage log files and aggregates statistics for terminal display.
 * Supports filtering by date range and provides multiple aggregation views.
 */

import { readdir } from "node:fs/promises";
import { readTextFile } from "./fs-read.js";
import { join } from "node:path";
import type { UsageEntry, UsageEntryV2 } from "./logger.js";
import { resolveLogDir } from "./paths.js";
import { VERSION } from "./version.js";

/** Internal union used by aggregation. Nulls preserve the "unknown" semantics. */
type ParsedUsageEntry = {
  timestamp: string;
  model: string;
  tier: string;
  cost: number | null;
  baselineCost: number | null;
  savings: number | null;
  latencyMs: number;
  usageSource?: "upstream" | "estimated" | "partial";
  truncated?: boolean;
};

export type DailyStats = {
  date: string;
  totalRequests: number;
  totalCost: number;
  totalBaselineCost: number;
  totalSavings: number;
  avgLatencyMs: number;
  upstreamRequests: number;
  estimatedRequests: number;
  truncatedRequests: number;
  byTier: Record<string, { count: number; cost: number }>;
  byModel: Record<string, { count: number; cost: number }>;
};

export type AggregatedStats = {
  period: string;
  totalRequests: number;
  totalCost: number;
  totalBaselineCost: number;
  totalSavings: number;
  savingsPercentage: number;
  avgLatencyMs: number;
  avgCostPerRequest: number;
  byTier: Record<string, { count: number; cost: number; percentage: number }>;
  byModel: Record<string, { count: number; cost: number; percentage: number }>;
  dailyBreakdown: DailyStats[];
  entriesWithBaseline: number;
  upstreamRequests: number;
  estimatedRequests: number;
  truncatedRequests: number;
};

/**
 * Parse a JSONL usage log file.
 * Handles v1 (schema field missing), v2 (`schema: 2`), and malformed lines.
 */
async function parseLogFile(filePath: string): Promise<ParsedUsageEntry[]> {
  try {
    const content = await readTextFile(filePath);
    const lines = content.trim().split("\n").filter(Boolean);
    const entries: ParsedUsageEntry[] = [];
    for (const line of lines) {
      try {
        const raw = JSON.parse(line) as Partial<UsageEntry> & Partial<UsageEntryV2>;
        if (raw.schema === 2) {
          const v2 = raw as UsageEntryV2;
          entries.push({
            timestamp: v2.timestamp || new Date().toISOString(),
            model: v2.model || "unknown",
            tier: v2.tier || "UNKNOWN",
            cost: v2.costUsd ?? null,
            baselineCost: v2.baselineCostUsd ?? null,
            savings: v2.savedUsd ?? null,
            latencyMs: v2.latencyMs || 0,
            usageSource: v2.usageSource,
            truncated: v2.truncated,
          });
        } else {
          const v1 = raw as UsageEntry;
          entries.push({
            timestamp: v1.timestamp || new Date().toISOString(),
            model: v1.model || "unknown",
            tier: v1.tier || "UNKNOWN",
            cost: typeof v1.cost === "number" ? v1.cost : null,
            baselineCost: typeof v1.baselineCost === "number" ? v1.baselineCost : null,
            savings: typeof v1.savings === "number" ? v1.savings : null,
            latencyMs: v1.latencyMs || 0,
          });
        }
      } catch {
        // Skip malformed lines, keep valid ones
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Get list of available log files sorted by date (newest first).
 *
 * The directory is resolved per call (defect 11): freezing it in a module const
 * made the read side ignore NEXUSROUTER_LOG_DIR while the writer honored it,
 * so reports silently showed zeros.
 */
async function getLogFiles(dir: string): Promise<string[]> {
  try {
    const files = await readdir(dir);
    return files
      .filter((f) => f.startsWith("usage-") && f.endsWith(".jsonl"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function coalesce(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/**
 * Aggregate stats for a single day.
 */
function aggregateDay(date: string, entries: ParsedUsageEntry[]): DailyStats {
  const byTier: Record<string, { count: number; cost: number }> = {};
  const byModel: Record<string, { count: number; cost: number }> = {};
  let totalLatency = 0;
  let upstreamRequests = 0;
  let estimatedRequests = 0;
  let truncatedRequests = 0;

  for (const entry of entries) {
    const cost = coalesce(entry.cost);

    if (!byTier[entry.tier]) byTier[entry.tier] = { count: 0, cost: 0 };
    byTier[entry.tier].count++;
    byTier[entry.tier].cost += cost;

    if (!byModel[entry.model]) byModel[entry.model] = { count: 0, cost: 0 };
    byModel[entry.model].count++;
    byModel[entry.model].cost += cost;

    totalLatency += entry.latencyMs;

    if (entry.usageSource === "upstream") upstreamRequests++;
    else if (entry.usageSource === "estimated") estimatedRequests++;
    if (entry.truncated) truncatedRequests++;
  }

  const totalCost = entries.reduce((sum, e) => sum + coalesce(e.cost), 0);
  const totalBaselineCost = entries.reduce((sum, e) => sum + coalesce(e.baselineCost), 0);

  return {
    date,
    totalRequests: entries.length,
    totalCost,
    totalBaselineCost,
    totalSavings: totalBaselineCost - totalCost,
    avgLatencyMs: entries.length > 0 ? totalLatency / entries.length : 0,
    upstreamRequests,
    estimatedRequests,
    truncatedRequests,
    byTier,
    byModel,
  };
}

/**
 * Get aggregated statistics for the last N days.
 */
export async function getStats(days: number = 7): Promise<AggregatedStats> {
  const logDir = resolveLogDir();
  const logFiles = await getLogFiles(logDir);
  const filesToRead = logFiles.slice(0, days);

  const dailyBreakdown: DailyStats[] = [];
  const allByTier: Record<string, { count: number; cost: number }> = {};
  const allByModel: Record<string, { count: number; cost: number }> = {};
  let totalRequests = 0;
  let totalCost = 0;
  let totalBaselineCost = 0;
  let totalLatency = 0;
  let upstreamRequests = 0;
  let estimatedRequests = 0;
  let truncatedRequests = 0;
  let entriesWithBaseline = 0;

  for (const file of filesToRead) {
    const date = file.replace("usage-", "").replace(".jsonl", "");
    const filePath = join(logDir, file);
    const entries = await parseLogFile(filePath);

    if (entries.length === 0) continue;

    const dayStats = aggregateDay(date, entries);
    dailyBreakdown.push(dayStats);

    totalRequests += dayStats.totalRequests;
    totalCost += dayStats.totalCost;
    totalBaselineCost += dayStats.totalBaselineCost;
    totalLatency += dayStats.avgLatencyMs * dayStats.totalRequests;
    upstreamRequests += dayStats.upstreamRequests;
    estimatedRequests += dayStats.estimatedRequests;
    truncatedRequests += dayStats.truncatedRequests;

    // Count entries that actually have a measured baseline.
    for (const e of entries) {
      if (e.baselineCost !== null) entriesWithBaseline++;
    }

    // Merge tier stats
    for (const [tier, stats] of Object.entries(dayStats.byTier)) {
      if (!allByTier[tier]) allByTier[tier] = { count: 0, cost: 0 };
      allByTier[tier].count += stats.count;
      allByTier[tier].cost += stats.cost;
    }

    // Merge model stats
    for (const [model, stats] of Object.entries(dayStats.byModel)) {
      if (!allByModel[model]) allByModel[model] = { count: 0, cost: 0 };
      allByModel[model].count += stats.count;
      allByModel[model].cost += stats.cost;
    }
  }

  // Calculate percentages
  const byTierWithPercentage: Record<string, { count: number; cost: number; percentage: number }> =
    {};
  for (const [tier, stats] of Object.entries(allByTier)) {
    byTierWithPercentage[tier] = {
      ...stats,
      percentage: totalRequests > 0 ? (stats.count / totalRequests) * 100 : 0,
    };
  }

  const byModelWithPercentage: Record<string, { count: number; cost: number; percentage: number }> =
    {};
  for (const [model, stats] of Object.entries(allByModel)) {
    byModelWithPercentage[model] = {
      ...stats,
      percentage: totalRequests > 0 ? (stats.count / totalRequests) * 100 : 0,
    };
  }

  const totalSavings = totalBaselineCost - totalCost;
  const savingsPercentage = totalBaselineCost > 0 ? (totalSavings / totalBaselineCost) * 100 : 0;

  return {
    period: days === 1 ? "today" : `last ${days} days`,
    totalRequests,
    totalCost,
    totalBaselineCost,
    totalSavings,
    savingsPercentage,
    avgLatencyMs: totalRequests > 0 ? totalLatency / totalRequests : 0,
    avgCostPerRequest: totalRequests > 0 ? totalCost / totalRequests : 0,
    byTier: byTierWithPercentage,
    byModel: byModelWithPercentage,
    dailyBreakdown: dailyBreakdown.reverse(), // Oldest first for charts
    entriesWithBaseline,
    upstreamRequests,
    estimatedRequests,
    truncatedRequests,
  };
}

/**
 * Format stats as ASCII table for terminal display.
 */
export function formatStatsAscii(stats: AggregatedStats): string {
  const lines: string[] = [];

  // Header
  lines.push("╔════════════════════════════════════════════════════════════╗");
  lines.push(`║          NexusRouter v${VERSION}`.padEnd(61) + "║");
  lines.push("║                Usage Statistics                            ║");
  lines.push("╠════════════════════════════════════════════════════════════╣");

  // Summary
  lines.push(`║  Period: ${stats.period.padEnd(49)}║`);
  lines.push(`║  Total Requests: ${stats.totalRequests.toString().padEnd(41)}║`);
  lines.push(`║  Total Cost: ¥${stats.totalCost.toFixed(4).padEnd(43)}║`);
  lines.push(`║  Baseline Cost: ¥${stats.totalBaselineCost.toFixed(4).padEnd(43)}║`);

  // Usage-source breakdown
  lines.push("╠════════════════════════════════════════════════════════════╣");
  lines.push(`║  Upstream usage: ${stats.upstreamRequests.toString().padEnd(40)}║`);
  lines.push(`║  Estimated usage: ${stats.estimatedRequests.toString().padEnd(40)}║`);
  if (stats.truncatedRequests > 0) {
    lines.push(`║  Truncated streams: ${stats.truncatedRequests.toString().padEnd(38)}║`);
  }

  // Show savings with note if some entries lack baseline tracking
  const savingsLine = `║  💰 Total Saved: ¥${stats.totalSavings.toFixed(4)} (${stats.savingsPercentage.toFixed(1)}%)`;
  if (stats.entriesWithBaseline < stats.totalRequests && stats.entriesWithBaseline > 0) {
    lines.push(savingsLine.padEnd(61) + "║");
    const note = `║     (based on ${stats.entriesWithBaseline}/${stats.totalRequests} tracked requests)`;
    lines.push(note.padEnd(61) + "║");
  } else {
    lines.push(savingsLine.padEnd(61) + "║");
  }
  lines.push(`║  Avg Latency: ${stats.avgLatencyMs.toFixed(0)}ms`.padEnd(61) + "║");

  // Tier breakdown
  lines.push("╠════════════════════════════════════════════════════════════╣");
  lines.push("║  Routing by Tier:                                          ║");

  // Show all tiers found in data, ordered by known tiers first then others
  const knownTiers = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING", "DIRECT"];
  const allTiers = Object.keys(stats.byTier);
  const otherTiers = allTiers.filter((t) => !knownTiers.includes(t));
  const tierOrder = [...knownTiers.filter((t) => stats.byTier[t]), ...otherTiers];

  for (const tier of tierOrder) {
    const data = stats.byTier[tier];
    if (data) {
      const bar = "█".repeat(Math.min(20, Math.round(data.percentage / 5)));
      const displayTier = tier === "UNKNOWN" ? "OTHER" : tier;
      const line = `║    ${displayTier.padEnd(10)} ${bar.padEnd(20)} ${data.percentage.toFixed(1).padStart(5)}% (${data.count})`;
      lines.push(line.padEnd(61) + "║");
    }
  }

  // Top models
  lines.push("╠════════════════════════════════════════════════════════════╣");
  lines.push("║  Top Models:                                               ║");

  const sortedModels = Object.entries(stats.byModel)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5);

  for (const [model, data] of sortedModels) {
    const shortModel = model.length > 25 ? model.slice(0, 22) + "..." : model;
    const line = `║    ${shortModel.padEnd(25)} ${data.count.toString().padStart(5)} reqs  ¥${data.cost.toFixed(4)}`;
    lines.push(line.padEnd(61) + "║");
  }

  // Daily breakdown (last 7 days)
  if (stats.dailyBreakdown.length > 0) {
    lines.push("╠════════════════════════════════════════════════════════════╣");
    lines.push("║  Daily Breakdown:                                          ║");
    lines.push("║    Date        Requests    Cost      Saved                 ║");

    for (const day of stats.dailyBreakdown.slice(-7)) {
      const saved = day.totalBaselineCost - day.totalCost;
      const line = `║    ${day.date}   ${day.totalRequests.toString().padStart(6)}    ¥${day.totalCost.toFixed(4).padStart(8)}  ¥${saved.toFixed(4)}`;
      lines.push(line.padEnd(61) + "║");
    }
  }

  lines.push("╚════════════════════════════════════════════════════════════╝");

  return lines.join("\n");
}
