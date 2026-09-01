/**
 * Minimal end-to-end test of the production request pipeline.
 *
 * Unlike server.test.ts (which uses Fastify inject or stubbed fetch), this
 * suite starts a real listening NexusRouter server and a real mock upstream
 * over HTTP, then drives full requests through: protocol adaptation →
 * classification → tier routing → forwarding → response passthrough.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { startServer, type RunningServer } from "./server.js";

type UpstreamCall = { url: string; authorization: string | null; model: string };

const calls: UpstreamCall[] = [];
let upstream: Server;
let upstreamPort: number;
let nexus: RunningServer;
let tmpDir: string;

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

beforeAll(async () => {
  // Keep every file the server writes (routing logs, ledger) inside a tmp dir.
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-e2e-"));
  process.env.NEXUSROUTER_LOG_DIR = path.join(tmpDir, "logs");

  // Mock upstream: serves both OpenAI and Anthropic shapes, records what it got.
  upstream = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({
        url: req.url ?? "",
        authorization: req.headers.authorization ?? null,
        model: body.model ?? "",
      });
      if (req.url === "/v1/chat/completions") {
        json(res, 200, {
          id: "chatcmpl-e2e",
          object: "chat.completion",
          choices: [
            { index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        });
      } else if (req.url === "/v1/messages") {
        json(res, 200, {
          id: "msg_e2e",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "pong" }],
          model: body.model,
          usage: { input_tokens: 5, output_tokens: 3 },
        });
      } else {
        json(res, 404, { error: "unknown path" });
      }
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = (upstream.address() as AddressInfo).port;

  const configPath = path.join(tmpDir, "config.yaml");
  await fs.writeFile(
    configPath,
    `
router:
  port: 8402
  hosts: ["127.0.0.1"]
  timeout: 10000
  dashboard: false
  classifier: hybrid
  layers:
    rules:
      enabled: true
    heuristic:
      confidenceThreshold: 0.92
    ai:
      fallbackConfidence: 0.75
providers:
  openai:
    baseUrl: http://127.0.0.1:${upstreamPort}/v1
    apiKey: server-key
    passthroughApiKey: true
  anthropic:
    baseUrl: http://127.0.0.1:${upstreamPort}
    apiKey: server-key
    passthroughApiKey: true
tiers:
  SIMPLE:
    primary: openai/gpt-4o-mini
    fallback: []
  MEDIUM:
    primary: openai/gpt-4o
    fallback: []
  COMPLEX:
    primary: anthropic/claude-sonnet-4-5
    fallback: []
  REASONING:
    primary: openai/o3-mini
    fallback: []
ollama:
  enabled: false
`,
  );

  // Grab a free port, then hand it to startServer (small TOCTOU window, fine in tests).
  const probe = createHttpServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  nexus = await startServer(configPath, port);
});

afterAll(async () => {
  await nexus?.close();
  await new Promise<void>((resolve) => upstream?.close(() => resolve()));
  delete process.env.NEXUSROUTER_LOG_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("E2E: production pipeline over real HTTP", () => {
  it("routes a greeting to the SIMPLE tier and passes the response through", async () => {
    const res = await fetch(`http://127.0.0.1:${nexus.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer client-key" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe("pong");

    const upstreamCall = calls.find((c) => c.url === "/v1/chat/completions");
    expect(upstreamCall?.model).toBe("gpt-4o-mini"); // tier model replaced "auto"
    expect(upstreamCall?.authorization).toBe("Bearer client-key"); // passthrough key
  });

  it("routes a proof request to the REASONING tier", async () => {
    const res = await fetch(`http://127.0.0.1:${nexus.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer client-key" },
      body: JSON.stringify({
        model: "auto",
        messages: [
          {
            role: "user",
            content: "Prove by induction that the sum of the first n odd numbers equals n^2.",
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const proofCalls = calls.filter((c) => c.url === "/v1/chat/completions");
    expect(proofCalls.at(-1)?.model).toBe("o3-mini");
  });

  it("serves the Anthropic protocol and forwards to the COMPLEX tier provider", async () => {
    const res = await fetch(`http://127.0.0.1:${nexus.port}/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "client-key",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "auto",
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content:
              "Analyze the architecture of this distributed system and evaluate its consensus trade-offs in depth.",
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("message");

    const anthropicCall = calls.find((c) => c.url === "/v1/messages");
    expect(anthropicCall?.model).toBe("claude-sonnet-4-5");
  });
});
