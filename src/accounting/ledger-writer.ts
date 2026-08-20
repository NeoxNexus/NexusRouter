/**
 * LedgerWriter — batched, fire-and-forget JSONL appender.
 *
 * Why this exists (Savings Ledger design, 决策 5):
 * one `appendFile` per request saturates libuv's 4-thread default pool and caps
 * throughput at ~2,959 req/s — measured, and already the case for today's
 * routing log. A second per-request file halves it again to ~1,522 req/s.
 * Batching 64 lines / 200 ms measured 139,537 req/s (70×).
 *
 * Contract:
 *   - `append()` is synchronous, returns void and performs NO I/O. It must never
 *     hand a Promise back to the request path.
 *   - Flush triggers: queue ≥ flushLines, or flushIntervalMs since the queue
 *     became non-empty, or process exit.
 *   - Every write error is swallowed and the batch is dropped — a failing disk
 *     must neither break the request flow nor grow the heap ("Never break the
 *     request flow", inherited from logger.ts).
 *   - Queue overflow drops the OLDEST lines; repeated overflow degrades
 *     persistence one-way (no auto-recovery, 决策 6 / L2).
 */

import { appendFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { ensureLogDir, ensureLogDirSync } from "../paths.js";

export type AppendFn = (file: string, data: string) => Promise<void>;
export type AppendSyncFn = (file: string, data: string) => void;

export type LedgerWriterOptions = {
  /** Flush once the queue holds this many lines. Default 64. */
  flushLines?: number;
  /** Flush this long after the queue became non-empty. Default 200 ms. */
  flushIntervalMs?: number;
  /** Hard queue ceiling; oldest lines are dropped past it. Default 10,000. */
  maxQueueLines?: number;
  /** Consecutive overflows before persistence degrades one-way. Default 3. */
  degradeAfterOverflows?: number;
  /** Injectable for tests; defaults to fs.appendFile. */
  append?: AppendFn;
  /** Injectable for tests; defaults to fs.appendFileSync. */
  appendSync?: AppendSyncFn;
  /** Called exactly once when persistence degrades. Defaults to console.warn. */
  onWarn?: (message: string) => void;
};

type QueuedLine = { file: string; line: string };

/** Compact the queue array once this many consumed slots pile up at the head. */
const COMPACT_THRESHOLD = 4_096;

export class LedgerWriter {
  private readonly flushLines: number;
  private readonly flushIntervalMs: number;
  private readonly maxQueueLines: number;
  private readonly degradeAfterOverflows: number;
  private readonly appendImpl: AppendFn;
  private readonly appendSyncImpl: AppendSyncFn;
  private readonly warn: (message: string) => void;

  private queue: QueuedLine[] = [];
  private head = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();

  private dropped = 0;
  private failures = 0;
  private consecutiveOverflows = 0;
  private degradedFlag = false;
  private degradedReasonText: string | null = null;

  constructor(options: LedgerWriterOptions = {}) {
    this.flushLines = options.flushLines ?? 64;
    this.flushIntervalMs = options.flushIntervalMs ?? 200;
    this.maxQueueLines = options.maxQueueLines ?? 10_000;
    this.degradeAfterOverflows = options.degradeAfterOverflows ?? 3;
    this.appendImpl = options.append ?? ((file, data) => appendFile(file, data));
    this.appendSyncImpl = options.appendSync ?? ((file, data) => appendFileSync(file, data));
    this.warn = options.onWarn ?? ((message) => console.warn(message));
  }

  /** Lines waiting in memory. */
  get pending(): number {
    return this.queue.length - this.head;
  }

  /** Lines discarded because the queue hit its ceiling. */
  get droppedLines(): number {
    return this.dropped;
  }

  /** Number of failed flush attempts (each drops its batch). */
  get writeFailures(): number {
    return this.failures;
  }

  /** True once persistence degraded; one-way, never resets by itself. */
  get degraded(): boolean {
    return this.degradedFlag;
  }

  /** Machine-readable degrade cause, surfaced via /health. */
  get degradedReason(): string | null {
    return this.degradedReasonText;
  }

  /**
   * Queue one line. Synchronous, no I/O, never throws.
   * `line` must not contain a trailing newline — the writer adds it.
   */
  append(file: string, line: string): void {
    if (this.degradedFlag) return;

    if (this.pending >= this.maxQueueLines) {
      this.head++;
      this.dropped++;
      this.consecutiveOverflows++;
      if (this.consecutiveOverflows >= this.degradeAfterOverflows) {
        this.degrade(`ledger-queue-overflow×${this.consecutiveOverflows}`);
        return;
      }
    }

    this.queue.push({ file, line });
    this.compactIfNeeded();

    if (this.pending >= this.flushLines) {
      void this.flush();
      return;
    }
    this.arm();
  }

  /** Await any in-flight or auto-triggered flush. Never rejects. */
  idle(): Promise<void> {
    return this.chain;
  }

  /** Flush everything queued so far. Never rejects. */
  flush(): Promise<void> {
    this.disarm();
    const next = this.chain.then(() => this.drain());
    this.chain = next;
    return next;
  }

  /** Synchronous drain for `process.on("exit")`, where async work cannot run. */
  flushSync(): void {
    this.disarm();
    for (const [file, lines] of this.take()) {
      try {
        ensureLogDirSync(dirname(file));
        this.appendSyncImpl(file, lines.join("\n") + "\n");
      } catch {
        this.failures++;
      }
    }
  }

  /** Release the timer. The queue is flushed first so nothing is silently lost. */
  dispose(): void {
    this.flushSync();
    this.disarm();
  }

  /** Diagnostics: whether the pending timer keeps the event loop alive. */
  timerHasRef(): boolean | null {
    return this.timer ? this.timer.hasRef() : null;
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async drain(): Promise<void> {
    const batches = this.take();
    if (batches.size === 0) return;
    for (const [file, lines] of batches) {
      try {
        await ensureLogDir(dirname(file));
        await this.appendImpl(file, lines.join("\n") + "\n");
      } catch {
        // Drop the batch: retrying a broken disk would grow the heap without bound.
        this.failures++;
      }
    }
    if (this.pending === 0) this.consecutiveOverflows = 0;
  }

  /**
   * Detach the queue and group it by target file, so N entries cost one append
   * per file rather than one append per entry.
   */
  private take(): Map<string, string[]> {
    const batches = new Map<string, string[]>();
    const from = this.head;
    const items = this.queue;
    // Reset before any await so lines queued during the flush land in a fresh
    // array and are neither lost nor written twice.
    this.queue = [];
    this.head = 0;
    for (let i = from; i < items.length; i++) {
      const { file, line } = items[i];
      const bucket = batches.get(file);
      if (bucket) bucket.push(line);
      else batches.set(file, [line]);
    }
    return batches;
  }

  private arm(): void {
    if (this.timer || this.pending === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushIntervalMs);
    // Must not keep the process alive; the exit hooks flush what is left.
    this.timer.unref();
  }

  private disarm(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private compactIfNeeded(): void {
    if (this.head < COMPACT_THRESHOLD) return;
    this.queue = this.queue.slice(this.head);
    this.head = 0;
  }

  private degrade(reason: string): void {
    this.degradedFlag = true;
    this.degradedReasonText = reason;
    this.warn(
      `[NexusRouter] ledger persistence degraded (${reason}); ` +
        `dropped ${this.dropped} lines. Disk or log path is not keeping up — ` +
        `this does not recover automatically, restart after fixing it.`,
    );
  }
}
