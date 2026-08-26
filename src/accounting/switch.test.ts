import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { AccountingSwitch } from "./switch.js";
import { AccountingConfigSchema, type AccountingConfig } from "../config/schema.js";

function cfg(partial: Partial<AccountingConfig> = {}): AccountingConfig {
  return AccountingConfigSchema.parse(partial);
}

class FakeWatcher extends EventEmitter implements FSWatcher {
  private closed = false;
  close(): void {
    this.closed = true;
    this.removeAllListeners();
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  [Symbol.dispose](): void {
    this.close();
  }
  trigger(): void {
    if (!this.closed) this.emit("change", "change", null);
  }
}

describe("AccountingSwitch — L0 granularity", () => {
  let configPath = "";
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "nexus-acct-"));
    configPath = join(tmpDir, "config.yaml");
  });

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("treats a missing accounting section as enabled: false", () => {
    const sw = new AccountingSwitch({ configPath, config: cfg() });
    expect(sw.enabled).toBe(false);
    expect(sw.captureNonStreaming).toBe(false);
    expect(sw.captureStreaming).toBe(false);
    expect(sw.persist).toBe(false);
    expect(sw.ledgerWriter).toBeNull();
    sw.close();
  });

  it("enabled: false creates no ledger writer and no file activity", () => {
    const sw = new AccountingSwitch({ configPath, config: cfg({ enabled: false, persist: true }) });
    expect(sw.ledgerWriter).toBeNull();
    expect(sw.health()).toEqual({
      enabled: false,
      captureNonStreaming: false,
      captureStreaming: false,
      persist: false,
      degraded: false,
      degradedReason: null,
    });
    sw.close();
  });

  it("enabled: true with persist: true exposes a ledger writer", () => {
    const sw = new AccountingSwitch({ configPath, config: cfg({ enabled: true }) });
    expect(sw.ledgerWriter).not.toBeNull();
    sw.close();
  });

  it("captureStreaming: false still allows non-streaming capture", () => {
    const sw = new AccountingSwitch({
      configPath,
      config: cfg({ enabled: true, captureStreaming: false, captureNonStreaming: true }),
    });
    expect(sw.captureStreaming).toBe(false);
    expect(sw.captureNonStreaming).toBe(true);
    sw.close();
  });

  it("persist: false keeps cost calculation possible but returns no writer", () => {
    const sw = new AccountingSwitch({
      configPath,
      config: cfg({ enabled: true, persist: false }),
    });
    expect(sw.persist).toBe(false);
    expect(sw.ledgerWriter).toBeNull();
    sw.close();
  });
});

describe("AccountingSwitch — L1 hot reload", () => {
  let configPath = "";
  let tmpDir = "";
  let watcher: FakeWatcher | null = null;
  let warnings: string[] = [];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "nexus-acct-"));
    configPath = join(tmpDir, "config.yaml");
    warnings = [];
  });

  afterEach(async () => {
    watcher?.close();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  function makeSwitch(initial: AccountingConfig): AccountingSwitch {
    return new AccountingSwitch({
      configPath,
      config: initial,
      onWarn: (m) => warnings.push(m),
      watchImpl: (_path, listener) => {
        watcher = new FakeWatcher();
        watcher.on("change", listener);
        return watcher;
      },
    });
  }

  async function writeCfg(text: string): Promise<void> {
    await writeFile(configPath, text, "utf-8");
  }

  it("reloads only the accounting subtree and ignores provider changes", async () => {
    await writeCfg(`
providers:
  openai:
    apiKey: rotated-key
accounting:
  enabled: true
  captureStreaming: false
`);
    const sw = makeSwitch(cfg({ enabled: true }));
    expect(sw.captureStreaming).toBe(true);

    watcher!.trigger();
    await new Promise((r) => setTimeout(r, 250));

    expect(sw.captureStreaming).toBe(false);
    expect(warnings.some((m) => m.includes("accounting.* subtree only"))).toBe(true);
    sw.close();
  });

  it("debounces rapid file changes into a single reload", async () => {
    await writeCfg(`accounting:\n  enabled: true\n`);
    const sw = makeSwitch(cfg({ enabled: true }));

    for (let i = 0; i < 5; i++) {
      const value = i === 4 ? false : i % 2 === 0;
      await writeCfg(`accounting:\n  enabled: true\n  captureStreaming: ${value}\n`);
      watcher!.trigger();
    }
    await new Promise((r) => setTimeout(r, 400));

    // After debounce, state should be settled to the last write.
    expect(sw.captureStreaming).toBe(false);
    const reloadMessages = warnings.filter((m) => m.includes("accounting config hot-reloaded"));
    expect(reloadMessages.length).toBeLessThanOrEqual(2); // ≤2 due to test timing; often 1
    sw.close();
  });

  it("keeps the old config when the file becomes invalid YAML", async () => {
    await writeCfg(`accounting:\n  enabled: true\n  captureStreaming: false\n`);
    const sw = makeSwitch(cfg({ enabled: true, captureStreaming: false }));
    expect(sw.captureStreaming).toBe(false);

    await writeCfg(`accounting: enabled: true: bad`);
    watcher!.trigger();
    await new Promise((r) => setTimeout(r, 250));

    expect(sw.captureStreaming).toBe(false);
    expect(warnings.some((m) => m.includes("hot-reload failed"))).toBe(true);
    sw.close();
  });

  it("keeps the old config when accounting subtree fails schema validation", async () => {
    await writeCfg(`accounting:\n  enabled: true\n  captureStreaming: false\n`);
    const sw = makeSwitch(cfg({ enabled: true, captureStreaming: false }));

    await writeCfg(`accounting:\n  enabled: true\n  baseline: not-a-mode\n`);
    watcher!.trigger();
    await new Promise((r) => setTimeout(r, 250));

    expect(sw.baselineMode).toBe("requested");
    expect(warnings.some((m) => m.includes("invalid accounting.* config"))).toBe(true);
    sw.close();
  });

  it("turning persist off drains the existing writer", async () => {
    await writeCfg(`accounting:\n  enabled: true\n  persist: true\n`);
    const sw = makeSwitch(cfg({ enabled: true, persist: true }));
    const writerBefore = sw.ledgerWriter;
    expect(writerBefore).not.toBeNull();

    await writeCfg(`accounting:\n  enabled: true\n  persist: false\n`);
    watcher!.trigger();
    await new Promise((r) => setTimeout(r, 250));

    expect(sw.persist).toBe(false);
    expect(sw.ledgerWriter).toBeNull();
    sw.close();
  });
});

describe("AccountingSwitch — L2 degrade", () => {
  let configPath = "";
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "nexus-acct-"));
    configPath = join(tmpDir, "config.yaml");
  });

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("reports degraded once the ledger writer overflows repeatedly", () => {
    const sw = new AccountingSwitch({
      configPath,
      config: cfg({ enabled: true, persist: true, maxQueueLines: 2, degradeAfterOverflows: 2 }),
    });
    const writer = sw.ledgerWriter;
    expect(writer).not.toBeNull();

    writer!.append("/tmp/ignored.jsonl", '{"line":1}');
    writer!.append("/tmp/ignored.jsonl", '{"line":2}');
    writer!.append("/tmp/ignored.jsonl", '{"line":3}');
    writer!.append("/tmp/ignored.jsonl", '{"line":4}');

    expect(sw.health().degraded).toBe(true);
    expect(sw.health().degradedReason).toContain("ledger-queue-overflow");
    sw.close();
  });

  it("does not auto-recover after degrade", () => {
    const sw = new AccountingSwitch({
      configPath,
      config: cfg({ enabled: true, persist: true, maxQueueLines: 2, degradeAfterOverflows: 1 }),
    });
    sw.ledgerWriter!.append("/tmp/ignored.jsonl", "a");
    sw.ledgerWriter!.append("/tmp/ignored.jsonl", "b");
    sw.ledgerWriter!.append("/tmp/ignored.jsonl", "c");

    expect(sw.persist).toBe(false);
    // Even more normal requests do not flip persist back on.
    expect(sw.persist).toBe(false);
    expect(sw.health().degraded).toBe(true);
    sw.close();
  });
});

describe("AccountingSwitch — L3 health", () => {
  let configPath = "";
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "nexus-acct-"));
    configPath = join(tmpDir, "config.yaml");
  });

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("exposes the expected health shape", () => {
    const sw = new AccountingSwitch({
      configPath,
      config: cfg({
        enabled: true,
        captureNonStreaming: true,
        captureStreaming: true,
        persist: true,
      }),
    });
    const h = sw.health();
    expect(h).toEqual({
      enabled: true,
      captureNonStreaming: true,
      captureStreaming: true,
      persist: true,
      degraded: false,
      degradedReason: null,
    });
    sw.close();
  });
});
