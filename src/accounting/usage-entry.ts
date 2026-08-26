/**
 * Ledger entry builder — the pure half of usage recording.
 *
 * `recordUsage()` in `server.ts` owns the I/O (which file, which day, swallow
 * errors). Everything that decides *what number goes in the row* lives here so
 * it can be tested without a server, a config file, or a writable directory —
 * the same discipline `baseline.ts` and `price-book.ts` already follow.
 *
 * The split exists for a concrete reason. When this logic was inline, the
 * fallback-estimation call and the fields that were supposed to consume it drifted
 * apart: `applyFallbackEstimation` returned a corrected capture into a local that
 * nothing read, and the entry kept pricing the original all-zero usage. The
 * estimator's own unit tests stayed green throughout, because the defect was in
 * the wiring, not the estimator. A pure builder gives that wiring a test surface.
 *
 * Order matters and is load-bearing: estimate first, then price the estimate.
 * Every field below must derive from `capture`, never from `input.capture`.
 */

import { applyFallbackEstimation, type UsageCapture } from "../adapter/usage-sniffer.js";
import { costOf, type PriceOverrides } from "../pricing/price-book.js";
import { resolveBaseline, type BaselineMode } from "./baseline.js";
import type { UsageEntryV2 } from "../logger.js";

export type UsageEntryInput = {
  /** ISO timestamp for the row. Injected rather than read from the clock. */
  timestamp: string;
  /** Tier the router chose, or "DIRECT" when it did not route. */
  tier: string;
  /** Model that actually served the request, provider prefix included. */
  finalModelWithProvider: string;
  /** Model the client asked for — the counterfactual for the saving. */
  requestedModel: string;
  /** Usage as reported by the upstream, before any fallback estimation. */
  capture: UsageCapture;
  latencyMs: number;
  /** When true, missing token counts are estimated from payload length. */
  estimateMissingTokens: boolean;
  baselineMode: BaselineMode;
  referenceModel?: string;
  priceOverrides?: PriceOverrides;
  /** Raw request body, used to estimate input tokens. */
  rawBody?: unknown;
  /** Non-streaming response body, used to estimate output tokens. */
  responseBody?: string;
  /** Streaming byte count, used when there is no response body. */
  responseBytes?: number;
  /** Accumulated streaming delta content text; preferred over responseBytes. */
  responseContentText?: string;
};

/**
 * Build the ledger row for one request.
 *
 * Pure: no clock, no I/O, no config reads beyond the arguments handed in.
 */
export function buildUsageEntry(input: UsageEntryInput): UsageEntryV2 {
  // Estimate before pricing. Everything after this line reads `capture`.
  const capture = applyFallbackEstimation(input.capture, {
    estimateMissingTokens: input.estimateMissingTokens,
    rawBody: input.rawBody,
    responseBody: input.responseBody,
    responseBytes: input.responseBytes,
    responseContentText: input.responseContentText,
    model: input.finalModelWithProvider,
  });

  const costUsd = costOf(capture.usage, input.finalModelWithProvider, input.priceOverrides);

  const baseline = resolveBaseline(
    {
      usage: capture.usage,
      actualModel: input.finalModelWithProvider,
      actualCostUsd: costUsd,
      requestedModel: input.requestedModel,
    },
    {
      mode: input.baselineMode,
      referenceModel: input.referenceModel,
      prices: input.priceOverrides,
    },
  );

  return {
    schema: 2,
    timestamp: input.timestamp,
    tier: input.tier,
    model: input.finalModelWithProvider,
    usage: capture.usage,
    usageSource: capture.usageSource,
    costUsd,
    baselineModel: baseline.baselineModel,
    baselineCostUsd: baseline.baselineCostUsd,
    baselineMethod: baseline.baselineMethod,
    savedUsd: baseline.savedUsd,
    truncated: capture.truncated,
    latencyMs: input.latencyMs,
  };
}
