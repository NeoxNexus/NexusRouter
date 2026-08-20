/**
 * Usage Logger
 *
 * Logs every LLM request as a JSON line to a daily log file.
 * Files: ~/.nexusrouter/logs/usage-YYYY-MM-DD.jsonl
 *        ~/.nexusrouter/logs/routing-YYYY-MM-DD.jsonl
 *
 * MVP: append-only JSON lines. No rotation, no cleanup.
 * Logging never breaks the request flow — all errors are swallowed.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

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

const DEFAULT_LOG_DIR = join(homedir(), ".nexusrouter", "logs");
const PROMPT_PREVIEW_MAX = 200;
const readyDirs = new Set<string>();

/** Resolved per call so NEXUSROUTER_LOG_DIR can be set after module load. */
function resolveLogDir(): string {
  return process.env.NEXUSROUTER_LOG_DIR || DEFAULT_LOG_DIR;
}

async function ensureDir(dir: string): Promise<void> {
  if (readyDirs.has(dir)) return;
  await mkdir(dir, { recursive: true });
  readyDirs.add(dir);
}

/**
 * Log a usage entry as a JSON line.
 */
export async function logUsage(entry: UsageEntry): Promise<void> {
  try {
    const dir = resolveLogDir();
    await ensureDir(dir);
    const date = entry.timestamp.slice(0, 10); // YYYY-MM-DD
    const file = join(dir, `usage-${date}.jsonl`);
    await appendFile(file, JSON.stringify(entry) + "\n");
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
 * @param dir - override the log directory; defaults to $NEXUSROUTER_LOG_DIR or ~/.nexusrouter/logs
 */
export async function logRoutingDecision(
  entry: RoutingLogEntry,
  dir: string = resolveLogDir(),
): Promise<void> {
  try {
    await ensureDir(dir);
    const date = entry.timestamp.slice(0, 10); // YYYY-MM-DD
    const file = join(dir, `routing-${date}.jsonl`);
    const truncated: RoutingLogEntry = {
      ...entry,
      promptPreview: entry.promptPreview.slice(0, PROMPT_PREVIEW_MAX),
    };
    await appendFile(file, JSON.stringify(truncated) + "\n");
  } catch {
    // Never break the request flow
  }
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
 * @param dir - override the log directory; defaults to $NEXUSROUTER_LOG_DIR or ~/.nexusrouter/logs
 */
export async function logOutcome(
  entry: OutcomeLogEntry,
  dir: string = resolveLogDir(),
): Promise<void> {
  try {
    await ensureDir(dir);
    const date = entry.timestamp.slice(0, 10); // YYYY-MM-DD
    const file = join(dir, `routing-outcome-${date}.jsonl`);
    await appendFile(file, JSON.stringify(entry) + "\n");
  } catch {
    // Never break the request flow
  }
}
