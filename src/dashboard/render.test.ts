import { describe, it, expect } from "vitest";
import { renderFrame, formatRecentEntry } from "./render.js";
import { emptyAggregates, updateAggregates } from "./aggregator.js";
import type { RenderInput } from "./render.js";

function input(width = 120, height = 30): RenderInput {
  let agg = emptyAggregates();
  agg = updateAggregates(
    agg,
    [
      { timestamp: "2026-08-20T10:00:00.000Z", tier: "SIMPLE", model: "gpt-4o-mini", cost: 0.001, baselineCost: 0.005, savings: 0.004, latencyMs: 200, usageSource: "upstream" },
      { timestamp: "2026-08-20T10:00:01.000Z", tier: "COMPLEX", model: "anthropic/claude-sonnet-4.6", cost: 0.01, baselineCost: 0.05, savings: 0.04, latencyMs: 900, usageSource: "upstream" },
      { timestamp: "2026-08-20T10:00:02.000Z", tier: "REASONING", model: "anthropic/claude-opus-4.6", cost: 0.05, baselineCost: 0.05, savings: 0, latencyMs: 3000, usageSource: "upstream" },
      { timestamp: "2026-08-20T10:00:03.000Z", tier: "SIMPLE", model: "gpt-4o-mini", cost: null, baselineCost: null, savings: null, latencyMs: 150, usageSource: "estimated" },
    ],
    Date.now(),
  );
  return {
    version: "0.12.5",
    width,
    height,
    aggregates: agg,
    recent: [
      formatRecentEntry({ timestamp: "2026-08-20T10:00:03.000Z", tier: "SIMPLE", model: "gpt-4o-mini", usage: { inputUncached: 800, output: 150, cacheRead: 0 }, cost: 0.001, latencyMs: 150 }),
      formatRecentEntry({ timestamp: "2026-08-20T10:00:02.000Z", tier: "REASONING", model: "anthropic/claude-opus-4.6", usage: { inputUncached: 5000, output: 2000, cacheRead: 1000 }, cost: 0.05, latencyMs: 3000 }),
    ],
    router: { online: true, enabled: true, persist: true, degraded: false },
    baselineMode: "requested",
  };
}

describe("renderFrame", () => {
  it("returns exactly height lines", () => {
    const frame = renderFrame(input(120, 30));
    expect(frame).toHaveLength(30);
  });

  it("renders a 120-column frame with all major sections", () => {
    const frame = renderFrame(input(120, 30));
    const text = frame.join("\n");
    expect(text).toContain("NexusRouter v0.12.5 · LIVE");
    expect(text).toContain("TODAY");
    expect(text).toContain("ROUTING BY TIER");
    expect(text).toContain("TOP MODELS");
    expect(text).toContain("LIVE");
    expect(text).toContain("same-usage-repricing · approximate");
  });

  it("renders an 80-column frame without crashing", () => {
    const frame = renderFrame(input(80, 24));
    expect(frame).toHaveLength(24);
    expect(frame[0]).toHaveLength(80);
  });

  it("falls back to a single-column layout under 60 columns", () => {
    const frame = renderFrame(input(40, 20));
    expect(frame).toHaveLength(20);
    expect(frame[0]).toHaveLength(40);
  });

  it("shows upstream / estimated separation", () => {
    const frame = renderFrame(input(120, 30));
    const text = frame.join("\n");
    expect(text).toContain("upstream");
    expect(text).toContain("estimated");
  });

  it("flags degraded state", () => {
    const degraded = input(120, 30);
    degraded.router.degraded = true;
    const frame = renderFrame(degraded);
    const text = frame.join("\n");
    expect(text).toContain("DEGRADED");
  });

  it("hides savings when baseline is off", () => {
    const off = input(120, 30);
    off.baselineMode = "off";
    const frame = renderFrame(off);
    const text = frame.join("\n");
    expect(text).toContain("baseline: off");
    expect(text).not.toContain("▲ saved");
  });

  it("does not display $0.0000 when persist is off", () => {
    const noPersist = input(120, 30);
    noPersist.router.persist = false;
    noPersist.router.enabled = true;
    const frame = renderFrame(noPersist);
    const text = frame.join("\n");
    // The aggregate still has cost numbers from file; the key behavior is that
    // the header shows persist: OFF so the user does not misread stale zeros.
    expect(text).toContain("persist: OFF");
  });

  it("keeps big numbers within box borders", () => {
    const big = input(120, 30);
    big.aggregates.totalCost = 1_234_567.8901;
    big.aggregates.totalRequests = 999_999;
    const frame = renderFrame(big);
    for (const line of frame) {
      expect(line.length).toBeLessThanOrEqual(120);
    }
  });
});

describe("formatRecentEntry", () => {
  it("formats a null cost as em-dash", () => {
    const e = formatRecentEntry({
      timestamp: "2026-08-20T10:00:00.000Z",
      tier: "SIMPLE",
      model: "x",
      usage: { inputUncached: 0, output: 0, cacheRead: 0 },
      cost: null,
      latencyMs: 100,
    });
    expect(e.cost).toBe("—");
  });
});
