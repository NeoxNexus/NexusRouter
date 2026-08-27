import { describe, it, expect, vi } from "vitest";
import {
  parseArgs,
  printHelp,
  classifyKeyMode,
  isMainModule,
  resolveListenPort,
} from "./cli.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigSchema, type Config } from "./config/schema.js";

function makeConfig(partial: Partial<Config> = {}): Config {
  return ConfigSchema.parse(partial);
}

describe("parseArgs", () => {
  it("defaults to starting the server", () => {
    const args = parseArgs([]);
    expect(args.version).toBe(false);
    expect(args.help).toBe(false);
    expect(args.doctor).toBe(false);
    expect(args.stats).toBe(false);
    expect(args.report).toBe(false);
  });

  it("parses stats command with optional days", () => {
    expect(parseArgs(["stats"]).stats).toBe(true);
    expect(parseArgs(["stats", "1"]).stats).toBe(true);
    expect(parseArgs(["stats", "1"]).days).toBe(1);
    expect(parseArgs(["stats", "30"]).days).toBe(30);
  });

  it("parses report command with optional days and json flag", () => {
    const args = parseArgs(["report", "7", "--json"]);
    expect(args.report).toBe(true);
    expect(args.days).toBe(7);
    expect(args.json).toBe(true);
  });

  it("parses json flag for stats", () => {
    const args = parseArgs(["stats", "--json"]);
    expect(args.stats).toBe(true);
    expect(args.json).toBe(true);
    expect(args.days).toBeUndefined();
  });

  it("parses port and config options", () => {
    const args = parseArgs(["--port", "9999", "--config", "/tmp/cfg.yaml"]);
    expect(args.port).toBe(9999);
    expect(args.config).toBe("/tmp/cfg.yaml");
  });

  it("collects doctor question from remaining args", () => {
    const args = parseArgs(["doctor", "why", "is", "this", "failing"]);
    expect(args.doctor).toBe(true);
    expect(args.doctorQuestion).toBe("why is this failing");
  });
});

describe("printHelp", () => {
  it("mentions stats, report and doctor commands", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    printHelp();
    const output = logs.join("\n");
    expect(output).toContain("stats [days]");
    expect(output).toContain("report [days]");
    expect(output).toContain("doctor");
    vi.restoreAllMocks();
  });
});

describe("classifyKeyMode", () => {
  it("returns 'passthrough' when any provider enables passthroughApiKey", () => {
    const config = makeConfig({
      providers: {
        openai: { apiKey: "", passthroughApiKey: true, maxRetries: 3, injectStreamUsage: true },
        anthropic: {
          apiKey: "sk-secret",
          passthroughApiKey: false,
          maxRetries: 3,
          injectStreamUsage: true,
        },
      },
    });
    expect(classifyKeyMode(config)).toBe("passthrough");
  });

  it("returns 'fixed' when a provider has a non-empty server-side key", () => {
    const config = makeConfig({
      providers: {
        openai: {
          apiKey: "sk-server",
          passthroughApiKey: false,
          maxRetries: 3,
          injectStreamUsage: true,
        },
        anthropic: { apiKey: "", passthroughApiKey: false, maxRetries: 3, injectStreamUsage: true },
      },
    });
    expect(classifyKeyMode(config)).toBe("fixed");
  });

  it("returns 'none' when no provider has keys or passthrough", () => {
    const config = makeConfig({
      providers: {
        openai: { apiKey: "", passthroughApiKey: false, maxRetries: 3, injectStreamUsage: true },
      },
    });
    expect(classifyKeyMode(config)).toBe("none");
  });

  it("returns 'none' for an empty provider set", () => {
    const config = makeConfig();
    expect(classifyKeyMode(config)).toBe("none");
  });
});

// npm installs a CLI as a symlink in node_modules/.bin. Node resolves
// import.meta.url to the real file but leaves process.argv[1] as the symlink
// path, so comparing them raw makes the entry guard false and `nexusrouter`
// exits 0 having done nothing. Verified against a real 0.12.6 tarball install.
describe("isMainModule", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nr-main-"));
  const real = path.join(tmp, "cli.js");
  const link = path.join(tmp, "cli-link.js");
  fs.writeFileSync(real, "");
  fs.symlinkSync(real, link);
  // Node reports import.meta.url fully resolved; on macOS os.tmpdir() sits
  // under the /var → /private/var symlink, so build the expectation the same
  // way rather than from the unresolved path.
  const realUrl = pathToFileURL(fs.realpathSync(real)).href;

  it("matches when invoked through the real path", () => {
    expect(isMainModule(realUrl, real)).toBe(true);
  });

  it("matches when invoked through a symlink", () => {
    expect(isMainModule(realUrl, link)).toBe(true);
  });

  it("does not match an unrelated entry point", () => {
    expect(isMainModule(realUrl, path.join(tmp, "other.js"))).toBe(false);
  });

  it("does not match when there is no entry point", () => {
    expect(isMainModule(realUrl, undefined)).toBe(false);
  });
});

// router.port in config.yaml was dead: main() resolved the port to a concrete
// 8402 whenever neither --port nor NEXUSROUTER_PORT was set, and
// startServer's `port || config.router.port` then never reached the config.
describe("resolvelistenPort", () => {
  it("prefers an explicit --port", () => {
    expect(resolveListenPort(9001, "9002")).toBe(9001);
  });

  it("falls back to NEXUSROUTER_PORT", () => {
    expect(resolveListenPort(undefined, "9002")).toBe(9002);
  });

  it("returns undefined so config.router.port can apply", () => {
    expect(resolveListenPort(undefined, undefined)).toBeUndefined();
  });

  it("ignores a non-numeric NEXUSROUTER_PORT rather than listening on NaN", () => {
    expect(resolveListenPort(undefined, "not-a-port")).toBeUndefined();
  });
});
