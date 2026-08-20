/**
 * NexusRouter
 *
 * Smart LLM router — direct model API calls, no payments.
 * Routes each request to the most appropriate model.
 *
 * Usage:
 *   # Start the server
 *   npx nexusrouter
 *
 *   # Or as a library
 *   import { startServer, loadConfig } from 'nexusrouter';
 */

import { startServer, createServer } from "./server.js";
import { loadConfig, ConfigSchema, type Config } from "./config/loader.js";
import { OllamaClient } from "./ollama/client.js";
import { HybridClassifier, type HybridConfig } from "./classifier/hybrid.js";
import type { ClassificationResult, HeuristicContext } from "./ollama/client.js";
import { VERSION } from "./version.js";

// Re-export router types
export type { RoutingDecision, RoutingConfig, Tier } from "./router/index.js";
export {
  route,
  getFallbackChain,
  getFallbackChainFiltered,
  filterByToolCalling,
  filterByVision,
  calculateModelCost,
} from "./router/index.js";

// Re-export config
export { loadConfig, ConfigSchema };
export type { Config } from "./config/loader.js";

// Re-export classifier
export { HybridClassifier };
export type { HybridConfig } from "./classifier/hybrid.js";
export type { ClassificationResult, HeuristicContext } from "./ollama/client.js";

// Re-export Ollama client
export { OllamaClient };

// Re-export session
export { SessionStore, getSessionId, deriveSessionId, hashRequestContent } from "./session.js";
export type { SessionEntry, SessionConfig } from "./session.js";

// Re-export dedup
export { RequestDeduplicator } from "./dedup.js";
export type { CachedResponse } from "./dedup.js";

// Re-export response cache
export { ResponseCache } from "./response-cache.js";
export type { CachedLLMResponse, ResponseCacheConfig } from "./response-cache.js";

// Re-export retry
export { fetchWithRetry, isRetryable, DEFAULT_RETRY_CONFIG } from "./retry.js";
export type { RetryConfig } from "./retry.js";

// Re-export stats
export { getStats, formatStatsAscii } from "./stats.js";
export type { DailyStats, AggregatedStats } from "./stats.js";

// Re-export logger. `flushLogs` matters to embedders: routing decisions are
// batched, so up to `flushIntervalMs` of them live only in memory at exit.
export { logUsage, flushLogs, flushLogsSync, logWriterState } from "./logger.js";
export type { UsageEntry } from "./logger.js";

// Re-export log path resolution (single source of truth for the log dir)
export { resolveLogDir, defaultLogDir, logFilePath } from "./paths.js";
export type { LogKind } from "./paths.js";

// Re-export tiered pricing (Savings Ledger 决策 2). `costOf` returns null for an
// unknown model — never 0, which would read as "this request was free".
export {
  costOf,
  resolvePrice,
  emptyUsage,
  isRoutingPlaceholder,
  DEFAULT_CACHE_MULTIPLIERS,
} from "./pricing/price-book.js";
export type {
  TokenUsage,
  ModelPrice,
  CacheMultipliers,
  PriceOverride,
  PriceOverrides,
} from "./pricing/price-book.js";

// Re-export counterfactual accounting (Savings Ledger 决策 1)
export { resolveBaseline } from "./accounting/baseline.js";
export type {
  BaselineMode,
  BaselineOptions,
  BaselineInput,
  BaselineResult,
} from "./accounting/baseline.js";

// Re-export errors
export {
  ConfigurationError,
  ProviderError,
  ClassificationError,
  RoutingError,
  isConfigurationError,
  isProviderError,
  isClassificationError,
  isRoutingError,
} from "./errors.js";

// Version
export { USER_AGENT } from "./version.js";

/**
 * Wait for server health check to pass.
 * Returns true if healthy within timeout, false otherwise.
 */
export async function waitForServerHealth(port: number, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// Default plugin export (for OpenClaw compatibility)
export default {
  name: "nexusrouter",
  version: VERSION,
  async start(context: { port?: number } = {}) {
    const port = context.port || 8402;
    await startServer(undefined, port);
    await waitForServerHealth(port);
  },
};
