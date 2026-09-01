/**
 * Incremental tail reader for the dashboard.
 *
 * Reads only the bytes that have been appended since the last read, tracks the
 * offset per file, and handles day rollover and log truncation without
 * re-parsing the whole day.
 *
 * This is the read-side counterpart to `LedgerWriter`: it must tolerate
 * partial lines (the writer may flush a batch that ends mid-line from the
 * reader's point of view) and must never hold the whole file in memory.
 */

import { opendir, stat, open } from "node:fs/promises";
import { join } from "node:path";
import type { UsageEntry, UsageEntryV2 } from "../logger.js";
import type { TokenUsage } from "../pricing/price-book.js";

export type ParsedUsageEntry = {
  timestamp: string;
  model: string;
  tier: string;
  cost: number | null;
  baselineCost: number | null;
  savings: number | null;
  latencyMs: number;
  usage?: TokenUsage;
  usageSource?: "upstream" | "estimated" | "partial";
  truncated?: boolean;
};

export type TailEvent = {
  /** New complete entries parsed since last read. */
  entries: ParsedUsageEntry[];
  /** True when the log file rolled over to a new day. */
  rollover: boolean;
  /** True when the file was truncated or replaced under us. */
  truncated: boolean;
};

export type TailerState = {
  dir: string;
  currentFile: string | null;
  offset: number;
  pending: string;
};

function parseLine(line: string): ParsedUsageEntry | null {
  try {
    const raw = JSON.parse(line) as Partial<UsageEntry> & Partial<UsageEntryV2>;
    if (raw.schema === 2) {
      const v2 = raw as UsageEntryV2;
      return {
        timestamp: v2.timestamp || new Date().toISOString(),
        model: v2.model || "unknown",
        tier: v2.tier || "UNKNOWN",
        cost: v2.costUsd ?? null,
        baselineCost: v2.baselineCostUsd ?? null,
        savings: v2.savedUsd ?? null,
        latencyMs: v2.latencyMs || 0,
        usage: v2.usage,
        usageSource: v2.usageSource,
        truncated: v2.truncated,
      };
    }
    const v1 = raw as UsageEntry;
    return {
      timestamp: v1.timestamp || new Date().toISOString(),
      model: v1.model || "unknown",
      tier: v1.tier || "UNKNOWN",
      cost: typeof v1.cost === "number" ? v1.cost : null,
      baselineCost: typeof v1.baselineCost === "number" ? v1.baselineCost : null,
      savings: typeof v1.savings === "number" ? v1.savings : null,
      latencyMs: v1.latencyMs || 0,
    };
  } catch {
    return null;
  }
}

async function findLatestUsageFile(dir: string): Promise<string | null> {
  try {
    const dh = await opendir(dir);
    let latest: string | null = null;
    for await (const dent of dh) {
      if (!dent.isFile()) continue;
      if (!dent.name.startsWith("usage-") || !dent.name.endsWith(".jsonl")) continue;
      if (!latest || dent.name > latest) latest = dent.name;
    }
    return latest ? join(dir, latest) : null;
  } catch {
    return null;
  }
}

export function createTailer(dir: string): TailerState {
  return { dir, currentFile: null, offset: 0, pending: "" };
}

/**
 * Read new entries from the tail of the current usage log.
 * Pure-ish: mutates `state` in place (offset / pending / currentFile) but
 * performs no I/O beyond the explicit fs calls.
 */
export async function tail(state: TailerState): Promise<TailEvent> {
  const latest = await findLatestUsageFile(state.dir);
  if (!latest) {
    return { entries: [], rollover: false, truncated: false };
  }

  let rollover = false;
  let truncated = false;

  if (latest !== state.currentFile) {
    state.currentFile = latest;
    state.offset = 0;
    state.pending = "";
    rollover = true;
  }

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let chunk: string;
  try {
    const info = await stat(state.currentFile);
    const size = info.size;

    if (size < state.offset) {
      // File was truncated or rotated in place.
      state.offset = 0;
      state.pending = "";
      truncated = true;
    }

    const toRead = size - state.offset;
    if (toRead <= 0) {
      return { entries: [], rollover, truncated };
    }

    handle = await open(state.currentFile, "r");
    const buf = Buffer.alloc(toRead);
    await handle.read(buf, 0, toRead, state.offset);
    chunk = buf.toString("utf-8");
    state.offset = size;
  } catch {
    return { entries: [], rollover, truncated };
  } finally {
    await handle?.close();
  }

  // Combine with any pending partial line from the previous read.
  const text = state.pending + chunk;
  const lastNl = text.lastIndexOf("\n");
  if (lastNl === -1) {
    state.pending = text;
    return { entries: [], rollover, truncated };
  }

  const complete = text.slice(0, lastNl);
  state.pending = text.slice(lastNl + 1);

  const entries: ParsedUsageEntry[] = [];
  for (const line of complete.split("\n")) {
    if (!line) continue;
    const parsed = parseLine(line);
    if (parsed) entries.push(parsed);
  }

  return { entries, rollover, truncated };
}

/** Convenience: read the whole current file from scratch. Used for tests. */
export async function tailAll(dir: string): Promise<ParsedUsageEntry[]> {
  const state = createTailer(dir);
  const event = await tail(state);
  return event.entries;
}
