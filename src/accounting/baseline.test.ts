import { describe, it, expect } from "vitest";
import { resolveBaseline, type BaselineOptions } from "./baseline.js";
import { costOf, type TokenUsage } from "../pricing/price-book.js";

const USAGE: TokenUsage = {
  inputUncached: 10_000,
  output: 2_000,
  cacheRead: 100_000,
  cacheWrite5m: 5_000,
  cacheWrite1h: 0,
};

const SONNET = "anthropic/claude-sonnet-4.6";
const OPUS = "anthropic/claude-opus-4.6";

/** Cost of USAGE on a given model, so tests never hardcode dollar literals. */
function cost(model: string): number {
  const c = costOf(USAGE, model);
  if (c === null) throw new Error(`test fixture model is unpriced: ${model}`);
  return c;
}

function opts(partial: Partial<BaselineOptions> = {}): BaselineOptions {
  return { mode: "requested", ...partial };
}

describe("resolveBaseline — requested mode (决策 1)", () => {
  it("reprices the same usage at the model the client actually asked for", () => {
    const result = resolveBaseline(
      { usage: USAGE, actualModel: SONNET, actualCostUsd: cost(SONNET), requestedModel: OPUS },
      opts(),
    );

    expect(result.baselineModel).toBe(OPUS);
    expect(result.baselineCostUsd).toBeCloseTo(cost(OPUS), 10);
    expect(result.baselineMethod).toBe("same-usage-repricing");
    expect(result.savedUsd).toBeCloseTo(cost(OPUS) - cost(SONNET), 10);
  });

  it("reports savedUsd === 0 when the router picked the requested model anyway", () => {
    // Defect 8: the old code inferred "tracked" from baseline !== actual, so this
    // case was silently counted as untracked instead of as a real zero.
    const result = resolveBaseline(
      { usage: USAGE, actualModel: OPUS, actualCostUsd: cost(OPUS), requestedModel: OPUS },
      opts(),
    );

    expect(result.savedUsd).toBe(0);
    expect(result.baselineCostUsd).toBeCloseTo(cost(OPUS), 10);
    expect(result.baselineMethod).toBe("same-usage-repricing");
  });

  it("can report a negative saving rather than hiding it", () => {
    // Routing up (cheap request → expensive model) costs more than not routing.
    // A ledger that clamps this at 0 is a marketing number, not an accounting one.
    const result = resolveBaseline(
      { usage: USAGE, actualModel: OPUS, actualCostUsd: cost(OPUS), requestedModel: SONNET },
      opts(),
    );

    expect(result.savedUsd).toBeLessThan(0);
  });

  it("falls back to the reference model when the client sent a routing placeholder", () => {
    // OpenClaw really does send "auto" — there is no counterfactual in the request.
    const result = resolveBaseline(
      { usage: USAGE, actualModel: SONNET, actualCostUsd: cost(SONNET), requestedModel: "auto" },
      opts({ referenceModel: OPUS }),
    );

    expect(result.baselineModel).toBe(OPUS);
    expect(result.baselineCostUsd).toBeCloseTo(cost(OPUS), 10);
    expect(result.baselineMethod).toBe("same-usage-repricing");
  });

  it("reports no baseline when the client sent a placeholder and no reference is configured", () => {
    const result = resolveBaseline(
      { usage: USAGE, actualModel: SONNET, actualCostUsd: cost(SONNET), requestedModel: "auto" },
      opts(),
    );

    expect(result).toEqual({
      baselineModel: null,
      baselineCostUsd: null,
      baselineMethod: "none",
      savedUsd: null,
    });
  });

  it("keeps an unknown requested model visible instead of silently substituting a reference", () => {
    // The four gateway tiers are unpriced today. Quietly repricing them against
    // some other model would invent the very number we refuse to invent.
    const result = resolveBaseline(
      {
        usage: USAGE,
        actualModel: SONNET,
        actualCostUsd: cost(SONNET),
        requestedModel: "anthropic/claude-opus-5",
      },
      opts({ referenceModel: OPUS }),
    );

    expect(result.baselineModel).toBe("anthropic/claude-opus-5");
    expect(result.baselineCostUsd).toBeNull();
    expect(result.baselineMethod).toBe("none");
    expect(result.savedUsd).toBeNull();
  });

  it("uses a deployment price override for the requested model", () => {
    const prices = { "anthropic/claude-opus-5": { input: 10, output: 50 } };
    const result = resolveBaseline(
      {
        usage: USAGE,
        actualModel: SONNET,
        actualCostUsd: cost(SONNET),
        requestedModel: "anthropic/claude-opus-5",
      },
      opts({ prices }),
    );

    expect(result.baselineCostUsd).toBeCloseTo(
      costOf(USAGE, "anthropic/claude-opus-5", prices)!,
      10,
    );
    expect(result.savedUsd).not.toBeNull();
  });
});

describe("resolveBaseline — reference mode", () => {
  it("ignores the requested model and prices the configured reference", () => {
    const result = resolveBaseline(
      { usage: USAGE, actualModel: SONNET, actualCostUsd: cost(SONNET), requestedModel: OPUS },
      opts({ mode: "reference", referenceModel: "anthropic/claude-haiku-4.5" }),
    );

    expect(result.baselineModel).toBe("anthropic/claude-haiku-4.5");
    expect(result.baselineCostUsd).toBeCloseTo(cost("anthropic/claude-haiku-4.5"), 10);
  });

  it("reports no baseline when reference mode has no model configured", () => {
    const result = resolveBaseline(
      { usage: USAGE, actualModel: SONNET, actualCostUsd: cost(SONNET), requestedModel: OPUS },
      opts({ mode: "reference" }),
    );

    expect(result.baselineCostUsd).toBeNull();
    expect(result.baselineMethod).toBe("none");
  });
});

describe("resolveBaseline — off mode", () => {
  it("records no baseline at all, with null rather than 0", () => {
    // null and 0 must stay distinct: aggregation treats them differently, and a
    // 0 here would read as "saved nothing" instead of "not measured".
    const result = resolveBaseline(
      { usage: USAGE, actualModel: SONNET, actualCostUsd: cost(SONNET), requestedModel: OPUS },
      opts({ mode: "off" }),
    );

    expect(result).toEqual({
      baselineModel: null,
      baselineCostUsd: null,
      baselineMethod: "none",
      savedUsd: null,
    });
  });
});

describe("resolveBaseline — unknown actual cost", () => {
  it("returns a baseline cost but no saving when the actual model is unpriced", () => {
    // Half-known is still worth recording: the baseline number is real, the
    // difference is not computable, and savedUsd must say so.
    const result = resolveBaseline(
      {
        usage: USAGE,
        actualModel: "anthropic/claude-opus-5",
        actualCostUsd: null,
        requestedModel: OPUS,
      },
      opts(),
    );

    expect(result.baselineCostUsd).toBeCloseTo(cost(OPUS), 10);
    expect(result.savedUsd).toBeNull();
  });
});
