/**
 * Routing-quality evaluation harness (baseline tooling).
 *
 * Pure observation — nothing here influences classification. A labeled file
 * is a routing JSONL that a human annotated with `expectedTier` (and an
 * optional `note`). When the labeled file sits next to
 * routing-outcome-*.jsonl files (written by the server's retry detector),
 * those are joined in by `timestamp` so the report can break out the samples
 * the user implicitly rejected by retrying.
 *
 * The CLI (`nexusrouter eval <labeled.jsonl>`) only parses arguments and
 * prints; all logic lives here so it stays unit-testable.
 */

import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RoutingLogEntry, OutcomeLogEntry } from "./logger.js";

export const TIER_ORDER = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"] as const;
export type Tier = (typeof TIER_ORDER)[number];

/** Tier ranks for the over/under-routed direction analysis. */
const TIER_RANK: Record<string, number> = { SIMPLE: 0, MEDIUM: 1, COMPLEX: 2, REASONING: 3 };

/**
 * Confidence at or above this counts as "the router was sure". Misses in
 * this band are the highest-value tuning input, so they get their own list.
 */
export const HIGH_CONFIDENCE_THRESHOLD = 0.85;

/** Prompt preview cap in the human-readable miss list. */
const MISS_PREVIEW_MAX = 80;

/** A routing log line plus the human annotation. */
export type LabeledEntry = RoutingLogEntry & {
  expectedTier?: string;
  note?: string;
};

export type LabeledSample = {
  entry: LabeledEntry;
  expectedTier: Tier;
  /** Joined from routing-outcome-*.jsonl when the user retried this request. */
  retryReason?: string;
};

export type HighConfidenceMiss = {
  timestamp: string;
  /** First 80 chars of the logged promptPreview. */
  promptPreview: string;
  expectedTier: Tier;
  finalTier: string;
  confidence: number;
  note?: string;
  retryReason?: string;
};

export type EvalReport = {
  file: string;
  /** Non-empty lines in the labeled file. */
  totalLines: number;
  /** Lines with a valid expectedTier — the denominator for all accuracies. */
  labeled: number;
  /** Lines skipped because expectedTier was absent. */
  skippedMissingLabel: number;
  /** Lines skipped because the JSON was broken or expectedTier was unknown. */
  skippedInvalid: number;
  /** finalTier === expectedTier */
  finalAccuracy: number;
  finalCorrect: number;
  /** classifierTier === expectedTier — isolates the hint fusion's net effect. */
  classifierAccuracy: number;
  classifierCorrect: number;
  /** confusionMatrix[expected][final] = count */
  confusionMatrix: Record<string, Record<string, number>>;
  accuracyByLayer: Record<string, { total: number; correct: number; accuracy: number }>;
  /** High-confidence (≥0.85) samples that were routed wrong. */
  highConfidenceMisses: HighConfidenceMiss[];
  /** Asymmetric-cost view: wrong samples split by direction. */
  direction: { correct: number; overRouted: number; underRouted: number };
  /** Samples the user retried (joined from outcome files), and their accuracy. */
  retried: { total: number; correct: number; accuracy: number | null };
};

/**
 * Parse a labeled JSONL file's contents. Lines without `expectedTier` are
 * skipped (they are unlabeled samples), as are broken JSON lines and lines
 * whose expectedTier is not a known tier.
 */
export function parseLabeledJsonl(content: string): {
  samples: LabeledSample[];
  totalLines: number;
  skippedMissingLabel: number;
  skippedInvalid: number;
} {
  const samples: LabeledSample[] = [];
  let totalLines = 0;
  let skippedMissingLabel = 0;
  let skippedInvalid = 0;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    totalLines++;

    let parsed: LabeledEntry;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skippedInvalid++;
      continue;
    }

    if (parsed.expectedTier === undefined || parsed.expectedTier === null) {
      skippedMissingLabel++;
      continue;
    }
    if (!(TIER_ORDER as readonly string[]).includes(parsed.expectedTier)) {
      skippedInvalid++;
      continue;
    }

    samples.push({ entry: parsed, expectedTier: parsed.expectedTier as Tier });
  }

  return { samples, totalLines, skippedMissingLabel, skippedInvalid };
}

/**
 * Read every routing-outcome-*.jsonl in `dir` into a timestamp → retryReason
 * index. Missing/unreadable directories and malformed rows are ignored —
 * outcomes are a bonus signal, never a reason to fail the eval.
 */
export async function loadOutcomeIndex(dir: string): Promise<Map<string, string>> {
  const index = new Map<string, string>();

  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return index;
  }

  for (const file of files) {
    if (!file.startsWith("routing-outcome-") || !file.endsWith(".jsonl")) continue;
    let content: string;
    try {
      content = await readFile(join(dir, file), "utf-8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as OutcomeLogEntry;
        if (parsed.outcome === "retried" && typeof parsed.timestamp === "string") {
          index.set(parsed.timestamp, parsed.retryReason ?? "unknown");
        }
      } catch {
        // Skip malformed outcome rows
      }
    }
  }

  return index;
}

/** Compute the full report from already-parsed samples. Pure function. */
export function computeEvalReport(input: {
  file: string;
  samples: LabeledSample[];
  totalLines: number;
  skippedMissingLabel: number;
  skippedInvalid: number;
}): EvalReport {
  const { samples } = input;
  const labeled = samples.length;

  let finalCorrect = 0;
  let classifierCorrect = 0;
  const confusionMatrix: Record<string, Record<string, number>> = {};
  const byLayer = new Map<string, { total: number; correct: number }>();
  const highConfidenceMisses: HighConfidenceMiss[] = [];
  const direction = { correct: 0, overRouted: 0, underRouted: 0 };
  let retriedTotal = 0;
  let retriedCorrect = 0;

  for (const sample of samples) {
    const { entry, expectedTier } = sample;
    const finalTier = entry.finalTier ?? "unknown";
    const isCorrect = finalTier === expectedTier;

    if (isCorrect) finalCorrect++;
    if (entry.classifierTier === expectedTier) classifierCorrect++;

    const row = (confusionMatrix[expectedTier] ??= {});
    row[finalTier] = (row[finalTier] ?? 0) + 1;

    const layer = entry.layer ?? "unknown";
    const layerStats = byLayer.get(layer) ?? { total: 0, correct: 0 };
    layerStats.total++;
    if (isCorrect) layerStats.correct++;
    byLayer.set(layer, layerStats);

    if (sample.retryReason !== undefined) {
      retriedTotal++;
      if (isCorrect) retriedCorrect++;
    }

    if (isCorrect) {
      direction.correct++;
      continue;
    }

    // Direction of the miss, for the asymmetric-cost view: over-routing
    // wastes money, under-routing wastes quality.
    const expectedRank = TIER_RANK[expectedTier];
    const finalRank = TIER_RANK[finalTier];
    if (expectedRank !== undefined && finalRank !== undefined) {
      if (finalRank > expectedRank) direction.overRouted++;
      else direction.underRouted++;
    }

    if (entry.confidence >= HIGH_CONFIDENCE_THRESHOLD) {
      highConfidenceMisses.push({
        timestamp: entry.timestamp,
        promptPreview: (entry.promptPreview ?? "").slice(0, MISS_PREVIEW_MAX),
        expectedTier,
        finalTier,
        confidence: entry.confidence,
        ...(entry.note ? { note: entry.note } : {}),
        ...(sample.retryReason ? { retryReason: sample.retryReason } : {}),
      });
    }
  }

  return {
    file: input.file,
    totalLines: input.totalLines,
    labeled,
    skippedMissingLabel: input.skippedMissingLabel,
    skippedInvalid: input.skippedInvalid,
    finalAccuracy: labeled ? finalCorrect / labeled : 0,
    finalCorrect,
    classifierAccuracy: labeled ? classifierCorrect / labeled : 0,
    classifierCorrect,
    confusionMatrix,
    accuracyByLayer: Object.fromEntries(
      [...byLayer.entries()].map(([layer, s]) => [
        layer,
        { ...s, accuracy: s.total ? s.correct / s.total : 0 },
      ]),
    ),
    highConfidenceMisses,
    direction,
    retried: {
      total: retriedTotal,
      correct: retriedCorrect,
      accuracy: retriedTotal ? retriedCorrect / retriedTotal : null,
    },
  };
}

/**
 * Load a labeled file, join any sibling outcome files, and compute the report.
 */
export async function evaluateFile(labeledPath: string): Promise<EvalReport> {
  const content = await readFile(labeledPath, "utf-8");
  const parsed = parseLabeledJsonl(content);
  const outcomes = await loadOutcomeIndex(dirname(labeledPath));

  const samples = parsed.samples.map((sample) => {
    const retryReason = outcomes.get(sample.entry.timestamp);
    return retryReason ? { ...sample, retryReason } : sample;
  });

  return computeEvalReport({ file: labeledPath, ...parsed, samples });
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Render the report as human-readable terminal output. */
export function formatEvalReport(report: EvalReport): string {
  const lines: string[] = [];

  lines.push(`Evaluation: ${report.file}`);
  lines.push(
    `Lines: ${report.totalLines} total, ${report.labeled} labeled, ` +
      `${report.skippedMissingLabel} skipped (no expectedTier), ${report.skippedInvalid} invalid`,
  );
  lines.push("");

  if (report.labeled === 0) {
    lines.push("No labeled samples — add an expectedTier field to some lines first.");
    return lines.join("\n");
  }

  const finalCorrect = report.finalCorrect;
  const classifierCorrect = report.classifierCorrect;
  lines.push(`Accuracy (labeled = ${report.labeled}):`);
  lines.push(`  finalTier      === expectedTier: ${pct(report.finalAccuracy)} (${finalCorrect}/${report.labeled})`);
  lines.push(`  classifierTier === expectedTier: ${pct(report.classifierAccuracy)} (${classifierCorrect}/${report.labeled})`);
  lines.push("");

  // Confusion matrix, rows = expected, columns = final. Only tiers that
  // actually appear get a column so narrow files stay readable.
  const finalTiers = TIER_ORDER.filter((t) =>
    Object.values(report.confusionMatrix).some((row) => row[t] !== undefined),
  );
  const extraFinals = Object.values(report.confusionMatrix)
    .flatMap((row) => Object.keys(row))
    .filter((t) => !(TIER_ORDER as readonly string[]).includes(t));
  const columns = [...finalTiers, ...new Set(extraFinals)];

  lines.push("Confusion matrix (rows = expected, columns = final):");
  const headerCell = "expected\\final";
  lines.push(`  ${headerCell.padEnd(16)}${columns.map((c) => c.padStart(10)).join("")}`);
  for (const expected of TIER_ORDER) {
    const row = report.confusionMatrix[expected];
    if (!row) continue;
    lines.push(
      `  ${expected.padEnd(16)}${columns.map((c) => String(row[c] ?? 0).padStart(10)).join("")}`,
    );
  }
  lines.push("");

  lines.push("Accuracy by layer:");
  for (const [layer, s] of Object.entries(report.accuracyByLayer)) {
    lines.push(`  ${layer.padEnd(12)}${pct(s.accuracy)} (${s.correct}/${s.total})`);
  }
  lines.push("");

  const wrong = report.direction.overRouted + report.direction.underRouted;
  lines.push(`Direction of errors (${wrong} wrong):`);
  lines.push(`  over-routed  (final > expected): ${report.direction.overRouted}`);
  lines.push(`  under-routed (final < expected): ${report.direction.underRouted}`);
  lines.push("");

  if (report.retried.total > 0) {
    lines.push(
      `Retry outcomes joined: ${report.retried.total} samples, ` +
        `their accuracy ${pct(report.retried.accuracy ?? 0)} (${report.retried.correct}/${report.retried.total})`,
    );
    lines.push("");
  }

  lines.push(
    `High-confidence misses (confidence >= ${HIGH_CONFIDENCE_THRESHOLD}): ${report.highConfidenceMisses.length}`,
  );
  for (const miss of report.highConfidenceMisses) {
    const retriedTag = miss.retryReason ? ` retried=${miss.retryReason}` : "";
    lines.push(
      `  [${miss.timestamp}] conf=${miss.confidence.toFixed(2)} ` +
        `expected=${miss.expectedTier} final=${miss.finalTier}${retriedTag}`,
    );
    lines.push(`    "${miss.promptPreview}"`);
    if (miss.note) lines.push(`    note: ${miss.note}`);
  }

  return lines.join("\n");
}
