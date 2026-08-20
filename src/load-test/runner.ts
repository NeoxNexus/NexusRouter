/**
 * Load-test runner — local mock upstream + NexusRouter + concurrent workers.
 *
 * All network I/O is against loopback; no real LLM keys are required.
 */

import { createServer as createHttpServer, type Server } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyBaseLogger, FastifyLoggerOptions } from "fastify";
import { createServer } from "../server.js";
import { buildResult, formatReport } from "./stats.js";
import type { LoadTestOptions, LoadTestResult, RequestSample } from "./types.js";

export { formatReport };

const MOCK_RESPONSE = JSON.stringify({
  id: "chatcmpl-mock",
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model: "gpt-4o-mini",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello from mock upstream" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

export type MockUpstream = {
  port: number;
  close: () => Promise<void>;
  requests: number;
};

/** Start a minimal mock OpenAI upstream on a random port. */
export function createMockUpstream(preferredPort = 0): Promise<MockUpstream> {
  return new Promise((resolve, reject) => {
    let requests = 0;
    const server = createHttpServer((req, res) => {
      if (req.method === "POST" && req.url === "/chat/completions") {
        requests++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(MOCK_RESPONSE);
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });

    server.listen(preferredPort, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : preferredPort;
      resolve({
        port,
        requests,
        close: () =>
          new Promise((res) =>
            server.close((err) => {
              if (err) {
                // Best effort; server may already be closed.
              }
              res();
            }),
          ),
      });
    });

    server.once("error", reject);
  });
}

export type RouterConfigOptions = {
  mockPort: number;
  routerPort: number;
  accounting: boolean;
  logDir?: string;
};

/** Write a temporary config.yaml that points openai at the mock upstream. */
export async function writeRouterConfig(opts: RouterConfigOptions): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-load-"));
  const configPath = join(dir, "config.yaml");
  const yaml = `router:
  port: ${opts.routerPort}
  hosts: ["127.0.0.1"]
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
    apiKey: sk-loadtest
    baseUrl: http://127.0.0.1:${opts.mockPort}

tiers:
  SIMPLE:
    primary: openai/gpt-4o-mini
    fallback: []
  MEDIUM:
    primary: openai/gpt-4o
    fallback: []
  COMPLEX:
    primary: openai/gpt-4o
    fallback: []
  REASONING:
    primary: openai/o3-mini
    fallback: []

hints:
  thinking: off

ollama:
  enabled: false
  baseUrl: http://localhost:11434

accounting:
  enabled: ${opts.accounting}
  captureNonStreaming: true
  captureStreaming: false
  persist: ${opts.accounting}
  baseline: requested
`;
  await writeFile(configPath, yaml);
  return {
    path: configPath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function sendRequest(url: string): Promise<RequestSample> {
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    await res.text();
    const latencyMs = performance.now() - started;
    return { latencyMs, status: res.status, ok: res.ok };
  } catch {
    const latencyMs = performance.now() - started;
    return { latencyMs, status: 0, ok: false };
  }
}

async function worker(url: string, endTime: number, samples: RequestSample[]): Promise<void> {
  while (Date.now() < endTime) {
    samples.push(await sendRequest(url));
  }
}

export type RunLoadTestOptions = LoadTestOptions & {
  /** Optional Fastify logger override; defaults to silent. */
  logger?: boolean | FastifyBaseLogger | FastifyLoggerOptions;
};

/** Run a complete load test and return aggregated results. */
export async function runLoadTest(opts: RunLoadTestOptions): Promise<LoadTestResult> {
  const upstream = await createMockUpstream();
  const config = await writeRouterConfig({
    mockPort: upstream.port,
    routerPort: opts.routerPort,
    accounting: opts.accounting,
    logDir: opts.logDir,
  });

  const app = await createServer(config.path, undefined, opts.logger ?? false);
  await app.listen({ port: opts.routerPort, host: "127.0.0.1" });
  const address = app.server.address();
  const routerPort = typeof address === "object" && address ? address.port : opts.routerPort;

  const url = `http://127.0.0.1:${routerPort}/v1/chat/completions`;
  const memoryStart = process.memoryUsage();
  const startedAt = Date.now();
  const endTime = startedAt + opts.durationMs;

  const samples: RequestSample[] = [];
  const workers: Promise<void>[] = [];
  for (let i = 0; i < opts.connections; i++) {
    workers.push(worker(url, endTime, samples));
  }
  await Promise.all(workers);
  const durationMs = Date.now() - startedAt;
  const memoryEnd = process.memoryUsage();

  await app.close();
  await config.cleanup();
  await upstream.close();

  return buildResult(opts, samples, durationMs, memoryStart, memoryEnd);
}
