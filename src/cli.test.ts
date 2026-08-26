import { describe, it, expect, vi } from "vitest";
import { parseArgs, printHelp, classifyKeyMode } from "./cli.js";
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
