import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTailer, tail, tailAll } from "./tailer.js";
import type { UsageEntryV2 } from "../logger.js";

function entry(partial: Partial<UsageEntryV2> = {}): UsageEntryV2 {
  return {
    schema: 2,
    timestamp: "2026-08-20T10:00:00.000Z",
    model: "anthropic/claude-sonnet-4.6",
    tier: "COMPLEX",
    usage: { inputUncached: 1000, output: 200, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    usageSource: "upstream",
    costUsd: 0.01,
    baselineModel: "anthropic/claude-opus-4.6",
    baselineCostUsd: 0.05,
    baselineMethod: "same-usage-repricing",
    savedUsd: 0.04,
    latencyMs: 900,
    ...partial,
  };
}

describe("tailer", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nexus-dash-"));
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("returns no entries when the log directory is empty", async () => {
    const state = createTailer(dir);
    const event = await tail(state);
    expect(event.entries).toHaveLength(0);
    expect(event.rollover).toBe(false);
  });

  it("reads all entries from a new file", async () => {
    await writeFile(
      join(dir, "usage-2026-08-20.jsonl"),
      [JSON.stringify(entry()), JSON.stringify(entry())].join("\n") + "\n",
    );
    const all = await tailAll(dir);
    expect(all).toHaveLength(2);
  });

  it("incrementally reads only new lines", async () => {
    const file = join(dir, "usage-2026-08-20.jsonl");
    await writeFile(file, JSON.stringify(entry()) + "\n");
    const state = createTailer(dir);
    const first = await tail(state);
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0].model).toBe("anthropic/claude-sonnet-4.6");

    await writeFile(file, JSON.stringify(entry()) + "\n" + JSON.stringify(entry()) + "\n", {
      flag: "a",
    });
    const second = await tail(state);
    expect(second.entries).toHaveLength(2);
    expect(second.rollover).toBe(false);
  });

  it("stitches a partial line split across two reads", async () => {
    const file = join(dir, "usage-2026-08-20.jsonl");
    const line = JSON.stringify(entry());
    await writeFile(file, line.slice(0, 40));
    const state = createTailer(dir);
    const first = await tail(state);
    expect(first.entries).toHaveLength(0);

    await writeFile(file, line.slice(40) + "\n", { flag: "a" });
    const second = await tail(state);
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0].model).toBe("anthropic/claude-sonnet-4.6");
  });

  it("detects day rollover and resets offset", async () => {
    const oldFile = join(dir, "usage-2026-08-20.jsonl");
    const newFile = join(dir, "usage-2026-08-21.jsonl");
    await writeFile(oldFile, JSON.stringify(entry()) + "\n");
    const state = createTailer(dir);
    await tail(state);

    await writeFile(newFile, JSON.stringify(entry({ model: "next-day" })) + "\n");
    const rollover = await tail(state);
    expect(rollover.rollover).toBe(true);
    expect(rollover.entries).toHaveLength(1);
    expect(rollover.entries[0].model).toBe("next-day");
  });

  it("detects truncation and resets offset without crashing", async () => {
    const file = join(dir, "usage-2026-08-20.jsonl");
    await writeFile(file, JSON.stringify(entry()) + "\n" + JSON.stringify(entry()) + "\n");
    const state = createTailer(dir);
    await tail(state);

    await writeFile(file, JSON.stringify(entry({ model: "after-truncate" })) + "\n");
    const truncated = await tail(state);
    expect(truncated.truncated).toBe(true);
    expect(truncated.entries).toHaveLength(1);
    expect(truncated.entries[0].model).toBe("after-truncate");
  });

  it("mixes v1 and v2 schema lines", async () => {
    const v1 = {
      timestamp: "2026-08-20T10:00:00.000Z",
      model: "v1-model",
      tier: "SIMPLE",
      cost: 0.005,
      baselineCost: 0.02,
      savings: 0.75,
      latencyMs: 100,
    };
    await writeFile(
      join(dir, "usage-2026-08-20.jsonl"),
      [JSON.stringify(v1), JSON.stringify(entry())].join("\n") + "\n",
    );
    const all = await tailAll(dir);
    expect(all).toHaveLength(2);
    expect(all[0].model).toBe("v1-model");
    expect(all[0].usage).toBeUndefined();
    expect(all[1].model).toBe("anthropic/claude-sonnet-4.6");
    expect(all[1].usage).toEqual({
      inputUncached: 1000,
      output: 200,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    });
  });
});
