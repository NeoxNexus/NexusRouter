import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  resolveLogDir,
  logFilePath,
  ensureLogDir,
  ensureLogDirSync,
  migrateLegacyLogDir,
  defaultLogDir,
} from "./paths.js";

describe("resolveLogDir", () => {
  const original = process.env.NEXUSROUTER_LOG_DIR;

  afterEach(() => {
    if (original === undefined) delete process.env.NEXUSROUTER_LOG_DIR;
    else process.env.NEXUSROUTER_LOG_DIR = original;
  });

  it("defaults to ~/.nexus-router/logs", () => {
    delete process.env.NEXUSROUTER_LOG_DIR;
    expect(resolveLogDir()).toBe(join(homedir(), ".nexus-router", "logs"));
  });

  it("honors NEXUSROUTER_LOG_DIR set after module load", () => {
    // Defect 11: stats.ts froze the dir in a module-level const, so a variable
    // set by the CLI/container after import was silently ignored.
    process.env.NEXUSROUTER_LOG_DIR = join(tmpdir(), "nexusrouter-env-dir");
    expect(resolveLogDir()).toBe(join(tmpdir(), "nexusrouter-env-dir"));
  });

  it("falls back to the default when the variable is empty", () => {
    process.env.NEXUSROUTER_LOG_DIR = "";
    expect(resolveLogDir()).toBe(join(homedir(), ".nexus-router", "logs"));
  });
});

describe("logFilePath", () => {
  it("builds usage and routing file names from the entry date", () => {
    expect(logFilePath("usage", "2026-08-20", "/logs")).toBe(
      join("/logs", "usage-2026-08-20.jsonl"),
    );
    expect(logFilePath("routing", "2026-08-20", "/logs")).toBe(
      join("/logs", "routing-2026-08-20.jsonl"),
    );
  });

  it("resolves the directory itself when none is given", () => {
    process.env.NEXUSROUTER_LOG_DIR = join(tmpdir(), "nexusrouter-implicit");
    expect(logFilePath("usage", "2026-08-20")).toBe(
      join(tmpdir(), "nexusrouter-implicit", "usage-2026-08-20.jsonl"),
    );
    delete process.env.NEXUSROUTER_LOG_DIR;
  });
});

describe("ensureLogDir", () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "nexusrouter-paths-"));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("creates nested directories and is idempotent", async () => {
    const dir = join(base, "a", "b", "logs");
    await ensureLogDir(dir);
    await ensureLogDir(dir);
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it("creates nested directories synchronously (exit-hook path)", () => {
    const dir = join(base, "sync", "logs");
    ensureLogDirSync(dir);
    ensureLogDirSync(dir);
    expect(ensureLogDirSync(dir)).toBeUndefined();
  });

  it("never throws when the directory cannot be created", async () => {
    // A regular file standing where a directory segment must be: fails on both
    // POSIX (ENOTDIR) and Windows, unlike "/proc/..." which win32 happily creates.
    const blocker = join(base, "blocker");
    await writeFile(blocker, "not a directory");
    const impossible = join(blocker, "logs");

    await expect(ensureLogDir(impossible)).resolves.toBeUndefined();
    expect(() => ensureLogDirSync(impossible)).not.toThrow();
  });
});

describe("migrateLegacyLogDir", () => {
  let base: string;
  let legacy: string;
  let target: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "nexusrouter-migrate-"));
    legacy = join(base, "legacy", "logs");
    target = join(base, "target", "logs");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("is a no-op when the legacy directory does not exist", async () => {
    const result = await migrateLegacyLogDir(target, legacy);
    expect(result).toEqual({ moved: 0, skipped: 0 });
    await expect(stat(target)).rejects.toBeDefined();
  });

  it("moves log files from legacy to target and skips name collisions", async () => {
    await ensureLogDir(legacy);
    await writeFile(join(legacy, "usage-2026-08-20.jsonl"), "{}", "utf-8");
    await writeFile(join(legacy, "routing-2026-08-20.jsonl"), "{}", "utf-8");
    await ensureLogDir(target);
    await writeFile(join(target, "usage-2026-08-20.jsonl"), "existing", "utf-8");

    const result = await migrateLegacyLogDir(target, legacy);

    expect(result.moved).toBe(1);
    expect(result.skipped).toBe(1);
    expect((await stat(join(target, "routing-2026-08-20.jsonl"))).isFile()).toBe(true);
    await expect(stat(join(legacy, "routing-2026-08-20.jsonl"))).rejects.toBeDefined();
  });

  it("leaves non-file entries in the legacy directory behind", async () => {
    await ensureLogDir(legacy);
    await ensureLogDir(join(legacy, "nested"));

    const result = await migrateLegacyLogDir(target, legacy);

    expect(result).toEqual({ moved: 0, skipped: 1 });
  });
});

describe("defaultLogDir", () => {
  it("uses the unified .nexus-router directory", () => {
    expect(defaultLogDir()).toBe(join(homedir(), ".nexus-router", "logs"));
  });
});
