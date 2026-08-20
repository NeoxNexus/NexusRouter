/**
 * Baseline resolver — the counterfactual side of the ledger (决策 1).
 *
 * "How much would this request have cost without NexusRouter?" Claude Code and
 * Cursor answer that question for free: they never send `auto`, they send a real
 * model name, so the counterfactual is already in the request. `requestedModel`
 * was being recorded all along and never used for pricing.
 *
 * The method is deliberately named in the output: `same-usage-repricing` assumes
 * the baseline model would have produced the *same* token counts. That is not
 * strictly true — a different model may be terser or more verbose. Labeling the
 * assumption is the difference between a number that survives outside scrutiny
 * and a marketing figure.
 *
 * Three distinct outcomes, and they must not be conflated:
 *   - a number  → measured
 *   - `0`       → measured, and the router happened to pick what was asked for
 *   - `null`    → not measured (mode off, no baseline, or an unpriced model)
 */

import {
  costOf,
  isRoutingPlaceholder,
  type PriceOverrides,
  type TokenUsage,
} from "../pricing/price-book.js";

export type BaselineMode = "requested" | "reference" | "off";

export type BaselineOptions = {
  mode: BaselineMode;
  /** Used by `reference` mode, and by `requested` when the client sent a placeholder. */
  referenceModel?: string;
  /** Deployment price overrides, passed through to the price book. */
  prices?: PriceOverrides;
};

export type BaselineInput = {
  usage: TokenUsage;
  /** Model that actually served the request (provider prefix included). */
  actualModel: string;
  /** Cost of `actualModel`, or null when its price is unknown. */
  actualCostUsd: number | null;
  /** Model the client asked for — the counterfactual, when it is a real model. */
  requestedModel: string;
};

export type BaselineResult = {
  baselineModel: string | null;
  baselineCostUsd: number | null;
  baselineMethod: "same-usage-repricing" | "none";
  /** baseline − actual. Negative is kept as-is: routing up really does cost more. */
  savedUsd: number | null;
};

const NOT_MEASURED: BaselineResult = {
  baselineModel: null,
  baselineCostUsd: null,
  baselineMethod: "none",
  savedUsd: null,
};

/** Which model the counterfactual should be priced against, if any. */
function pickBaselineModel(input: BaselineInput, options: BaselineOptions): string | null {
  if (options.mode === "reference") return options.referenceModel ?? null;

  // `requested`: the client's own model, unless it is a routing placeholder —
  // `auto` names no model, so there is nothing to reprice against.
  if (isRoutingPlaceholder(input.requestedModel) || !input.requestedModel.trim()) {
    return options.referenceModel ?? null;
  }
  return input.requestedModel;
}

/**
 * Resolve the baseline cost and the resulting saving.
 *
 * Pure function — no config reads, no clock, no I/O — so the accounting semantics
 * can be exercised without a server.
 */
export function resolveBaseline(input: BaselineInput, options: BaselineOptions): BaselineResult {
  if (options.mode === "off") return NOT_MEASURED;

  const baselineModel = pickBaselineModel(input, options);
  if (!baselineModel) return NOT_MEASURED;

  const baselineCostUsd = costOf(input.usage, baselineModel, options.prices);
  if (baselineCostUsd === null) {
    // The model is real but nobody has supplied its rates. Keep it visible
    // instead of substituting some other model's price, which would fabricate
    // exactly the dollar figure this ledger exists to stop fabricating.
    return { baselineModel, baselineCostUsd: null, baselineMethod: "none", savedUsd: null };
  }

  return {
    baselineModel,
    baselineCostUsd,
    baselineMethod: "same-usage-repricing",
    savedUsd: input.actualCostUsd === null ? null : baselineCostUsd - input.actualCostUsd,
  };
}
