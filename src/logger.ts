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
import { join } from "node:path";
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
 * Wider than PROMPT_PREVIEW_MAX: this is the text a human labels against the
 * tier taxonomy, and 200 chars truncates mid-instruction on the long Chinese
 * prompts that dominate real traffic.
 */
const CLASSIFICATION_PREVIEW_MAX = 600;

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
  /** True when the maxTokensForceComplex context guardrail raised the tier to COMPLEX. */
  contextForcedComplex?: boolean;
  /** Model forwarded upstream, provider prefix included */
  finalModel: string;
  /**
   * Model that actually served the request (provider prefix included) — set
   * only when a tier fallback served it; absent means finalModel served.
   */
  servedModel?: string;
  /**
   * Failed upstream attempts before the request was served (or gave up),
   * including the primary failure that opened the fallback path. Absent = 0.
   */
  fallbackAttempts?: number;
  layer: "rule" | "heuristic" | "ai" | "fallback";
  reason: string;
  /** Substring that fired a Layer 0 rule — the field a word list is tuned against. */
  matched?: string;
  /**
   * Raw Layer 1 score. Present even when `confidence` reports the Layer 3
   * fallback value, so `heuristicThreshold` can be tuned against the real
   * distribution instead of guessed at.
   */
  heuristicScore?: number;
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
  /**
   * True when the classified text came from an earlier turn because the latest
   * user turn carried no text (tool_result blocks). Absent = the latest turn
   * was classified. Stratify eval samples on this: carried-over rows say
   * nothing about how the router handles the turn actually in flight.
   */
  classificationStale?: boolean;
  /** How many turns back the classified text came from. Absent when fresh. */
  classificationAgeTurns?: number;
  /**
   * Name of the skill whose injection was skipped while locating the
   * classification text (D-009). Observability only — it carries no routing
   * weight yet; whether skill identity earns a tier floor is decided by the
   * labeled-eval correlation check (classifier-improvements.md 2026-09-01).
   */
  activeSkill?: string;
  promptPreview: string;
  /**
   * The classifier's own input, truncated. `promptPreview` is every user
   * message concatenated (16k+ chars in real traffic) and its 200-char cut
   * routinely shows none of the scored text, which makes annotation
   * impossible. This field is what a labeler reads. Optional because logs
   * written before 2026-08-27 have no equivalent.
   */
  classificationPreview?: string;
  /**
   * Body size estimate (~4 chars/token) behind the `contextForcedComplex`
   * decision. The boolean alone hides how close a request sat to
   * `maxTokensForceComplex`, so the threshold cannot be tuned from logs.
   */
  estimatedTokens?: number;
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
    ...(entry.classificationPreview !== undefined
      ? {
          classificationPreview: entry.classificationPreview.slice(0, CLASSIFICATION_PREVIEW_MAX),
        }
      : {}),
  };
  return {
    date: entry.timestamp.slice(0, 10), // YYYY-MM-DD
    line: JSON.stringify(truncated),
  };
}

/**
 * A post-hoc signal attached to an already-logged routing entry.
 *
 * Routing JSONL is append-only, so the "user retried — the previous answer
 * was likely bad" signal can't be patched onto the old row. It is appended
 * here as a companion record instead, joined back by `timestamp` (the ISO
 * timestamp of the routing entry it refers to). The file date also comes
 * from that referenced entry so the outcome lands next to its subject.
 */
export type OutcomeLogEntry = {
  /** Timestamp of the RoutingLogEntry this outcome refers to (join key). */
  timestamp: string;
  outcome: "retried";
  retryReason: "same-text" | "model-switch";
};

/**
 * Log an outcome companion record as a JSON line.
 *
 * @param dir - override the log directory; defaults to $NEXUSROUTER_LOG_DIR or ~/.nexus-router/logs
 */
export async function logOutcome(
  entry: OutcomeLogEntry,
  dir: string = resolveLogDir(),
): Promise<void> {
  try {
    await ensureLogDir(dir);
    const date = entry.timestamp.slice(0, 10); // YYYY-MM-DD
    const file = join(dir, `routing-outcome-${date}.jsonl`);
    await appendFile(file, JSON.stringify(entry) + "\n");
  } catch {
    // Never break the request flow
  }
}
