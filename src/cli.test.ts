import { describe, it, expect } from "vitest";
import { parseArgs } from "./cli.js";

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
