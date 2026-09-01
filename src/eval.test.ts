import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseLabeledJsonl,
  computeEvalReport,
  loadOutcomeIndex,
  evaluateFile,
  formatEvalReport,
  HIGH_CONFIDENCE_THRESHOLD,
  type LabeledEntry,
  type LabeledSample,
} from "./eval.js";

function entry(overrides: Partial<LabeledEntry>): LabeledEntry {
  return {
    timestamp: "2026-08-20T01:00:00.000Z",
    agent: "claude-code",
    protocol: "anthropic",
    requestedModel: "auto",
    classifierTier: "SIMPLE",
    finalTier: "SIMPLE",
    finalModel: "anthropic/cheap-model",
    layer: "rule",
    reason: "greeting",
    confidence: 0.95,
    hasTools: false,
    toolCount: 0,
    requiresTools: false,
    hasThinking: false,
    hasSystemPrompt: false,
    messageCount: 1,
    promptChars: 2,
    promptCharsSanitized: 2,
    promptPreview: "hi",
    stream: false,
    classifyLatencyMs: 1,
    ...overrides,
  };
}

describe("parseLabeledJsonl", () => {
  it("keeps labeled lines, skips unlabeled ones, and counts broken input", () => {
    const content = [
      JSON.stringify(entry({ expectedTier: "SIMPLE" })),
      JSON.stringify(entry({ timestamp: "2026-08-20T01:01:00.000Z" })), // no label
      "this is not json",
      JSON.stringify(entry({ expectedTier: "HUGE" })), // unknown tier
      "", // blank line
      JSON.stringify(entry({ timestamp: "2026-08-20T01:02:00.000Z", expectedTier: "COMPLEX" })),
    ].join("\n");

    const parsed = parseLabeledJsonl(content);

    expect(parsed.totalLines).toBe(5); // blank line not counted
    expect(parsed.samples).toHaveLength(2);
    expect(parsed.skippedMissingLabel).toBe(1);
    expect(parsed.skippedInvalid).toBe(2);
    expect(parsed.samples[1].expectedTier).toBe("COMPLEX");
  });

  it("returns empty stats for an empty file", () => {
    const parsed = parseLabeledJsonl("\n\n");
    expect(parsed).toEqual({
      samples: [],
      totalLines: 0,
      skippedMissingLabel: 0,
      skippedInvalid: 0,
    });
  });
});

describe("computeEvalReport", () => {
  // 6 samples covering: correct, over-routed, under-routed, classifier-vs-final
  // divergence, per-layer split, and a high-confidence miss with a note.
  const samples: LabeledSample[] = [
    // 1. correct (SIMPLE→SIMPLE), rule layer
    { entry: entry({ expectedTier: "SIMPLE", finalTier: "SIMPLE" }), expectedTier: "SIMPLE" },
    // 2. over-routed with high confidence + note → miss list entry
    {
      entry: entry({
        timestamp: "2026-08-20T01:05:00.000Z",
        expectedTier: "SIMPLE",
        classifierTier: "SIMPLE",
        finalTier: "COMPLEX",
        confidence: 0.9,
        layer: "heuristic",
        note: "trivial rename",
      }),
      expectedTier: "SIMPLE",
    },
    // 3. under-routed, low confidence → no miss list entry
    {
      entry: entry({
        expectedTier: "COMPLEX",
        classifierTier: "SIMPLE",
        finalTier: "SIMPLE",
        confidence: 0.5,
        layer: "heuristic",
      }),
      expectedTier: "COMPLEX",
    },
    // 4. final wrong but classifier right — hint fusion made it worse
    {
      entry: entry({
        expectedTier: "MEDIUM",
        classifierTier: "MEDIUM",
        finalTier: "REASONING",
        confidence: 0.7,
        layer: "heuristic",
      }),
      expectedTier: "MEDIUM",
    },
    // 5. correct (REASONING→REASONING), ai layer
    {
      entry: entry({
        expectedTier: "REASONING",
        classifierTier: "REASONING",
        finalTier: "REASONING",
        layer: "ai",
      }),
      expectedTier: "REASONING",
    },
    // 6. retried sample, wrong (over-routed by one tier), mid confidence
    {
      entry: entry({
        timestamp: "2026-08-20T01:09:00.000Z",
        expectedTier: "MEDIUM",
        classifierTier: "COMPLEX",
        finalTier: "COMPLEX",
        confidence: 0.6,
        layer: "ai",
      }),
      expectedTier: "MEDIUM",
      retryReason: "same-text",
    },
  ];

  const report = computeEvalReport({
    file: "labeled.jsonl",
    samples,
    totalLines: 8,
    skippedMissingLabel: 1,
    skippedInvalid: 1,
  });

  it("computes final and classifier accuracies independently", () => {
    // final: samples 1, 5 correct → 2/6; classifier: 1, 2, 4, 5 → 4/6
    expect(report.labeled).toBe(6);
    expect(report.finalCorrect).toBe(2);
    expect(report.finalAccuracy).toBeCloseTo(2 / 6);
    expect(report.classifierCorrect).toBe(4);
    expect(report.classifierAccuracy).toBeCloseTo(4 / 6);
  });

  it("builds the expected × final confusion matrix", () => {
    expect(report.confusionMatrix.SIMPLE).toEqual({ SIMPLE: 1, COMPLEX: 1 });
    expect(report.confusionMatrix.COMPLEX).toEqual({ SIMPLE: 1 });
    expect(report.confusionMatrix.MEDIUM).toEqual({ REASONING: 1, COMPLEX: 1 });
    expect(report.confusionMatrix.REASONING).toEqual({ REASONING: 1 });
  });

  it("groups accuracy by layer", () => {
    expect(report.accuracyByLayer.rule).toEqual({ total: 1, correct: 1, accuracy: 1 });
    expect(report.accuracyByLayer.heuristic).toEqual({ total: 3, correct: 0, accuracy: 0 });
    expect(report.accuracyByLayer.ai).toEqual({ total: 2, correct: 1, accuracy: 0.5 });
  });

  it("splits wrong answers by direction (over vs under)", () => {
    expect(report.direction).toEqual({ correct: 2, overRouted: 3, underRouted: 1 });
  });

  it("lists only high-confidence misses, with note and 80-char preview", () => {
    expect(report.highConfidenceMisses).toHaveLength(1);
    const miss = report.highConfidenceMisses[0];
    expect(miss.timestamp).toBe("2026-08-20T01:05:00.000Z");
    expect(miss.expectedTier).toBe("SIMPLE");
    expect(miss.finalTier).toBe("COMPLEX");
    expect(miss.confidence).toBe(0.9);
    expect(miss.note).toBe("trivial rename");
  });

  it("truncates the miss preview to 80 characters", () => {
    const longReport = computeEvalReport({
      file: "x",
      samples: [
        {
          entry: entry({
            expectedTier: "SIMPLE",
            finalTier: "COMPLEX",
            confidence: HIGH_CONFIDENCE_THRESHOLD,
            promptPreview: "y".repeat(120),
          }),
          expectedTier: "SIMPLE",
        },
      ],
      totalLines: 1,
      skippedMissingLabel: 0,
      skippedInvalid: 0,
    });
    expect(longReport.highConfidenceMisses[0].promptPreview).toHaveLength(80);
  });

  it("joins retry outcomes and reports their accuracy separately", () => {
    expect(report.retried).toEqual({ total: 1, correct: 0, accuracy: 0 });
    expect(report.highConfidenceMisses[0].retryReason).toBeUndefined();
  });

  it("handles zero labeled samples without dividing by zero", () => {
    const empty = computeEvalReport({
      file: "x",
      samples: [],
      totalLines: 3,
      skippedMissingLabel: 3,
      skippedInvalid: 0,
    });
    expect(empty.finalAccuracy).toBe(0);
    expect(empty.retried.accuracy).toBeNull();
  });
});

describe("loadOutcomeIndex + evaluateFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nexusrouter-eval-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty index when the directory has no outcome files", async () => {
    expect(await loadOutcomeIndex(dir)).toEqual(new Map());
  });

  it("returns an empty index when the directory does not exist", async () => {
    expect(await loadOutcomeIndex(join(dir, "nope"))).toEqual(new Map());
  });

  it("joins sibling outcome rows onto labeled samples by timestamp", async () => {
    const labeled = [
      entry({ timestamp: "2026-08-20T01:00:00.000Z", expectedTier: "SIMPLE", finalTier: "SIMPLE" }),
      entry({
        timestamp: "2026-08-20T01:01:00.000Z",
        expectedTier: "SIMPLE",
        finalTier: "COMPLEX",
        confidence: 0.9,
      }),
    ];
    await writeFile(
      join(dir, "labeled.jsonl"),
      labeled.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    await writeFile(
      join(dir, "routing-outcome-2026-08-20.jsonl"),
      JSON.stringify({
        timestamp: "2026-08-20T01:01:00.000Z",
        outcome: "retried",
        retryReason: "model-switch",
      }) + "\n",
    );

    const report = await evaluateFile(join(dir, "labeled.jsonl"));

    expect(report.labeled).toBe(2);
    expect(report.finalCorrect).toBe(1);
    expect(report.retried).toEqual({ total: 1, correct: 0, accuracy: 0 });
    expect(report.highConfidenceMisses[0].retryReason).toBe("model-switch");
  });

  it("ignores outcome files in other directories", async () => {
    await writeFile(
      join(dir, "labeled.jsonl"),
      JSON.stringify(entry({ expectedTier: "SIMPLE" })) + "\n",
    );
    const report = await evaluateFile(join(dir, "labeled.jsonl"));
    expect(report.retried.total).toBe(0);
  });
});

describe("formatEvalReport", () => {
  it("renders the human-readable sections", () => {
    const report = computeEvalReport({
      file: "labeled.jsonl",
      samples: [
        { entry: entry({ expectedTier: "SIMPLE", finalTier: "SIMPLE" }), expectedTier: "SIMPLE" },
        {
          entry: entry({ expectedTier: "SIMPLE", finalTier: "COMPLEX", confidence: 0.9 }),
          expectedTier: "SIMPLE",
        },
      ],
      totalLines: 2,
      skippedMissingLabel: 0,
      skippedInvalid: 0,
    });

    const text = formatEvalReport(report);
    expect(text).toContain("labeled, 0 skipped");
    expect(text).toContain("finalTier      === expectedTier: 50.0% (1/2)");
    expect(text).toContain("Confusion matrix");
    expect(text).toContain("Accuracy by layer");
    expect(text).toContain("over-routed  (final > expected): 1");
    expect(text).toContain("High-confidence misses");
  });

  it("says so when there is nothing labeled", () => {
    const text = formatEvalReport(
      computeEvalReport({
        file: "x",
        samples: [],
        totalLines: 1,
        skippedMissingLabel: 1,
        skippedInvalid: 0,
      }),
    );
    expect(text).toContain("No labeled samples");
  });
});
