import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { readTextFile } from "../fs-read.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LedgerWriter } from "./ledger-writer.js";

/** Records every append call so we can assert *how many* writes happened. */
function recorder() {
  const calls: { file: string; data: string }[] = [];
  return {
    calls,
    append: async (file: string, data: string): Promise<void> => {
      calls.push({ file, data });
    },
  };
}

function lineCount(data: string): number {
  return data.split("\n").filter(Boolean).length;
}

describe("LedgerWriter — queueing", () => {
  it("append() is synchronous, returns void and performs no I/O", () => {
    const rec = recorder();
    const w = new LedgerWriter({ append: rec.append, flushLines: 64 });

    const returned = w.append("/logs/routing-2026-08-20.jsonl", "{}");

    expect(returned).toBeUndefined();
    expect(rec.calls).toHaveLength(0);
    expect(w.pending).toBe(1);
    w.dispose();
  });

  it("flushes once the queue reaches flushLines, as a single multi-line write", async () => {
    const rec = recorder();
    const w = new LedgerWriter({ append: rec.append, flushLines: 4, flushIntervalMs: 60_000 });

    for (let i = 0; i < 4; i++) w.append("/logs/a.jsonl", `{"i":${i}}`);
    await w.idle();

    // The whole point of Step 0: 4 entries must cost ONE appendFile, not four.
    expect(rec.calls).toHaveLength(1);
    expect(lineCount(rec.calls[0].data)).toBe(4);
    expect(rec.calls[0].data.endsWith("\n")).toBe(true);
    expect(w.pending).toBe(0);
    w.dispose();
  });

  it("groups a mixed queue into one write per target file", async () => {
    const rec = recorder();
    const w = new LedgerWriter({ append: rec.append, flushLines: 100, flushIntervalMs: 60_000 });

    w.append("/logs/routing-2026-08-20.jsonl", "r1");
    w.append("/logs/usage-2026-08-20.jsonl", "u1");
    w.append("/logs/routing-2026-08-20.jsonl", "r2");
    await w.flush();

    expect(rec.calls).toHaveLength(2);
    const routing = rec.calls.find((c) => c.file.includes("routing"));
    expect(routing && lineCount(routing.data)).toBe(2);
    w.dispose();
  });

  it("preserves order within a file across flushes", async () => {
    const rec = recorder();
    const w = new LedgerWriter({ append: rec.append, flushLines: 2, flushIntervalMs: 60_000 });

    for (let i = 0; i < 4; i++) w.append("/logs/a.jsonl", `${i}`);
    await w.idle();

    const all = rec.calls.map((c) => c.data).join("");
    expect(all.split("\n").filter(Boolean)).toEqual(["0", "1", "2", "3"]);
    w.dispose();
  });
});

describe("LedgerWriter — timer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("flushes a partial queue once flushIntervalMs elapses", async () => {
    const rec = recorder();
    const w = new LedgerWriter({ append: rec.append, flushLines: 64, flushIntervalMs: 200 });

    w.append("/logs/a.jsonl", "only-one");
    expect(rec.calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(200);
    // drain() awaits a real fs mkdir before appending; advancing fake timers
    // fires the callback but does not wait for that I/O — await the chain.
    await w.idle();

    expect(rec.calls).toHaveLength(1);
    expect(lineCount(rec.calls[0].data)).toBe(1);
    w.dispose();
  });

  it("keeps the flush timer unref'd so it never holds the process open", () => {
    const w = new LedgerWriter({ append: recorder().append, flushIntervalMs: 200 });
    w.append("/logs/a.jsonl", "x");

    expect(w.timerHasRef()).toBe(false);
    w.dispose();
  });
});

describe("LedgerWriter — failure handling", () => {
  it("swallows append errors, clears the queue and never rejects", async () => {
    const err = vi.fn(async () => {
      throw new Error("EACCES: disk on fire");
    });
    const w = new LedgerWriter({ append: err, flushLines: 2, flushIntervalMs: 60_000 });

    w.append("/logs/a.jsonl", "1");
    w.append("/logs/a.jsonl", "2");

    await expect(w.idle()).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledTimes(1);
    // Dropped rather than retried forever: a failing disk must not grow the heap.
    expect(w.pending).toBe(0);
    expect(w.writeFailures).toBe(1);
    w.dispose();
  });

  it("drops the oldest lines once maxQueueLines is reached", async () => {
    const rec = recorder();
    const w = new LedgerWriter({
      append: rec.append,
      flushLines: 1_000,
      flushIntervalMs: 60_000,
      maxQueueLines: 4,
      degradeAfterOverflows: 99,
    });

    for (let i = 0; i < 7; i++) w.append("/logs/a.jsonl", `${i}`);

    expect(w.pending).toBe(4);
    expect(w.droppedLines).toBe(3);

    await w.flush();
    expect(rec.calls[0].data.split("\n").filter(Boolean)).toEqual(["3", "4", "5", "6"]);
    w.dispose();
  });

  it("degrades persistence one-way after repeated overflow, warning exactly once", async () => {
    const rec = recorder();
    const warn = vi.fn();
    const w = new LedgerWriter({
      append: rec.append,
      flushLines: 1_000,
      flushIntervalMs: 60_000,
      maxQueueLines: 2,
      degradeAfterOverflows: 3,
      onWarn: warn,
    });

    for (let i = 0; i < 10; i++) w.append("/logs/a.jsonl", `${i}`);

    expect(w.degraded).toBe(true);
    expect(w.degradedReason).toBe("ledger-queue-overflow×3");
    expect(warn).toHaveBeenCalledTimes(1);

    // One-way: later appends are ignored and nothing is written, no auto-recovery.
    const pendingAtDegrade = w.pending;
    w.append("/logs/a.jsonl", "after");
    expect(w.pending).toBe(pendingAtDegrade);

    await w.flush();
    expect(rec.calls.flatMap((c) => c.data.split("\n")).includes("after")).toBe(false);
    w.dispose();
  });
});

describe("LedgerWriter — real filesystem", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nexusrouter-ledger-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates the log directory and appends real JSON lines", async () => {
    const file = join(dir, "nested", "routing-2026-08-20.jsonl");
    const w = new LedgerWriter({ flushLines: 2, flushIntervalMs: 60_000 });

    w.append(file, JSON.stringify({ n: 1 }));
    w.append(file, JSON.stringify({ n: 2 }));
    await w.idle();

    const lines = (await readTextFile(file)).trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).n)).toEqual([1, 2]);
    w.dispose();
  });

  it("appends to an existing file instead of truncating it", async () => {
    const file = join(dir, "routing-2026-08-20.jsonl");
    const w = new LedgerWriter({ flushLines: 1, flushIntervalMs: 60_000 });

    w.append(file, "first");
    await w.idle();
    w.append(file, "second");
    await w.idle();

    expect((await readTextFile(file)).trim().split("\n")).toEqual(["first", "second"]);
    w.dispose();
  });

  it("flushSync() drains the queue without the event loop (exit-hook path)", async () => {
    const file = join(dir, "sync", "routing-2026-08-20.jsonl");
    const w = new LedgerWriter({ flushLines: 1_000, flushIntervalMs: 60_000 });

    w.append(file, "a");
    w.append(file, "b");
    w.flushSync();

    expect(w.pending).toBe(0);
    expect((await readTextFile(file)).trim().split("\n")).toEqual(["a", "b"]);
    w.dispose();
  });

  it("flushSync() never throws when the target is unwritable", () => {
    const w = new LedgerWriter({
      flushLines: 1_000,
      flushIntervalMs: 60_000,
      appendSync: () => {
        throw new Error("EACCES");
      },
    });
    w.append(join(dir, "x.jsonl"), "x");

    expect(() => w.flushSync()).not.toThrow();
    expect(w.pending).toBe(0);
    expect(w.writeFailures).toBe(1);
    w.dispose();
  });
});
