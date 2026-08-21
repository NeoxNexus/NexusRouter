/**
 * Usage Logger
 *
 * Logs every LLM request as a JSON line to a daily log file.
 * Files: ~/.nexus-router/logs/usage-YYYY-MM-DD.jsonl
 *        ~/.nexus-router/logs/routing-YYYY-MM-DD.jsonl
 *
 * MVP: append-only JSON lines. No rotation, no cleanup.
 * Logging never breaks the request flow — all errors are swallowed.
 *
 * Two write paths on purpose (Savings Ledger design, 决策 5):
 *   - `logRoutingDecision()` — durable on await, one `appendFile` per call.
 *     Kept for tests and tooling that read the file right after awaiting.
 *   - `queueRoutingDecision()` — synchronous enqueue, batched by `LedgerWriter`.
 *     This is the request-path variant: per-request `appendFile` caps throughput
 *     at ~2,959 req/s, batching measured 139,537 req/s.
 */

import { appendFile } from "node:fs/promises";
import { ensureLogDir, logFilePath, resolveLogDir } from "./paths.js";
import { LedgerWriter } from "./accounting/ledger-writer.js";
import type { TokenUsage } from "./pricing/price-book.js";

/** @deprecated Legacy v1 schema. Kept for backward-compatible reads. */
export type UsageEntry = {
  timestamp: string;
  model: string;
  tier: string;
  cost: number;
  baselineCost: number;
  savings: number; // 0-1 percentage
  latencyMs: number;
  /** Input (prompt) tokens reported by the provider */
  inputTokens?: number;
  /** Partner service ID (e.g., "x_users_lookup") — only set for partner API calls */
  partnerId?: string;
  /** Partner service name (e.g., "AttentionVC") — only set for partner API calls */
  service?: string;
};

/** Savings Ledger v2 usage entry. `schema: 2` is the discriminator. */
export type UsageEntryV2 = {
  schema: 2;
  timestamp: string;
  /** Tier the router chose (SIMPLE / MEDIUM / COMPLEX / REASONING / DIRECT). */
  tier: string;
  /** Model that actually served the request, provider prefix included. */
  model: string;
  usage: TokenUsage;
  usageSource: "upstream" | "estimated" | "partial";
  /** Actual cost in USD, or null when the model's price is unknown. */
  costUsd: number | null;
  /** Counterfactual model, or null when no baseline was computed. */
  baselineModel: string | null;
  /** Counterfactual cost, or null when unpriced or mode off. */
  baselineCostUsd: number | null;
  baselineMethod: "same-usage-repricing" | "none";
  /** baseline − actual; null when either side is unknown. */
  savedUsd: number | null;
  /** True when the client aborted or the stream errored before the end. */
  truncated?: boolean;
  latencyMs: number;
};

const PROMPT_PREVIEW_MAX = 200;

/**
 * Process-wide batching writer. Its timer is unref'd, so it never holds the
 * process open; `flushLogs()` / the exit hooks drain whatever is left.
 */
const writer = new LedgerWriter();

/** Drain queued log lines. Call before exiting so nothing is lost. */
export function flushLogs(): Promise<void> {
  return writer.flush();
}

/** Synchronous drain for `process.on("exit")`, where async work cannot run. */
export function flushLogsSync(): void {
  writer.flushSync();
}

/** Ledger state for `/health` (决策 6 / L3). */
export function logWriterState(): {
  pending: number;
  droppedLines: number;
  writeFailures: number;
  degraded: boolean;
  degradedReason: string | null;
} {
  return {
    pending: writer.pending,
    droppedLines: writer.droppedLines,
    writeFailures: writer.writeFailures,
    degraded: writer.degraded,
    degradedReason: writer.degradedReason,
  };
}

/**
 * Log a usage entry as a JSON line.
 */
export async function logUsage(entry: UsageEntry): Promise<void> {
  try {
    const dir = resolveLogDir();
    await ensureLogDir(dir);
    const date = entry.timestamp.slice(0, 10); // YYYY-MM-DD
    await appendFile(logFilePath("usage", date, dir), JSON.stringify(entry) + "\n");
  } catch {
    // Never break the request flow
  }
}

/**
 * One routing decision, recorded per request.
 *
 * `classifierTier` vs `finalTier` are kept separate on purpose: the gap between
 * them is the agent profile's hint fusion, which is otherwise invisible.
 */
export type RoutingLogEntry = {
  timestamp: string;
  agent: string;
  protocol: "anthropic" | "openai";
  /** Model the client asked for ("auto", or an explicit provider/model) */
  requestedModel: string;
  /** Tier the classifier produced, before hint fusion */
  classifierTier: string;
  /** Tier actually used, after hint fusion */
  finalTier: string;
  /** Model forwarded upstream, provider prefix included */
  finalModel: string;
  layer: "rule" | "heuristic" | "ai" | "fallback";
  reason: string;
  confidence: number;
  hasTools: boolean;
  toolCount: number;
  /** This turn actually asks for an action (inferToolRequirement), not merely that a schema is attached. */
  requiresTools: boolean;
  hasThinking: boolean;
  hasSystemPrompt: boolean;
  messageCount: number;
  promptChars: number;
  /** Length of the text after profile-level boilerplate stripping (pre-classifier). */
  promptCharsSanitized: number;
  promptPreview: string;
  stream: boolean;
  classifyLatencyMs: number;
  upstreamStatus?: number;
  totalLatencyMs?: number;
};

/**
 * Log a routing decision as a JSON line.
 *
 * Durable on await: the line is on disk once this resolves. Prefer
 * `queueRoutingDecision()` on the request path — this variant costs one
 * `appendFile` per call and is the ~2,959 req/s throughput ceiling.
 *
 * @param dir - override the log directory; defaults to $NEXUSROUTER_LOG_DIR or ~/.nexus-router/logs
 */
export async function logRoutingDecision(
  entry: RoutingLogEntry,
  dir: string = resolveLogDir(),
): Promise<void> {
  try {
    await ensureLogDir(dir);
    const { date, line } = serializeRouting(entry);
    await appendFile(logFilePath("routing", date, dir), line + "\n");
  } catch {
    // Never break the request flow
  }
}

/**
 * Queue a routing decision for batched write. Synchronous, no I/O, never throws
 * — the request path must never await the disk (决策 5).
 *
 * The line lands on disk on the next flush: 64 queued lines, 200 ms, an explicit
 * `flushLogs()`, or process exit.
 */
export function queueRoutingDecision(entry: RoutingLogEntry, dir: string = resolveLogDir()): void {
  const { date, line } = serializeRouting(entry);
  writer.append(logFilePath("routing", date, dir), line);
}

/** Shared by both write paths so they can never drift in shape or truncation. */
function serializeRouting(entry: RoutingLogEntry): { date: string; line: string } {
  const truncated: RoutingLogEntry = {
    ...entry,
    promptPreview: entry.promptPreview.slice(0, PROMPT_PREVIEW_MAX),
  };
  return {
    date: entry.timestamp.slice(0, 10), // YYYY-MM-DD
    line: JSON.stringify(truncated),
  };
}
