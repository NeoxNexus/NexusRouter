import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../server.js";
import type { FastifyInstance } from "fastify";

async function writeTempConfig(dashboard: boolean, logDir: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-web-"));
  const path = join(dir, "config.yaml");
  const yaml = `router:
  port: 0
  hosts: ["127.0.0.1"]
  dashboard: ${dashboard}
  timeout: 30000
  layers:
    rules:
      enabled: true
    heuristic:
      confidenceThreshold: 0.92
    ai:
      fallbackConfidence: 0.75

providers:
  openai:
    apiKey: sk-test
    baseUrl: http://127.0.0.1:1

tiers:
  SIMPLE:
    primary: openai/gpt-4o-mini
    fallback: []

hints:
  thinking: off

ollama:
  enabled: false

accounting:
  enabled: false
`;
  await writeFile(path, yaml);
  return path;
}

async function readFirstSseEvent(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  if (!res.body) throw new Error("no response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const match = buffer.match(/data: (.+)\n\n/s);
    if (match) {
      await reader.cancel();
      return JSON.parse(match[1]) as Record<string, unknown>;
    }
  }
  throw new Error("no sse event received");
}

describe("/dashboard web UI", () => {
  let configPath = "";
  let app: FastifyInstance | null = null;
  let configDir = "";
  let logDir = "";

  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), "nexus-web-log-"));
    process.env.NEXUSROUTER_LOG_DIR = logDir;
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    if (configDir) await rm(configDir, { recursive: true, force: true }).catch(() => {});
    if (logDir) await rm(logDir, { recursive: true, force: true }).catch(() => {});
    delete process.env.NEXUSROUTER_LOG_DIR;
  });

  it("returns 404 when dashboard is disabled", async () => {
    configPath = await writeTempConfig(false, logDir);
    configDir = configPath.replace(/\\config\.yaml$/, "");
    app = await createServer(configPath, undefined, false);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/dashboard`);
    expect(res.status).toBe(404);
  });

  it("serves the HTML page when dashboard is enabled", async () => {
    configPath = await writeTempConfig(true, logDir);
    configDir = configPath.replace(/\\config\.yaml$/, "");
    app = await createServer(configPath, undefined, false);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/dashboard`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("NexusRouter");
    expect(html).toContain("/dashboard/events");
    expect(html).toContain("EventSource");
  });

  it("streams SSE events with aggregates and recent entries", async () => {
    configPath = await writeTempConfig(true, logDir);
    configDir = configPath.replace(/\\config\.yaml$/, "");
    app = await createServer(configPath, undefined, false);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const event = await readFirstSseEvent(`http://127.0.0.1:${port}/dashboard/events`);
    expect(event).toHaveProperty("aggregates");
    expect(event).toHaveProperty("recent");
    expect(event).toHaveProperty("router");
    expect(event).toHaveProperty("baselineMode");
    const aggregates = event.aggregates as Record<string, unknown>;
    expect(aggregates.totalRequests).toBe(0);
  }, 10_000);
});
