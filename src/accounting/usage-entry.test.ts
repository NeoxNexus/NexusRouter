/**
 * Regression tests for the ledger entry builder.
 *
 * The defect these exist to prevent: `applyFallbackEstimation` was called and
 * its result discarded, so every downstream field (usage, costUsd, savedUsd)
 * kept reading the pre-fallback capture. Upstreams that omit usage — MiniMax
 * being the reported case — landed in the ledger as all zeros while the
 * estimation code sat there passing its own unit tests.
 *
 * The assertions below therefore check the *entry*, not the estimator.
 */

import { describe, it, expect } from "vitest";
import { buildUsageEntry, type UsageEntryInput } from "./usage-entry.js";
import { emptyUsage } from "../pricing/price-book.js";
import type { UsageCapture } from "../adapter/usage-sniffer.js";

// Deterministic prices: 1000 units/1M input, 2000 units/1M output. costOf
// divides by 1e6, so 1000 input tokens == 1.0. Using overrides instead of a
// registry model keeps these tests independent of models.ts churn.
const PRICES = {
  "test/actual": { input: 1000, output: 2000 },
  "test/baseline": { input: 4000, output: 8000 },
};

function makeInput(overrides: Partial<UsageEntryInput> = {}): UsageEntryInput {
  return {
    timestamp: "2026-08-26T00:00:00.000Z",
    tier: "SIMPLE",
    finalModelWithProvider: "test/actual",
    requestedModel: "test/baseline",
    capture: { usage: emptyUsage(), usageSource: "estimated", truncated: false },
    latencyMs: 42,
    estimateMissingTokens: true,
    baselineMode: "requested",
    priceOverrides: PRICES,
    ...overrides,
  };
}

const upstreamCapture: UsageCapture = {
  usage: { inputUncached: 1000, output: 500, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  usageSource: "upstream",
  truncated: false,
};

describe("buildUsageEntry — upstream usage present", () => {
  it("uses upstream counts verbatim", () => {
    const entry = buildUsageEntry(makeInput({ capture: upstreamCapture }));
    expect(entry.usage.inputUncached).toBe(1000);
    expect(entry.usage.output).toBe(500);
    expect(entry.usageSource).toBe("upstream");
  });

  it("prices the request from those counts", () => {
    const entry = buildUsageEntry(makeInput({ capture: upstreamCapture }));
    // 1000 × 1000/1e6 + 500 × 2000/1e6 = 1.0 + 1.0
    expect(entry.costUsd).toBeCloseTo(2.0, 10);
  });

  it("does not let estimation touch a complete upstream capture", () => {
    const entry = buildUsageEntry(
      makeInput({
        capture: upstreamCapture,
        rawBody: { messages: [{ content: "x".repeat(100_000) }] },
        responseBytes: 100_000,
      }),
    );
    expect(entry.usage.inputUncached).toBe(1000);
    expect(entry.usage.output).toBe(500);
  });
});

describe("buildUsageEntry — upstream usage missing (the MiniMax case)", () => {
  const missing: UsageCapture = {
    usage: emptyUsage(),
    usageSource: "estimated",
    truncated: false,
  };

  it("writes estimated tokens into the entry instead of zeros", () => {
    const entry = buildUsageEntry(
      makeInput({
        capture: missing,
        rawBody: { messages: [{ role: "user", content: "hello world" }] },
        responseBody: "a response body of some length",
      }),
    );
    expect(entry.usage.inputUncached).toBeGreaterThan(0);
    expect(entry.usage.output).toBeGreaterThan(0);
  });

  it("prices the estimated tokens rather than reporting a free request", () => {
    const entry = buildUsageEntry(
      makeInput({
        capture: missing,
        rawBody: { messages: [{ role: "user", content: "hello world" }] },
        responseBody: "a response body of some length",
      }),
    );
    expect(entry.costUsd).not.toBeNull();
    expect(entry.costUsd as number).toBeGreaterThan(0);
  });

  it("derives the baseline and saving from the estimated tokens", () => {
    const entry = buildUsageEntry(
      makeInput({
        capture: missing,
        rawBody: { messages: [{ role: "user", content: "hello world" }] },
        responseBody: "a response body of some length",
      }),
    );
    expect(entry.baselineModel).toBe("test/baseline");
    expect(entry.baselineCostUsd as number).toBeGreaterThan(0);
    // Baseline is 4× the actual model's rates, so the saving must be positive.
    expect(entry.savedUsd as number).toBeGreaterThan(0);
  });

  it("marks the entry as estimated so the number is never mistaken for measured", () => {
    const entry = buildUsageEntry(
      makeInput({
        capture: missing,
        rawBody: { messages: [{ role: "user", content: "hi" }] },
        responseBytes: 400,
      }),
    );
    expect(entry.usageSource).toBe("estimated");
  });

  it("estimates from stream bytes when there is no response body", () => {
    const entry = buildUsageEntry(
      makeInput({
        capture: missing,
        rawBody: { messages: [{ role: "user", content: "hi" }] },
        responseBytes: 4000,
      }),
    );
    expect(entry.usage.output).toBeGreaterThan(0);
  });

  it("keeps zeros when estimation is switched off", () => {
    const entry = buildUsageEntry(
      makeInput({
        capture: missing,
        estimateMissingTokens: false,
        rawBody: { messages: [{ role: "user", content: "hello world" }] },
        responseBody: "a response body of some length",
      }),
    );
    expect(entry.usage).toEqual(emptyUsage());
    expect(entry.costUsd).toBe(0);
  });
});

describe("buildUsageEntry — partial captures", () => {
  it("keeps upstream input and fills only the missing output", () => {
    const entry = buildUsageEntry(
      makeInput({
        capture: {
          usage: { inputUncached: 777, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
          usageSource: "partial",
          truncated: false,
        },
        rawBody: { messages: [{ content: "x".repeat(10_000) }] },
        responseBytes: 800,
      }),
    );
    expect(entry.usage.inputUncached).toBe(777);
    expect(entry.usage.output).toBeGreaterThan(0);
  });
});

describe("buildUsageEntry — passthrough fields", () => {
  it("carries schema, timestamp, tier, model, latency and truncation", () => {
    const entry = buildUsageEntry(
      makeInput({
        capture: { ...upstreamCapture, truncated: true },
        tier: "COMPLEX",
        latencyMs: 1234,
      }),
    );
    expect(entry.schema).toBe(2);
    expect(entry.timestamp).toBe("2026-08-26T00:00:00.000Z");
    expect(entry.tier).toBe("COMPLEX");
    expect(entry.model).toBe("test/actual");
    expect(entry.latencyMs).toBe(1234);
    expect(entry.truncated).toBe(true);
  });

  it("reports null cost for an unpriced model without inventing a number", () => {
    const entry = buildUsageEntry(
      makeInput({ capture: upstreamCapture, finalModelWithProvider: "vendor/never-heard-of-it" }),
    );
    expect(entry.costUsd).toBeNull();
    expect(entry.savedUsd).toBeNull();
  });

  it("reports no baseline when the mode is off", () => {
    const entry = buildUsageEntry(makeInput({ capture: upstreamCapture, baselineMode: "off" }));
    expect(entry.baselineModel).toBeNull();
    expect(entry.baselineCostUsd).toBeNull();
    expect(entry.baselineMethod).toBe("none");
    expect(entry.savedUsd).toBeNull();
  });
});
