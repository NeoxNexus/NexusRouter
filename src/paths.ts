/**
 * Log path resolution — single source of truth for where log files live.
 *
 * Extracted because `logger.ts` honored `NEXUSROUTER_LOG_DIR` while `stats.ts`
 * froze the directory in a module-level const (defect 11): with the variable
 * set, the write side wrote to A and the read side read B, so reports and the
 * live dashboard showed zeros with no error at all.
 *
 * Resolution happens per call on purpose — the CLI and container entrypoints
 * may set the variable after this module is imported.
 */

import { mkdir } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Log file kinds, one file per kind per day. */
export type LogKind = "usage" | "routing";

/** `~/.nexusrouter/logs` — note this is *not* the config dir (`~/.nexus-router`). */
export function defaultLogDir(): string {
  return join(homedir(), ".nexusrouter", "logs");
}

/** Resolved per call so `NEXUSROUTER_LOG_DIR` can be set after module load. */
export function resolveLogDir(): string {
  return process.env.NEXUSROUTER_LOG_DIR || defaultLogDir();
}

/**
 * Absolute path of a daily log file.
 *
 * @param date - `YYYY-MM-DD`, normally `entry.timestamp.slice(0, 10)`
 */
export function logFilePath(kind: LogKind, date: string, dir: string = resolveLogDir()): string {
  return join(dir, `${kind}-${date}.jsonl`);
}

/** Directories already created, so the common path skips the mkdir syscall. */
const readyDirs = new Set<string>();

/**
 * Create the log directory if needed. Never throws — logging must not break the
 * request flow, and a failed mkdir simply means the later append fails too.
 */
export async function ensureLogDir(dir: string): Promise<void> {
  if (readyDirs.has(dir)) return;
  try {
    await mkdir(dir, { recursive: true });
    readyDirs.add(dir);
  } catch {
    // Swallowed on purpose: never break the request flow.
  }
}

/** Sync variant for `process.on("exit")`, where async work can no longer run. */
export function ensureLogDirSync(dir: string): void {
  if (readyDirs.has(dir)) return;
  try {
    mkdirSync(dir, { recursive: true });
    readyDirs.add(dir);
  } catch {
    // Swallowed on purpose: never break the exit path.
  }
}
