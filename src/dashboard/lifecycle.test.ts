import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSnapshot } from "./lifecycle.js";
import type { UsageEntryV2 } from "../logger.js";

const originalLogDir = process.env.NEXUSROUTER_LOG_DIR;
const originalColumns = process.stdout.columns;
const originalRows = process.stdout.rows;

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

describe("runSnapshot", () => {
  let dir = "";
  let logs: string[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nexus-dash-snap-"));
    process.env.NEXUSROUTER_LOG_DIR = dir;
    process.stdout.columns = 120;
    process.stdout.rows = 30;
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  });

  afterEach(async () => {
    if (originalLogDir === undefined) delete process.env.NEXUSROUTER_LOG_DIR;
    else process.env.NEXUSROUTER_LOG_DIR = originalLogDir;
    process.stdout.columns = originalColumns;
    process.stdout.rows = originalRows;
    if (dir) await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("prints a non-TTY snapshot without alt-screen escape sequences", async () => {
    await writeFile(join(dir, "usage-2026-08-20.jsonl"), JSON.stringify(entry()) + "\n");
    await runSnapshot({ logDir: dir, port: 1 });

    const output = logs.join("\n");
    expect(output).toContain("NexusRouter");
    expect(output).toContain("TODAY");
    expect(output).not.toContain("\x1b[?1049h");
    expect(output).not.toContain("\x1b[?25l");
  });

  it("renders empty state when no log files exist", async () => {
    await runSnapshot({ logDir: dir, port: 1 });
    const output = logs.join("\n");
    expect(output).toContain("NexusRouter");
    expect(output).toContain("router offline");
  });
});
