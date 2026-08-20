/**
 * Dashboard renderer — pure function from state to ANSI frame lines.
 *
 * No terminal I/O, no clock, no side effects. `renderFrame()` returns the raw
 * lines (without ANSI colors initially) so tests can assert content. The
 * lifecycle layer wraps the result in the alt-screen escape sequences and
 * handles cursor positioning.
 */

import type { DashboardAggregates } from "./aggregator.js";

export type RecentEntry = {
  time: string;
  tier: string;
  model: string;
  tokens: string;
  cache: string;
  cost: string;
  latency: string;
};

export type RouterStatus = {
  online: boolean;
  enabled: boolean;
  persist: boolean;
  degraded: boolean;
};

export type RenderInput = {
  version: string;
  width: number;
  height: number;
  aggregates: DashboardAggregates;
  recent: RecentEntry[];
  router: RouterStatus;
  baselineMode: string;
};

function fmt(n: number, digits = 4): string {
  return n.toFixed(digits);
}

function pad(n: number): string {
  return n.toLocaleString("en-US");
}

function fit(s: string, w: number): string {
  if (s.length > w) return s.slice(0, w - 1) + "…";
  return s.padEnd(w);
}

function fitR(s: string, w: number): string {
  if (s.length > w) return "…" + s.slice(-(w - 1));
  return s.padStart(w);
}

function bar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  return "█".repeat(Math.max(0, Math.min(width, filled))) + "░".repeat(Math.max(0, width - filled));
}

function hLine(w: number, left = "─", mid = "─", right = "─"): string {
  return left + "─".repeat(w - 2) + right;
}

function boxTop(w: number): string {
  return "╔" + "═".repeat(w - 2) + "╗";
}

function boxBottom(w: number): string {
  return "╚" + "═".repeat(w - 2) + "╝";
}

function boxMid(w: number): string {
  return "╠" + "═".repeat(w - 2) + "╣";
}

function row(w: number, content: string): string {
  return "║" + content.padEnd(w - 2) + "║";
}

function twoColRow(w: number, left: string, right: string): string {
  const half = Math.floor((w - 3) / 2);
  const content = fit(left, half) + " ║ " + fit(right, w - half - 5);
  return "║" + content.padEnd(w - 2) + "║";
}

function headerLine(input: RenderInput): string {
  const router = input.router.online
    ? `⬤ router online`
    : `○ router offline`;
  const accounting = input.router.enabled
    ? input.router.degraded
      ? `accounting DEGRADED`
      : `accounting ON`
    : `accounting OFF`;
  const persist = input.router.persist ? "persist: ON" : "persist: OFF";
  const right = `${router}   ${accounting}  ${persist}`;
  const left = `NexusRouter v${input.version} · LIVE`;
  const inner = w(input) - 4;
  const gap = Math.max(1, inner - left.length - right.length);
  return "║ " + left + " ".repeat(gap) + right + " ║";
}

function w(input: RenderInput): number {
  return input.width;
}

export function renderFrame(input: RenderInput): string[] {
  const width = input.width;
  const height = Math.max(20, input.height);
  const lines: string[] = [];

  lines.push(boxTop(width));
  lines.push(headerLine(input));
  lines.push(boxMid(width));

  // Left column: TODAY + THROUGHPUT
  const leftLines: string[] = [];
  leftLines.push(" TODAY");
  leftLines.push(`   requests      ${pad(input.aggregates.totalRequests)}`);
  leftLines.push(`   actual cost   $ ${fmt(input.aggregates.totalCost)}`);
  if (input.baselineMode !== "off" && input.aggregates.entriesWithBaseline > 0) {
    leftLines.push(`   baseline      $ ${fmt(input.aggregates.totalBaselineCost)}`);
    leftLines.push(`   ▲ saved       $ ${fmt(input.aggregates.totalSavings)} (${input.aggregates.totalBaselineCost > 0 ? ((input.aggregates.totalSavings / input.aggregates.totalBaselineCost) * 100).toFixed(1) : "0.0"}%)`);
  }
  leftLines.push(`   usage src     ${pad(input.aggregates.upstreamRequests)} upstream`);
  if (input.aggregates.estimatedRequests > 0) {
    leftLines.push(`                 ${pad(input.aggregates.estimatedRequests)} estimated`);
  }
  if (input.aggregates.partialRequests > 0) {
    leftLines.push(`                 ${pad(input.aggregates.partialRequests)} partial`);
  }
  if (input.aggregates.truncatedRequests > 0) {
    leftLines.push(`   truncated     ${pad(input.aggregates.truncatedRequests)}`);
  }

  leftLines.push("");
  leftLines.push(" THROUGHPUT (last 60s)");
  leftLines.push(`   now           ${input.aggregates.windowThroughput.toFixed(1)} req/s`);
  leftLines.push(`   p50 latency   ${input.aggregates.p50Latency === null ? "—" : `${Math.round(input.aggregates.p50Latency)} ms`}`);
  leftLines.push(`   p95 latency   ${input.aggregates.p95Latency === null ? "—" : `${Math.round(input.aggregates.p95Latency)} ms`}`);

  // Right column: ROUTING BY TIER + TOP MODELS
  const rightLines: string[] = [];
  rightLines.push(" ROUTING BY TIER");
  const tierOrder = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];
  const sortedTiers = Object.entries(input.aggregates.byTier).sort((a, b) => {
    const ai = tierOrder.indexOf(a[0]);
    const bi = tierOrder.indexOf(b[0]);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return b[1].count - a[1].count;
  });

  for (const [tier, data] of sortedTiers) {
    const pct = input.aggregates.totalRequests > 0 ? (data.count / input.aggregates.totalRequests) * 100 : 0;
    const barStr = bar(pct, Math.max(8, Math.floor((width - 45) / 2)));
    const displayTier = tier.padEnd(10);
    rightLines.push(`   ${displayTier} ${barStr} ${pct.toFixed(1).padStart(5)}%  ${pad(data.count)}`);
  }

  rightLines.push("");
  rightLines.push(" TOP MODELS");
  const sortedModels = Object.entries(input.aggregates.byModel)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5);
  for (const [model, data] of sortedModels) {
    const short = model.length > 22 ? model.slice(0, 19) + "..." : model.padEnd(22);
    rightLines.push(`   ${short} ${pad(data.count).padStart(6)} reqs  $${fmt(data.cost)}`);
  }

  // Merge left/right into top section, or single-column if too narrow.
  if (width < 60) {
    for (const l of leftLines) lines.push(row(width, l));
    for (const r of rightLines) lines.push(row(width, r));
  } else {
    const maxTop = Math.max(leftLines.length, rightLines.length);
    for (let i = 0; i < maxTop; i++) {
      const l = leftLines[i] || "";
      const r = rightLines[i] || "";
      lines.push(twoColRow(width, l, r));
    }
  }

  lines.push(boxMid(width));

  // Live recent entries table.
  const liveHeader = " LIVE  time           tier        model                   in/out        cache        cost      latency";
  lines.push(row(width, liveHeader.slice(0, width - 2)));

  const liveRows = Math.max(3, height - lines.length - 6);
  for (let i = 0; i < liveRows; i++) {
    const entry = input.recent[i];
    if (!entry) {
      lines.push(row(width, ""));
      continue;
    }
    const content =
      `      ${fitR(entry.time, 8)}  ${fit(entry.tier, 9)} ${fit(entry.model, 22)} ` +
      `${fitR(entry.tokens, 12)} ${fitR(entry.cache, 10)} ${fitR(entry.cost, 9)} ${fitR(entry.latency, 9)}`;
    lines.push(row(width, content.slice(0, width - 2)));
  }

  lines.push(boxMid(width));

  // Footer.
  const baselineNote = input.baselineMode === "off"
    ? "baseline: off"
    : `baseline: ${input.baselineMode} (same-usage-repricing · approximate)`;
  const footerRight = "q / ctrl+c  exit   1s refresh";
  const footerLeft = baselineNote;
  const inner = width - 4;
  const gap = Math.max(1, inner - footerLeft.length - footerRight.length);
  lines.push("║ " + footerLeft + " ".repeat(gap) + footerRight + " ║");
  lines.push(boxBottom(width));

  // Pad or trim to exact height.
  while (lines.length < height) lines.push(" ".repeat(width));
  if (lines.length > height) lines.length = height;

  return lines;
}

/** Build a RecentEntry from a parsed usage entry. */
export function formatRecentEntry(entry: {
  timestamp: string;
  tier: string;
  model: string;
  usage?: { inputUncached: number; output: number; cacheRead: number };
  cost: number | null;
  latencyMs: number;
}): RecentEntry {
  const date = new Date(entry.timestamp);
  const time = date.toTimeString().slice(0, 8);
  const usage = entry.usage;
  const tokens = usage
    ? `${pad(usage.inputUncached + usage.cacheRead + usage.output)}/${pad(usage.output)}`
    : "—";
  const cache = usage ? `${pad(usage.cacheRead)} r` : "—";
  const cost = entry.cost === null ? "—" : `$${fmt(entry.cost)}`;
  const latency = `${pad(entry.latencyMs)} ms`;
  return { time, tier: entry.tier, model: entry.model, tokens, cache, cost, latency };
}
