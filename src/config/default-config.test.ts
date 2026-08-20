import { describe, it, expect, afterEach } from "vitest";
import { readFile, mkdtemp, rm, writeFile, readFile as read } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { ConfigSchema } from "./schema.js";
import { DEFAULT_CONFIG_YAML, getDefaultConfigPath, ensureConfigExists } from "./default-config.js";

describe("default-config", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeTmpDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "nexus-cfg-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("embedded template is valid YAML that passes the real config schema", () => {
    // Replaces an earlier byte-identity check against the repo-root config.yaml.
    // That invariant was wrong: the repo config.yaml is the maintainer's live
    // deployment config (a specific gateway baseUrl, passthroughApiKey: true,
    // four opus tiers). Shipping it as every new user's default would hardcode a
    // third-party gateway and turn credential passthrough on by default. What
    // actually needs guarding is that the template still parses and validates.
    const parsed = parse(DEFAULT_CONFIG_YAML.replace(/\$\{[^}]+\}/g, "test-key"));
    expect(() => ConfigSchema.parse(parsed)).not.toThrow();
  });

  it("embedded template covers every top-level section the repo config uses", async () => {
    // Structural, not byte-wise: catches a new required section landing in the
    // repo config while the template rots, without pinning deployment values.
    const repoConfig = parse(
      (await readFile(join(process.cwd(), "config.yaml"), "utf-8")).replace(
        /\$\{[^}]+\}/g,
        "test-key",
      ),
    ) as Record<string, unknown>;
    const template = parse(DEFAULT_CONFIG_YAML.replace(/\$\{[^}]+\}/g, "test-key")) as Record<
      string,
      unknown
    >;

    // `hints` is optional and deployment-specific, so it is allowed to be absent.
    const required = Object.keys(repoConfig).filter((k) => k !== "hints");
    expect(Object.keys(template)).toEqual(expect.arrayContaining(required));
  });

  it("embedded template keeps the loopback-only bind default", () => {
    // Regression guard for c2bf803: a template shipping 0.0.0.0 would expose
    // every new user's API quota to their LAN on first launch.
    const template = parse(DEFAULT_CONFIG_YAML.replace(/\$\{[^}]+\}/g, "test-key")) as {
      router?: { hosts?: string[] };
    };
    expect(template.router?.hosts).toEqual(["127.0.0.1", "::1"]);
  });

  it("resolves the default path under the home dir, cross-platform", () => {
    expect(getDefaultConfigPath()).toBe(join(homedir(), ".nexus-router", "config.yaml"));
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
