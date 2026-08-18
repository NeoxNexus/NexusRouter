import { describe, it, expect, afterEach } from "vitest";
import { readFile, mkdtemp, rm, writeFile, readFile as read } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG_YAML,
  getDefaultConfigPath,
  ensureConfigExists,
} from "./default-config.js";

describe("default-config", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
    );
  });

  async function makeTmpDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "nexus-cfg-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("embedded template stays byte-identical to repo config.yaml (drift guard)", async () => {
    const repoConfig = await readFile(
      join(process.cwd(), "config.yaml"),
      "utf-8",
    );
    expect(DEFAULT_CONFIG_YAML).toBe(repoConfig);
  });

  it("resolves the default path under the home dir, cross-platform", () => {
    expect(getDefaultConfigPath()).toBe(
      join(homedir(), ".nexus-router", "config.yaml"),
    );
  });

  it("creates the config from the template when missing", async () => {
    const dir = await makeTmpDir();
    const target = join(dir, "nested", "config.yaml");

    const result = await ensureConfigExists(target);

    expect(result).toEqual({ path: target, created: true });
    expect(await read(target, "utf-8")).toBe(DEFAULT_CONFIG_YAML);
  });

  it("never overwrites an existing config", async () => {
    const dir = await makeTmpDir();
    const target = join(dir, "config.yaml");
    await writeFile(target, "router:\n  port: 9999\n");

    const result = await ensureConfigExists(target);

    expect(result).toEqual({ path: target, created: false });
    expect(await read(target, "utf-8")).toBe("router:\n  port: 9999\n");
  });
});
