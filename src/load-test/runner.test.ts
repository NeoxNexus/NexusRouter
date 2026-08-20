import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLoadTest } from "./runner.js";
import { flushLogs } from "../logger.js";

const originalLogDir = process.env.NEXUSROUTER_LOG_DIR;

describe("runLoadTest", () => {
  let logDir = "";

  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), "nexus-loadtest-"));
    process.env.NEXUSROUTER_LOG_DIR = logDir;
  });

  afterEach(async () => {
    if (originalLogDir === undefined) delete process.env.NEXUSROUTER_LOG_DIR;
    else process.env.NEXUSROUTER_LOG_DIR = originalLogDir;
    await flushLogs().catch(() => {});
    if (logDir) {
      await rm(logDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("runs a short non-streaming load test with no errors", async () => {
    const result = await runLoadTest({
      durationMs: 500,
      connections: 3,
      routerPort: 0,
      accounting: false,
      logger: false,
    });

    expect(result.total).toBeGreaterThan(0);
    expect(result.successes).toBe(result.total);
    expect(result.errors).toBe(0);
    expect(result.throughput).toBeGreaterThan(0);
    expect(result.p50).toBeGreaterThan(0);
    expect(result.p95).toBeGreaterThan(0);
  }, 10_000);

  it("can run with accounting enabled", async () => {
    const result = await runLoadTest({
      durationMs: 500,
      connections: 2,
      routerPort: 0,
      accounting: true,
      logger: false,
    });

    expect(result.errors).toBe(0);
    expect(result.total).toBeGreaterThan(0);
  }, 10_000);
});
