/**
 * Accounting switch — runtime kill-switch and hot-reload layer (决策 6).
 *
 * Responsibilities:
 *   - Own the `AccountingConfig` runtime state.
 *   - Create the `LedgerWriter` only when accounting is enabled and persistence
 *     is on. `enabled: false` must create no files and no sniffer windows.
 *   - Watch `config.yaml` and reload **only** the `accounting.*` subtree, so a
 *     provider API key rotation does not crash a running router through an
 *     unrelated env-var failure.
 *   - Expose a health snapshot for `/health` (L3 visibility).
 *
 * The L2 one-way degrade is delegated to `LedgerWriter`, which already degrades
 * persistence after `degradeAfterOverflows` consecutive queue overflows. The
 * switch merely surfaces that state and stops handing out the writer once
 * degraded.
 */

import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import { AccountingConfigSchema, type AccountingConfig } from "../config/schema.js";
import { resolveEnvVars } from "../config/loader.js";
import { LedgerWriter } from "./ledger-writer.js";

export type AccountingHealth = {
  enabled: boolean;
  captureNonStreaming: boolean;
  captureStreaming: boolean;
  persist: boolean;
  degraded: boolean;
  degradedReason: string | null;
};

export type AccountingSwitchOptions = {
  /** Path to the YAML file to watch. Required for hot reload. */
  configPath: string;
  /** Initial accounting configuration. */
  config: AccountingConfig;
  /** Inject a console-like logger for warnings. */
  onWarn?: (message: string) => void;
  /** Inject an fs.watch implementation for tests. */
  watchImpl?: (path: string, listener: (event: string, filename: string | null) => void) => FSWatcher;
};

const RELOAD_DEBOUNCE_MS = 200;

export class AccountingSwitch {
  private configPath: string;
  private config: AccountingConfig;
  private writer: LedgerWriter | null = null;
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly warn: (message: string) => void;
  private readonly watchImpl: (
    path: string,
    listener: (event: string, filename: string | null) => void,
  ) => FSWatcher;

  constructor(options: AccountingSwitchOptions) {
    this.configPath = resolvePath(options.configPath);
    this.config = { ...options.config };
    this.warn = options.onWarn ?? ((message) => console.warn(message));
    this.watchImpl = options.watchImpl ?? ((path, listener) => watch(path, listener));

    if (this.config.enabled && this.config.persist) {
      this.writer = this.createWriter();
    }
    if (this.config.enabled && this.config.hotReload) {
      this.startWatching();
    }
  }

  /** True when accounting is turned on. */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /** True when non-streaming usage should be captured. */
  get captureNonStreaming(): boolean {
    return this.config.enabled && this.config.captureNonStreaming;
  }

  /** True when streaming usage should be captured. */
  get captureStreaming(): boolean {
    return this.config.enabled && this.config.captureStreaming;
  }

  /** True when the current request may be persisted. */
  get persist(): boolean {
    return (
      this.config.enabled && this.config.persist && !(this.writer?.degraded ?? false)
    );
  }

  /** Baseline strategy from config. */
  get baselineMode(): AccountingConfig["baseline"] {
    return this.config.baseline;
  }

  /** Baseline reference model, when configured. */
  get referenceModel(): string | undefined {
    return this.config.referenceModel;
  }

  /** Price-redaction flag. */
  get redactPrompts(): boolean {
    return this.config.redactPrompts;
  }

  /** Tail-window size in bytes. */
  get tailWindowBytes(): number {
    return this.config.tailWindowBytes;
  }

  /** The ledger writer, or null when persistence is disabled / degraded. */
  get ledgerWriter(): LedgerWriter | null {
    return this.persist ? this.writer : null;
  }

  /** Snapshot for `/health` (L3 visibility). */
  health(): AccountingHealth {
    return {
      enabled: this.config.enabled,
      captureNonStreaming: this.captureNonStreaming,
      captureStreaming: this.captureStreaming,
      persist: this.persist,
      degraded: this.writer?.degraded ?? false,
      degradedReason: this.writer?.degradedReason ?? null,
    };
  }

  /** Stop watching and flush any queued lines. */
  close(): void {
    this.stopWatching();
    this.writer?.dispose();
  }

  /** Force a reload from disk (useful in tests). */
  async reloadNow(): Promise<void> {
    await this.applyReload();
  }

  private createWriter(): LedgerWriter {
    return new LedgerWriter({
      flushLines: this.config.flushLines,
      flushIntervalMs: this.config.flushIntervalMs,
      maxQueueLines: this.config.maxQueueLines,
      degradeAfterOverflows: this.config.degradeAfterOverflows,
      onWarn: (message) => this.warn(message),
    });
  }

  private startWatching(): void {
    if (this.watcher) return;
    try {
      this.watcher = this.watchImpl(this.configPath, () => this.onFileChange());
    } catch (err) {
      this.warn(`[NexusRouter] accounting hot-reload failed to watch ${this.configPath}: ${err}`);
    }
  }

  private stopWatching(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private onFileChange(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.applyReload();
    }, RELOAD_DEBOUNCE_MS);
  }

  private async applyReload(): Promise<void> {
    try {
      const content = await readFile(this.configPath, "utf-8");
      const parsed = parseYaml(content) as Record<string, unknown> | null;
      const accountingSubtree = parsed?.accounting ?? {};
      const resolved = resolveEnvVars(accountingSubtree) as Record<string, unknown>;
      const result = AccountingConfigSchema.safeParse(resolved);

      if (!result.success) {
        this.warn(
          `[NexusRouter] accounting hot-reload skipped: invalid accounting.* config\n` +
            result.error.errors.map((e) => `  - ${e.path.join(".")}: ${e.message}`).join("\n"),
        );
        return;
      }

      const previous = this.config;
      this.config = result.data;

      // If persistence was just turned off, drain the old writer but keep it
      // around so health can still report degraded state from before.
      if (previous.enabled && previous.persist && (!this.config.enabled || !this.config.persist)) {
        this.writer?.flushSync();
      }

      // If persistence is now on but we have no writer, create one.
      if (this.config.enabled && this.config.persist && !this.writer) {
        this.writer = this.createWriter();
      }

      // Start/stop the watcher as requested.
      if (this.config.enabled && this.config.hotReload) this.startWatching();
      else this.stopWatching();

      this.warn("[NexusRouter] accounting config hot-reloaded (accounting.* subtree only)");
    } catch (err) {
      this.warn(`[NexusRouter] accounting hot-reload failed: ${err}`);
    }
  }
}
