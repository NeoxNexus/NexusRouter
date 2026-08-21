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

import { access, mkdir, readdir, rename, rmdir, stat } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Log file kinds, one file per kind per day. */
export type LogKind = "usage" | "routing";

/** `~/.nexus-router/logs` — now unified with the config directory. */
export function defaultLogDir(): string {
  return join(homedir(), ".nexus-router", "logs");
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

export type MigrationResult = {
  /** Number of log files moved from the legacy directory. */
  moved: number;
  /** Number of files left behind because of name collisions. */
  skipped: number;
};

/**
 * One-time migration from the legacy `~/.nexusrouter/logs` to the unified
 * `~/.nexus-router/logs`. This preserves existing usage/routing logs when a
 * user upgrades from the pre-unification layout.
 *
 * - If the legacy directory does not exist, this is a no-op.
 * - If the target directory already exists, files are moved individually and
 *   name collisions are skipped rather than overwritten.
 * - Empty leftover directories are removed after a successful move.
 *
 * Called from `startServer` (CLI / programmatic entry) but skipped under
 * Vitest to avoid touching the developer's home directory during tests.
 */
export async function migrateLegacyLogDir(
  targetDir: string = resolveLogDir(),
  legacyDir: string = join(homedir(), ".nexusrouter", "logs"),
): Promise<MigrationResult> {
  const result: MigrationResult = { moved: 0, skipped: 0 };

  if (legacyDir === targetDir) return result;

  try {
    await access(legacyDir);
  } catch {
    return result;
  }

  await ensureLogDir(targetDir);

  const entries = await readdir(legacyDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      result.skipped++;
      continue;
    }
    const source = join(legacyDir, entry.name);
    const dest = join(targetDir, entry.name);
    try {
      await stat(dest);
      result.skipped++;
    } catch {
      try {
        await rename(source, dest);
        result.moved++;
      } catch {
        result.skipped++;
      }
    }
  }

  // Clean up empty legacy directories, but never fail the migration because
  // of leftover files or directory permissions.
  try {
    await rmdir(legacyDir);
    const legacyParent = join(legacyDir, "..");
    await rmdir(legacyParent);
  } catch {
    // Directory not empty or no permission — leave it alone.
  }

  return result;
}
