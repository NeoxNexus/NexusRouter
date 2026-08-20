import { describe, it, expect } from "vitest";
import { costOf, resolvePrice, DEFAULT_CACHE_MULTIPLIERS, type TokenUsage } from "./price-book.js";

/** Every field spelled out, so a test never silently relies on a default. */
function usage(partial: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputUncached: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    ...partial,
  };
}

// Registry prices this suite pins against (src/models.ts):
//   anthropic/claude-opus-4.6   $5 / $25 per 1M
//   anthropic/claude-sonnet-4.6 $3 / $15
//   openai/gpt-4o-mini          $0.15 / $0.6
describe("resolvePrice", () => {
  it("returns registry prices with cache multipliers filled in", () => {
    expect(resolvePrice("anthropic/claude-opus-4.6")).toEqual({
      input: 5,
      output: 25,
      ...DEFAULT_CACHE_MULTIPLIERS,
    });
  });

  it("resolves an alias to the model it points at", () => {
    expect(resolvePrice("opus")).toEqual(resolvePrice("anthropic/claude-opus-4.6"));
  });

  it("resolves a bare model name without the provider prefix", () => {
    // Claude Code sends `claude-sonnet-4.6`, config carries `anthropic/claude-sonnet-4.6`.
    expect(resolvePrice("claude-sonnet-4.6")).toEqual(resolvePrice("anthropic/claude-sonnet-4.6"));
  });

  it("returns null for an unknown model — never a zero price", () => {
    // The four gateway tiers in the repo config.yaml are exactly this case.
    expect(resolvePrice("anthropic/claude-opus-5")).toBeNull();
    expect(resolvePrice("")).toBeNull();
  });

  it("refuses to price routing meta-models", () => {
    // `auto` / `eco` / `premium` carry inputPrice 0 in the registry because they
    // are placeholders the router replaces. Pricing them would report $0 for a
    // request that really cost money.
    for (const meta of ["auto", "eco", "premium", "free"]) {
      expect(resolvePrice(meta)).toBeNull();
    }
  });

  it("lets a config override price an unregistered model", () => {
    // How a deployment teaches NexusRouter its gateway's real rates without
    // anyone inventing numbers inside the product.
    const overrides = { "anthropic/claude-opus-5": { input: 7.5, output: 37.5 } };
    expect(resolvePrice("anthropic/claude-opus-5", overrides)).toEqual({
      input: 7.5,
      output: 37.5,
      ...DEFAULT_CACHE_MULTIPLIERS,
    });
  });

  it("prefers an override over the registry for the same id", () => {
    const overrides = { "anthropic/claude-opus-4.6": { input: 1, output: 2 } };
    expect(resolvePrice("anthropic/claude-opus-4.6", overrides)?.input).toBe(1);
  });

  it("keeps explicit multipliers from an override", () => {
    const overrides = {
      "gw/custom": { input: 10, output: 20, cacheRead: 0.05, cacheWrite5m: 1.1, cacheWrite1h: 1.9 },
    };
    expect(resolvePrice("gw/custom", overrides)).toEqual({
      input: 10,
      output: 20,
      cacheRead: 0.05,
      cacheWrite5m: 1.1,
      cacheWrite1h: 1.9,
    });
  });
});

describe("costOf", () => {
  it("sums the five token tiers at their own rates (决策 2)", () => {
    // (1000×5 + 10000×5×0.10 + 2000×5×1.25 + 0 + 500×25) / 1e6
    const cost = costOf(
      usage({ inputUncached: 1000, cacheRead: 10_000, cacheWrite5m: 2000, output: 500 }),
      "anthropic/claude-opus-4.6",
    );
    expect(cost).toBeCloseTo(0.035, 10);
  });

  it("prices cache reads at 0.1× input", () => {
    // The single largest real cost item in long Claude Code sessions: pricing
    // these at full rate (or at 0) is wrong by an order of magnitude.
    expect(costOf(usage({ cacheRead: 1_000_000 }), "anthropic/claude-opus-4.6")).toBeCloseTo(
      0.5,
      10,
    );
    expect(costOf(usage({ inputUncached: 1_000_000 }), "anthropic/claude-opus-4.6")).toBeCloseTo(
      5,
      10,
    );
  });

  it("prices 5m cache writes at 1.25× and 1h writes at 2×", () => {
    expect(costOf(usage({ cacheWrite5m: 1_000_000 }), "anthropic/claude-opus-4.6")).toBeCloseTo(
      6.25,
      10,
    );
    expect(costOf(usage({ cacheWrite1h: 1_000_000 }), "anthropic/claude-opus-4.6")).toBeCloseTo(
      10,
      10,
    );
  });

  it("returns 0 for all-zero usage, not NaN", () => {
    const cost = costOf(usage(), "openai/gpt-4o-mini");
    expect(cost).toBe(0);
    expect(Number.isNaN(cost)).toBe(false);
  });

  it("returns null for an unknown model so callers cannot mistake it for free", () => {
    expect(costOf(usage({ output: 1_000_000 }), "anthropic/claude-opus-5")).toBeNull();
  });

  it("keeps 0 for a genuinely free model (0 price is not the same as unknown)", () => {
    expect(costOf(usage({ inputUncached: 5000, output: 5000 }), "nvidia/gpt-oss-120b")).toBe(0);
  });

  it("falls back to the standard 2× for a model with no 1h multiplier defined", () => {
    // Dropping those tokens instead would understate cost — the failure mode
    // this whole ledger exists to avoid.
    const overrides = { "gw/no-1h": { input: 4, output: 8, cacheWrite1h: undefined } };
    expect(costOf(usage({ cacheWrite1h: 1_000_000 }), "gw/no-1h", overrides)).toBeCloseTo(8, 10);
  });

  it("treats negative or non-finite token counts as 0 instead of producing junk", () => {
    // A malformed upstream payload must not yield a negative or NaN dollar figure.
    const bad = { ...usage({ output: 100 }), inputUncached: -5_000_000, cacheRead: NaN };
    expect(costOf(bad, "anthropic/claude-opus-4.6")).toBeCloseTo(0.0025, 10);
  });
});
