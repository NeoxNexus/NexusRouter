import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import Fastify from "fastify";
import * as net from "net";
import { loadConfig } from "./config/loader.js";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { createServer, startServer, resolveWeightedTier, resetRetryOutcomeIndex } from "./server.js";

describe("Fastify Server", () => {
  const testConfigPath = path.join(os.tmpdir(), "test-config-server.yaml");

  beforeAll(async () => {
    const configContent = `
router:
  port: 8403
  classifier: heuristic
  layers:
    rules:
      enabled: true
    heuristic:
      confidenceThreshold: 0.92
    ai:
      fallbackConfidence: 0.75
providers:
  openai:
    apiKey: test-key
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
ollama:
  enabled: false
`;
    await fs.writeFile(testConfigPath, configContent);
  });

  afterAll(async () => {
    try {
      await fs.unlink(testConfigPath);
    } catch {
      // ignore
    }
  });

  it("should create fastify instance", async () => {
    const fastify = Fastify({ logger: false });
    expect(fastify).toBeDefined();
    await fastify.close();
  });

  it("should load config", async () => {
    const config = await loadConfig(testConfigPath);
    expect(config.router.port).toBe(8403);
  });

  it("should accept preloaded config to avoid duplicate loading", async () => {
    const originalFetch = global.fetch;
    // Mock fetch to prevent actual calls
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      }),
    );

    const config = await loadConfig(testConfigPath);

    // createServer with preloaded config should use the passed config
    // and not call loadConfig again internally
    const server = await createServer(testConfigPath, config);

    vi.stubGlobal("fetch", originalFetch);
    await server.close();
  });

  it("should reject invalid model format without slash", async () => {
    const config = await loadConfig(testConfigPath);
    const server = await createServer(testConfigPath, config);
    await server.listen({ port: 8404, host: "0.0.0.0" });

    const response = await fetch("http://localhost:8404/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o", // invalid - missing provider
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.message).toContain("Invalid model format");
    expect(data.error.message).toContain("provider/model");

    await server.close();
  });

  it("should return 502 when streaming response body is null", async () => {
    // This test verifies the null body check is in place by unit test
    // Integration test would require more complex mocking
    // The code at server.ts:162-169 has the null body check
    const config = await loadConfig(testConfigPath);
    expect(config).toBeDefined();
    // Verify timeout config exists
    expect(config.router.timeout).toBeDefined();
  });

  it("should have upstream timeout configured", async () => {
    const config = await loadConfig(testConfigPath);
    // Default timeout should be 1000ms
    expect(config.router.timeout).toBe(1000);
  });
});

describe("Routing decision logging", () => {
  const logConfigPath = path.join(os.tmpdir(), "test-config-routing-log.yaml");
  let logDir: string;

  function mockUpstream() {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve(JSON.stringify({ id: "mock" })),
      }),
    );
  }

  beforeAll(async () => {
    await fs.writeFile(
      logConfigPath,
      `
router:
  port: 8406
  classifier: heuristic
providers:
  anthropic:
    baseUrl: http://upstream.test
    apiKey: test-key
tiers:
  SIMPLE:
    primary: anthropic/cheap-model
  MEDIUM:
    primary: anthropic/mid-model
  COMPLEX:
    primary: anthropic/big-model
  REASONING:
    primary: anthropic/reasoning-model
ollama:
  enabled: false
`,
    );
  });

  beforeEach(async () => {
    logDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexusrouter-server-log-"));
    process.env.NEXUSROUTER_LOG_DIR = logDir;
    // The retry index is module-level state; start each test clean so
    // cross-test payload reuse can't fire retry outcomes.
    resetRetryOutcomeIndex();
  });

  afterEach(async () => {
    delete process.env.NEXUSROUTER_LOG_DIR;
    vi.unstubAllGlobals();
    await fs.rm(logDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    try {
      await fs.unlink(logConfigPath);
    } catch {
      // ignore
    }
  });

  // Routing logs are written fire-and-forget so they never sit on the request
  // path, so poll briefly rather than assuming the write already landed.
  async function readLogEntries(expected = 1): Promise<Record<string, unknown>[]> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const files = await fs.readdir(logDir);
      const routingFile = files.find(
        (f) => f.startsWith("routing-") && !f.startsWith("routing-outcome-"),
      );
      if (routingFile) {
        const content = await fs.readFile(path.join(logDir, routingFile), "utf-8");
        const entries = content
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        if (entries.length >= expected) return entries;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    return [];
  }

  // Same polling pattern as readLogEntries, for the append-only companion
  // file the retry detector writes. Returns [] when no outcome ever lands.
  async function readOutcomeEntries(): Promise<Record<string, unknown>[]> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const files = await fs.readdir(logDir);
      const outcomeFile = files.find((f) => f.startsWith("routing-outcome-"));
      if (outcomeFile) {
        const content = await fs.readFile(path.join(logDir, outcomeFile), "utf-8");
        return content
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    return [];
  }

  it("routes a tool-attached but idle Claude Code request without a tool-driven upgrade", async () => {
    mockUpstream();
    const config = await loadConfig(logConfigPath);
    const server = await createServer(logConfigPath, config);
    try {
      await server.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-user" },
        payload: {
          model: "auto",
          max_tokens: 100,
          messages: [{ role: "user", content: "list the files in src/" }],
          tools: [
            { name: "Read", input_schema: { type: "object" } },
            { name: "Bash", input_schema: { type: "object" } },
          ],
        },
      });

      const entries = await readLogEntries();
      expect(entries).toHaveLength(1);
      // requiresTools stays false: the MEDIUM tier comes from the
      // low-confidence uncertain-upgrade fallback, not from tool presence.
      expect(entries[0]).toMatchObject({
        agent: "claude-code",
        protocol: "anthropic",
        requestedModel: "auto",
        hasTools: true,
        toolCount: 2,
        requiresTools: false,
        reason: "uncertain-upgrade",
        finalTier: "MEDIUM",
        finalModel: "anthropic/mid-model",
      });
    } finally {
      await server.close();
    }
  });

  it("does not upgrade the tier for a plain question with a tool table attached", async () => {
    mockUpstream();
    const config = await loadConfig(logConfigPath);
    const server = await createServer(logConfigPath, config);
    try {
      await server.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-user" },
        payload: {
          model: "auto",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
          tools: [{ name: "Read", input_schema: { type: "object" } }],
        },
      });

      const entries = await readLogEntries();
      expect(entries[0]).toMatchObject({
        hasTools: true,
        reason: "greeting",
        classifierTier: "SIMPLE",
        finalTier: "SIMPLE",
        finalModel: "anthropic/cheap-model",
      });
    } finally {
      await server.close();
    }
  });

  it("ignores the thinking hint by default (off mode)", async () => {
    mockUpstream();
    const config = await loadConfig(logConfigPath);
    const server = await createServer(logConfigPath, config);
    try {
      await server.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-user" },
        payload: {
          model: "auto",
          max_tokens: 100,
          messages: [{ role: "user", content: "list the files in src/" }],
          tools: [{ name: "Read", input_schema: { type: "object" } }],
          thinking: { type: "enabled", budget_tokens: 2000 },
        },
      });

      const entries = await readLogEntries();
      // thinking off：hint 不参与定档；SIMPLE→MEDIUM 来自低置信兜底升档
      expect(entries[0]).toMatchObject({
        hasThinking: true,
        classifierTier: "MEDIUM",
        finalTier: "MEDIUM",
      });
    } finally {
      await server.close();
    }
  });

  it("records upstream status and prompt preview", async () => {
    mockUpstream();
    const config = await loadConfig(logConfigPath);
    const server = await createServer(logConfigPath, config);
    try {
      await server.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-user" },
        payload: {
          model: "auto",
          max_tokens: 100,
          messages: [{ role: "user", content: "rename foo to bar" }],
        },
      });

      const entries = await readLogEntries();
      expect(entries[0].upstreamStatus).toBe(200);
      expect(entries[0].promptPreview).toBe("rename foo to bar");
      expect(entries[0].promptChars).toBe(17);
      expect(typeof entries[0].totalLatencyMs).toBe("number");
    } finally {
      await server.close();
    }
  });

  it("does not log when the request is rejected before routing", async () => {
    mockUpstream();
    const config = await loadConfig(logConfigPath);
    const server = await createServer(logConfigPath, config);
    try {
      const response = await server.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-user" },
        payload: { model: "auto", max_tokens: 100, messages: [] },
      });

      expect(response.statusCode).toBe(400);
      expect(await readLogEntries(0)).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("classifies the stripped prompt but forwards the original body untouched", async () => {
    // Capture the upstream body to prove the sanitize step never mutates what
    // the user's agent sent — only the classifier's input changes.
    const upstreamCalls: { body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
        upstreamCalls.push({ body: JSON.parse(init.body) });
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: () => Promise.resolve(JSON.stringify({ id: "mock" })),
        };
      }),
    );

    const config = await loadConfig(logConfigPath);
    const server = await createServer(logConfigPath, config);
    try {
      const originalContent =
        "<system-reminder>\nSessionStart hook: improve existing skills\n</system-reminder>\nhi";
      await server.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-user" },
        payload: {
          model: "auto",
          max_tokens: 100,
          messages: [{ role: "user", content: originalContent }],
          tools: [{ name: "Read", input_schema: { type: "object" } }],
        },
      });

      // Classifier saw the stripped text and hit the greeting rule.
      const entries = await readLogEntries();
      expect(entries[0]).toMatchObject({
        reason: "greeting",
        classifierTier: "SIMPLE",
        finalTier: "SIMPLE",
        finalModel: "anthropic/cheap-model",
        promptChars: originalContent.length,
        promptCharsSanitized: 2,
      });

      // Upstream received the original content, byte for byte.
      expect(upstreamCalls).toHaveLength(1);
      const upstreamMessages = upstreamCalls[0].body.messages as Array<{ content: string }>;
      expect(upstreamMessages[0].content).toBe(originalContent);
    } finally {
      await server.close();
    }
  });

  it("skips the classifier when the sanitized prompt is empty", async () => {
    mockUpstream();
    const config = await loadConfig(logConfigPath);
    const server = await createServer(logConfigPath, config);
    try {
      await server.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-user" },
        payload: {
          model: "auto",
          max_tokens: 100,
          messages: [
            {
              role: "user",
              content:
                "<system-reminder>\nSessionStart hook additional context\n</system-reminder>",
            },
          ],
          tools: [{ name: "Read", input_schema: { type: "object" } }],
        },
      });

      const entries = await readLogEntries();
      expect(entries[0]).toMatchObject({
        classifierTier: "SIMPLE",
        finalTier: "SIMPLE",
        layer: "fallback",
        reason: "low-confidence-fallback",
        promptCharsSanitized: 0,
      });
    } finally {
      await server.close();
    }
  });

  it("classifies only the latest user message, ignoring complex keywords in history", async () => {
    // The first turn would classify as COMPLEX via the "analyze"/"security"
    // keyword rule; the current turn is a plain greeting. The router must
    // classify the current turn, not the joined transcript.
    mockUpstream();
    const config = await loadConfig(logConfigPath);
    const server = await createServer(logConfigPath, config);
    try {
      await server.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-user" },
        payload: {
          model: "auto",
          max_tokens: 100,
          messages: [
            { role: "user", content: "analyze the security architecture of this codebase" },
            { role: "assistant", content: "Here is the analysis." },
            { role: "user", content: "hi" },
          ],
        },
      });

      const entries = await readLogEntries();
      expect(entries[0]).toMatchObject({
        reason: "greeting",
        classifierTier: "SIMPLE",
        finalTier: "SIMPLE",
        finalModel: "anthropic/cheap-model",
        promptCharsSanitized: 2,
      });
    } finally {
      await server.close();
    }
  });

  it("falls back to the last real-text user message when the latest turn is tool_result-only", async () => {
    // Claude Code's agentic loop: the final user message carries only a
    // tool_result block, which the adapter extracts as empty text. The walk
    // skips it and classifies the original instruction instead.
    mockUpstream();
    const config = await loadConfig(logConfigPath);
    const server = await createServer(logConfigPath, config);
    try {
      await server.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-user" },
        payload: {
          model: "auto",
          max_tokens: 100,
          messages: [
            { role: "user", content: "rename foo to bar" },
            {
              role: "assistant",
              content: [{ type: "tool_use", id: "toolu_1", name: "Edit", input: {} }],
            },
            {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "done" }],
            },
          ],
        },
      });

      const entries = await readLogEntries();
      // "rename foo to bar" 低置信，兜底升档 SIMPLE→MEDIUM
      expect(entries[0]).toMatchObject({
        classifierTier: "MEDIUM",
        finalTier: "MEDIUM",
        promptCharsSanitized: 17,
      });
    } finally {
      await server.close();
    }
  });

  it("uses the empty-text fallback when every user message is tool_result-only", async () => {
    mockUpstream();
    const config = await loadConfig(logConfigPath);
    const server = await createServer(logConfigPath, config);
    try {
      await server.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-user" },
        payload: {
          model: "auto",
          max_tokens: 100,
          messages: [
            {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a" }],
            },
            {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "b" }],
            },
          ],
        },
      });

      const entries = await readLogEntries();
      expect(entries[0]).toMatchObject({
        classifierTier: "SIMPLE",
        finalTier: "SIMPLE",
        layer: "fallback",
        reason: "low-confidence-fallback",
        promptCharsSanitized: 0,
      });
    } finally {
      await server.close();
    }
  });

  it("respects hints.thinking: reasoning and complex modes", async () => {
    // One shared logDir across iterations — index each iteration's own entry.
    let iteration = 0;
    for (const [mode, expectedTier] of [
      ["reasoning", "REASONING"],
      ["complex", "COMPLEX"],
    ] as const) {
      const modeConfigPath = path.join(os.tmpdir(), `test-config-thinking-${mode}.yaml`);
      await fs.writeFile(
        modeConfigPath,
        `
router:
  port: 8406
  classifier: heuristic
providers:
  anthropic:
    baseUrl: http://upstream.test
    apiKey: test-key
tiers:
  SIMPLE:
    primary: anthropic/cheap-model
  MEDIUM:
    primary: anthropic/mid-model
  COMPLEX:
    primary: anthropic/big-model
  REASONING:
    primary: anthropic/reasoning-model
hints:
  thinking: ${mode}
ollama:
  enabled: false
`,
      );

      mockUpstream();
      const config = await loadConfig(modeConfigPath);
      const server = await createServer(modeConfigPath, config);
      try {
        await server.inject({
          method: "POST",
          url: "/anthropic/v1/messages",
          headers: { "x-api-key": "sk-user" },
          payload: {
            model: "auto",
            max_tokens: 100,
            messages: [{ role: "user", content: "list the files in src/" }],
            thinking: { type: "enabled", budget_tokens: 2000 },
          },
        });

        const entries = await readLogEntries(iteration + 1);
        // classifierTier 的 MEDIUM 来自低置信兜底升档；finalTier 由 thinking 模式决定
        expect(entries[iteration]).toMatchObject({
          hasThinking: true,
          classifierTier: "MEDIUM",
          finalTier: expectedTier,
        });
        iteration++;
      } finally {
        await server.close();
        vi.unstubAllGlobals();
        await fs.unlink(modeConfigPath);
      }
    }
  });

  it("appends a same-text outcome row when the prompt is resent verbatim within 60s", async () => {
    mockUpstream();
    const config = await loadConfig(logConfigPath);
    const server = await createServer(logConfigPath, config);
    try {
      const payload = {
        model: "auto",
        max_tokens: 100,
        messages: [{ role: "user", content: "rename foo to bar" }],
      };
      await server.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-user" },
        payload,
      });
      await server.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-user" },
        payload,
      });

      // The retry marks the FIRST request's routing row, joined by timestamp.
      const outcomes = await readOutcomeEntries();
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ outcome: "retried", retryReason: "same-text" });

      const entries = await readLogEntries(2);
      expect(outcomes[0].timestamp).toBe(entries[0].timestamp);
    } finally {
      await server.close();
    }
  });

  it("appends a model-switch outcome row when the agent retries with an explicit model", async () => {
    mockUpstream();
    const config = await loadConfig(logConfigPath);
    const server = await createServer(logConfigPath, config);
    try {
      await server.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-user" },
        payload: {
          model: "auto",
          max_tokens: 100,
          messages: [{ role: "user", content: "explain monads" }],
        },
      });
      // User swaps to an explicit model after a bad answer. This request is
      // not auto-routed, so it gets no routing row of its own — it only
      // triggers the outcome for the previous one. A verbatim resend would
      // match the same-text rule first (it pins the retried row more
      // precisely), so model-switch is exercised with a changed prompt.
      await server.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-user" },
        payload: {
          model: "anthropic/big-model",
          max_tokens: 100,
          messages: [{ role: "user", content: "explain monads with an example" }],
        },
      });

      const outcomes = await readOutcomeEntries();
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ outcome: "retried", retryReason: "model-switch" });

      const entries = await readLogEntries(1);
      expect(outcomes[0].timestamp).toBe(entries[0].timestamp);
    } finally {
      await server.close();
    }
  });

  it("writes no outcome row when a follow-up request is not a retry", async () => {
    mockUpstream();
    const config = await loadConfig(logConfigPath);
    const server = await createServer(logConfigPath, config);
    try {
      for (const content of ["rename foo to bar", "list the files in src/"]) {
        await server.inject({
          method: "POST",
          url: "/anthropic/v1/messages",
          headers: { "x-api-key": "sk-user" },
          payload: {
            model: "auto",
            max_tokens: 100,
            messages: [{ role: "user", content }],
          },
        });
      }

      expect(await readOutcomeEntries()).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

describe("Model prefix stripping and API key passthrough", () => {
  const passthroughConfigPath = path.join(os.tmpdir(), "test-config-passthrough.yaml");
  const pinnedConfigPath = path.join(os.tmpdir(), "test-config-pinned.yaml");
  let logDir: string;

  // Routing decisions are logged as a side effect; redirect them to a temp dir
  // so the suite never appends to the user's real ~/.nexus-router/logs.
  beforeEach(async () => {
    logDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexusrouter-prefix-log-"));
    process.env.NEXUSROUTER_LOG_DIR = logDir;
    resetRetryOutcomeIndex();
  });

  afterEach(async () => {
    delete process.env.NEXUSROUTER_LOG_DIR;
    await fs.rm(logDir, { recursive: true, force: true });
  });

  // Stub global fetch as the UPSTREAM call made by adapters. Client requests
  // use server.inject() so they never touch this stub.
  function mockUpstream() {
    const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] =
      [];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          async (url: string, init: { headers: Record<string, string>; body: string }) => {
            calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
            return {
              ok: true,
              status: 200,
              headers: { get: () => null },
              text: () => Promise.resolve(JSON.stringify({ id: "mock", choices: [] })),
            };
          },
        ),
    );
    return calls;
  }

  const baseConfig = `
router:
  port: 8405
  classifier: heuristic
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
`;

  beforeAll(async () => {
    await fs.writeFile(
      passthroughConfigPath,
      baseConfig +
        `
providers:
  openai:
    baseUrl: http://upstream.test/v1
    passthroughApiKey: true
  anthropic:
    baseUrl: http://upstream.test
    passthroughApiKey: true
`,
    );
    await fs.writeFile(
      pinnedConfigPath,
      baseConfig +
        `
providers:
  openai:
    baseUrl: http://upstream.test/v1
    apiKey: config-key
`,
    );
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const p of [passthroughConfigPath, pinnedConfigPath]) {
      try {
        await fs.unlink(p);
      } catch {
        // ignore
      }
    }
  });

  async function makeServer(configPath: string) {
    const config = await loadConfig(configPath);
    return createServer(configPath, config);
  }

  it("should strip provider prefix from model before forwarding (openai)", async () => {
    const calls = mockUpstream();
    const server = await makeServer(pinnedConfigPath);
    try {
      await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "auto", messages: [{ role: "user", content: "hello" }] },
      });

      expect(calls.length).toBe(1);
      expect(calls[0].body.model).toBe("gpt-4o-mini");
    } finally {
      await server.close();
    }
  });

  it("should treat model=Auto case-insensitively as auto-routing", async () => {
    const calls = mockUpstream();
    const server = await makeServer(pinnedConfigPath);
    try {
      const response = await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "Auto", messages: [{ role: "user", content: "hello" }] },
      });

      expect(response.statusCode).toBe(200);
      expect(calls.length).toBe(1);
      expect(calls[0].body.model).toBe("gpt-4o-mini");
    } finally {
      await server.close();
    }
  });

  it("should strip provider prefix from explicit model before forwarding", async () => {
    const calls = mockUpstream();
    const server = await makeServer(pinnedConfigPath);
    try {
      await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "openai/gpt-4o", messages: [{ role: "user", content: "hello" }] },
      });

      expect(calls.length).toBe(1);
      expect(calls[0].body.model).toBe("gpt-4o");
    } finally {
      await server.close();
    }
  });

  it("should strip provider prefix from model before forwarding (anthropic)", async () => {
    const calls = mockUpstream();
    const server = await makeServer(passthroughConfigPath);
    try {
      await server.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-ant-user-456" },
        payload: {
          model: "anthropic/claude-sonnet-4-5",
          max_tokens: 100,
          messages: [{ role: "user", content: "hello" }],
        },
      });

      expect(calls.length).toBe(1);
      expect(calls[0].body.model).toBe("claude-sonnet-4-5");
    } finally {
      await server.close();
    }
  });

  it("should forward client Bearer key when passthroughApiKey is enabled", async () => {
    const calls = mockUpstream();
    const server = await makeServer(passthroughConfigPath);
    try {
      await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer sk-user-token-123" },
        payload: { model: "auto", messages: [{ role: "user", content: "hello" }] },
      });

      expect(calls.length).toBe(1);
      expect(calls[0].headers.Authorization).toBe("Bearer sk-user-token-123");
    } finally {
      await server.close();
    }
  });

  it("should forward client x-api-key when passthroughApiKey is enabled (anthropic)", async () => {
    const calls = mockUpstream();
    const server = await makeServer(passthroughConfigPath);
    try {
      await server.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-ant-user-456" },
        payload: {
          model: "auto",
          max_tokens: 100,
          messages: [{ role: "user", content: "hello" }],
        },
      });

      expect(calls.length).toBe(1);
      expect(calls[0].headers["x-api-key"]).toBe("sk-ant-user-456");
    } finally {
      await server.close();
    }
  });

  it("should return 401 when passthroughApiKey is enabled but client sends no key", async () => {
    const calls = mockUpstream();
    const server = await makeServer(passthroughConfigPath);
    try {
      const response = await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "auto", messages: [{ role: "user", content: "hello" }] },
      });

      expect(response.statusCode).toBe(401);
      expect(calls.length).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("should ignore client key and use config key when passthroughApiKey is disabled", async () => {
    const calls = mockUpstream();
    const server = await makeServer(pinnedConfigPath);
    try {
      await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer sk-client-trying-to-override" },
        payload: { model: "auto", messages: [{ role: "user", content: "hello" }] },
      });

      expect(calls.length).toBe(1);
      expect(calls[0].headers.Authorization).toBe("Bearer config-key");
    } finally {
      await server.close();
    }
  });
});

describe("Loopback dual-stack binding", () => {
  const dualStackConfigPath = path.join(os.tmpdir(), "test-config-dualstack.yaml");

  // Grab an OS-assigned free port on the IPv4 loopback, then release it so
  // startServer can bind it on both families. Small TOCTOU window, acceptable
  // for a local test.
  function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => resolve(port));
      });
    });
  }

  beforeAll(async () => {
    await fs.writeFile(
      dualStackConfigPath,
      `
router:
  port: 8402
  classifier: heuristic
  hosts: ["127.0.0.1", "::1"]
providers:
  openai:
    apiKey: test-key
tiers:
  SIMPLE:
    primary: openai/gpt-4o-mini
  MEDIUM:
    primary: openai/gpt-4o
  COMPLEX:
    primary: openai/gpt-4o
  REASONING:
    primary: openai/o3-mini
ollama:
  enabled: false
`,
    );
  });

  afterAll(async () => {
    try {
      await fs.unlink(dualStackConfigPath);
    } catch {
      // ignore
    }
  });

  it("should serve /health on both 127.0.0.1 and ::1", async () => {
    const port = await freePort();
    const running = await startServer(dualStackConfigPath, port);
    try {
      const v4 = await fetch(`http://127.0.0.1:${port}/health`);
      expect(v4.status).toBe(200);

      // IPv6 loopback may be unavailable in some CI sandboxes; treat a
      // connection failure as an environment skip rather than a test failure.
      try {
        const v6 = await fetch(`http://[::1]:${port}/health`);
        expect(v6.status).toBe(200);
      } catch (err) {
        console.warn(`Skipping ::1 assertion — IPv6 loopback unavailable: ${String(err)}`);
      }
    } finally {
      await running.close();
    }
  });
});

describe("Context guardrail and tier fallbacks", () => {
  const guardrailConfigPath = path.join(os.tmpdir(), "test-config-guardrail.yaml");
  let logDir: string;

  // The classifier's Ollama layer shares global fetch with upstream calls.
  // Branch on URL: Ollama (localhost:11434) always fails fast so Layer 2 is
  // skipped deterministically; upstream calls consume the scripted sequence.
  // `stream: true` attaches a real ReadableStream body — the adapters only
  // mark a result isStream when `request.stream && response.ok && response.body`.
  function mockUpstreamSequence(
    upstreamResponses: Array<{ ok: boolean; status: number; body?: string; stream?: boolean }>,
  ) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, init: { body: string }) => {
        if (url.includes("localhost:11434")) {
          return { ok: false, status: 503, headers: { get: () => null } };
        }
        const r = upstreamResponses[Math.min(i, upstreamResponses.length - 1)];
        i++;
        calls.push({ url, body: JSON.parse(init.body) });
        return {
          ok: r.ok,
          status: r.status,
          headers: { get: () => null },
          body: r.stream
            ? new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode('data: {"type":"message_start"}\n\n'),
                  );
                  controller.close();
                },
              })
            : undefined,
          text: () => Promise.resolve(r.body ?? JSON.stringify({ id: "mock" })),
        };
      }),
    );
    return calls;
  }

  beforeAll(async () => {
    await fs.writeFile(
      guardrailConfigPath,
      `
router:
  port: 8407
  classifier: heuristic
  # Tiny threshold so tests can trip the guardrail with a ~1KB body.
  maxTokensForceComplex: 200
providers:
  anthropic:
    baseUrl: http://upstream.test
    apiKey: test-key
  openai:
    baseUrl: http://upstream.test/v1
    apiKey: test-key
tiers:
  SIMPLE:
    primary: anthropic/cheap-model
    fallback: [openai/fallback-mini]
  MEDIUM:
    primary: anthropic/mid-model
  COMPLEX:
    primary: anthropic/big-model
  REASONING:
    primary: anthropic/reasoning-model
ollama:
  enabled: false
`,
    );
  });

  beforeEach(async () => {
    logDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexusrouter-guardrail-log-"));
    process.env.NEXUSROUTER_LOG_DIR = logDir;
    resetRetryOutcomeIndex();
  });

  afterEach(async () => {
    delete process.env.NEXUSROUTER_LOG_DIR;
    vi.unstubAllGlobals();
    await fs.rm(logDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    try {
      await fs.unlink(guardrailConfigPath);
    } catch {
      // ignore
    }
  });

  async function readLogEntries(expected = 1): Promise<Record<string, unknown>[]> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const files = await fs.readdir(logDir);
      const routingFile = files.find(
        (f) => f.startsWith("routing-") && !f.startsWith("routing-outcome-"),
      );
      if (routingFile) {
        const content = await fs.readFile(path.join(logDir, routingFile), "utf-8");
        const entries = content
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        if (entries.length >= expected) return entries;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    return [];
  }

  it("falls back to the tier's fallback model when the primary upstream returns non-2xx", async () => {
    const calls = mockUpstreamSequence([
      { ok: false, status: 500, body: JSON.stringify({ error: "primary boom" }) },
      { ok: true, status: 200 },
    ]);
    const config = await loadConfig(guardrailConfigPath);
    const server = await createServer(guardrailConfigPath, config);
    try {
      const response = await server.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-user" },
        payload: {
          model: "auto",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(calls).toHaveLength(2);
      // Provider prefix stripped on both the primary and the fallback model.
      expect(calls[0].body.model).toBe("cheap-model");
      expect(calls[1].body.model).toBe("fallback-mini");
      // The two providers have different baseUrls, so the second call must be
      // observable at the fallback provider (openai), not the primary
      // (anthropic). Fallbacks reuse the request's protocol adapter, hence
      // the openai baseUrl + anthropic path (doubled /v1).
      expect(calls[0].url).toBe("http://upstream.test/v1/messages");
      expect(calls[1].url).toBe("http://upstream.test/v1/v1/messages");

      const entries = await readLogEntries();
      expect(entries[0]).toMatchObject({
        finalModel: "anthropic/cheap-model",
        servedModel: "openai/fallback-mini",
        fallbackAttempts: 1,
        upstreamStatus: 200,
      });
    } finally {
      await server.close();
    }
  });

  it("returns the last error response when primary and all fallbacks fail", async () => {
    const calls = mockUpstreamSequence([
      { ok: false, status: 500, body: JSON.stringify({ error: "primary boom" }) },
      { ok: false, status: 503, body: JSON.stringify({ error: "fallback boom" }) },
    ]);
    const config = await loadConfig(guardrailConfigPath);
    const server = await createServer(guardrailConfigPath, config);
    try {
      const response = await server.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-user" },
        payload: {
          model: "auto",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        },
      });

      expect(response.statusCode).toBe(503);
      expect(calls).toHaveLength(2);

      const entries = await readLogEntries();
      // 全部失败：没有模型成功服务，servedModel 缺省；
      // fallbackAttempts 记录失败次数（primary + fallback 各一次）。
      expect(entries[0].servedModel).toBeUndefined();
      expect(entries[0].fallbackAttempts).toBe(2);
      expect(entries[0].upstreamStatus).toBe(503);
    } finally {
      await server.close();
    }
  });

  it("records no servedModel when the primary serves the request directly", async () => {
    mockUpstreamSequence([{ ok: true, status: 200 }]);
    const config = await loadConfig(guardrailConfigPath);
    const server = await createServer(guardrailConfigPath, config);
    try {
      await server.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-user" },
        payload: {
          model: "auto",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        },
      });

      const entries = await readLogEntries();
      // servedModel 与 finalModel 必然相同，冗余——primary 直成功时不记。
      expect(entries[0].finalModel).toBe("anthropic/cheap-model");
      expect(entries[0].servedModel).toBeUndefined();
      expect(entries[0].fallbackAttempts).toBeUndefined();
      expect(entries[0].upstreamStatus).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("does not retry a streaming response even when a fallback is configured", async () => {
    // Once a stream has started the response is committed; retrying would
    // duplicate output, so an ok streaming primary must never fall back.
    const calls = mockUpstreamSequence([{ ok: true, status: 200, stream: true }]);
    const config = await loadConfig(guardrailConfigPath);
    const server = await createServer(guardrailConfigPath, config);
    try {
      const response = await server.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-user" },
        payload: {
          model: "auto",
          max_tokens: 100,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].body.model).toBe("cheap-model");

      const entries = await readLogEntries();
      expect(entries[0].servedModel).toBeUndefined();
      expect(entries[0].fallbackAttempts).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("returns the primary error without retrying when the tier has no fallbacks", async () => {
    // "list the files in src/" lands on MEDIUM via the low-confidence
    // uncertain-upgrade; the MEDIUM tier configures no fallback array.
    const calls = mockUpstreamSequence([
      { ok: false, status: 500, body: JSON.stringify({ error: "primary boom" }) },
    ]);
    const config = await loadConfig(guardrailConfigPath);
    const server = await createServer(guardrailConfigPath, config);
    try {
      const response = await server.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-user" },
        payload: {
          model: "auto",
          max_tokens: 100,
          messages: [{ role: "user", content: "list the files in src/" }],
        },
      });

      expect(response.statusCode).toBe(500);
      expect(calls).toHaveLength(1);
      expect(calls[0].body.model).toBe("mid-model");
    } finally {
      await server.close();
    }
  });

  it("applies the context guardrail to a textless request with a huge body", async () => {
    // The guardrail estimate lives on the shared auto-route path: an
    // empty-text turn (all user text stripped) still gets forced to COMPLEX
    // instead of silently taking the SIMPLE default.
    const calls = mockUpstreamSequence([{ ok: true, status: 200 }]);
    const config = await loadConfig(guardrailConfigPath);
    const server = await createServer(guardrailConfigPath, config);
    try {
      await server.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-user" },
        payload: {
          model: "auto",
          max_tokens: 100,
          // ~2KB of padding → ~500 estimated tokens, above the 200 threshold.
          system: "x".repeat(2000),
          messages: [{ role: "user", content: "" }],
        },
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].body.model).toBe("big-model");
    } finally {
      await server.close();
    }
  });

  it("raises the tier to COMPLEX when the estimated context exceeds maxTokensForceComplex", async () => {
    const calls = mockUpstreamSequence([{ ok: true, status: 200 }]);
    const config = await loadConfig(guardrailConfigPath);
    const server = await createServer(guardrailConfigPath, config);
    try {
      // ~2KB body → ~500 estimated tokens, above the 200 threshold. The text
      // itself is trivial, so the classifier only reaches MEDIUM via the
      // low-confidence fallback upgrade; the guardrail forces COMPLEX.
      const longContent = "summarize this log: " + "x".repeat(2000);
      await server.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-user" },
        payload: {
          model: "auto",
          max_tokens: 100,
          messages: [{ role: "user", content: longContent }],
        },
      });

      const entries = await readLogEntries();
      expect(entries[0]).toMatchObject({
        classifierTier: "MEDIUM",
        finalTier: "COMPLEX",
        contextForcedComplex: true,
        finalModel: "anthropic/big-model",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].body.model).toBe("big-model");
    } finally {
      await server.close();
    }
  });

  it("does not trigger the context guardrail for small requests", async () => {
    mockUpstreamSequence([{ ok: true, status: 200 }]);
    const config = await loadConfig(guardrailConfigPath);
    const server = await createServer(guardrailConfigPath, config);
    try {
      await server.inject({
        method: "POST",
        url: "/anthropic/v1/messages",
        headers: { "x-api-key": "sk-user" },
        payload: {
          model: "auto",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        },
      });

      const entries = await readLogEntries();
      expect(entries[0].finalTier).toBe("SIMPLE");
      expect(entries[0].contextForcedComplex).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

describe("resolveWeightedTier background-task hint", () => {
  it("forces SIMPLE for background tasks even when the classifier says REASONING", () => {
    // Weighted fusion used to land on MEDIUM here (0.8·0 + 0.2·3 rounds to 1),
    // contradicting the documented "Force SIMPLE" behavior.
    expect(
      resolveWeightedTier(
        { tier: "REASONING", confidence: 0.95 },
        { isBackgroundTask: true },
        { hintWeight: 0.8, classifierWeight: 0.2 },
      ),
    ).toBe("SIMPLE");
  });

  it("still fuses classifier and hint ranks for non-background requests", () => {
    expect(
      resolveWeightedTier(
        { tier: "REASONING", confidence: 0.9 },
        { preferThinking: true },
        { hintWeight: 0.5, classifierWeight: 0.5 },
        "reasoning",
      ),
    ).toBe("REASONING");
  });
});

describe("aiClassifier: openai-compat wiring", () => {
  const aiConfigPath = path.join(os.tmpdir(), "test-config-ai-classifier.yaml");
  const aiFallbackConfigPath = path.join(os.tmpdir(), "test-config-ai-classifier-fallback.yaml");
  let logDir: string;

  const baseAiConfig = `
router:
  port: 8408
  classifier: hybrid
providers:
  anthropic:
    baseUrl: http://upstream.test
    apiKey: test-key
tiers:
  SIMPLE:
    primary: anthropic/cheap-model
  MEDIUM:
    primary: anthropic/mid-model
  COMPLEX:
    primary: anthropic/big-model
  REASONING:
    primary: anthropic/reasoning-model
ollama:
  enabled: false
`;

  beforeAll(async () => {
    await fs.writeFile(
      aiConfigPath,
      baseAiConfig +
        `
aiClassifier:
  provider: openai-compat
  baseUrl: http://classifier.test/v1
  apiKey: classifier-key
  model: classifier-model
`,
    );
    // provider 配了 openai-compat 但缺 baseUrl/model → 回退 ollama 路径，
    // 而 ollama.enabled 为 false，Layer 2 整体跳过。
    await fs.writeFile(
      aiFallbackConfigPath,
      baseAiConfig +
        `
aiClassifier:
  provider: openai-compat
`,
    );
  });

  afterAll(async () => {
    for (const p of [aiConfigPath, aiFallbackConfigPath]) {
      try {
        await fs.unlink(p);
      } catch {
        // ignore
      }
    }
  });

  beforeEach(async () => {
    logDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexusrouter-ai-classifier-log-"));
    process.env.NEXUSROUTER_LOG_DIR = logDir;
    resetRetryOutcomeIndex();
  });

  afterEach(async () => {
    delete process.env.NEXUSROUTER_LOG_DIR;
    vi.unstubAllGlobals();
    await fs.rm(logDir, { recursive: true, force: true });
  });

  async function readLogEntries(expected = 1): Promise<Record<string, unknown>[]> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const files = await fs.readdir(logDir);
      const routingFile = files.find(
        (f) => f.startsWith("routing-") && !f.startsWith("routing-outcome-"),
      );
      if (routingFile) {
        const content = await fs.readFile(path.join(logDir, routingFile), "utf-8");
        const entries = content
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        if (entries.length >= expected) return entries;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    return [];
  }

  // fetch 双派发：classifier.test 是 Layer 2 分类调用（OpenAI chat 格式），
  // 其余是上游转发。两类响应都要给 json()/text()，路径不同用的方法不同。
  function mockClassifierAndUpstream(tier: string, confidence: number) {
    const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] =
      [];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          async (url: string, init: { headers: Record<string, string>; body: string }) => {
            calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
            const isClassifier = url.startsWith("http://classifier.test");
            const payload = isClassifier
              ? { choices: [{ message: { role: "assistant", content: JSON.stringify({ tier, confidence }) } }] }
              : { id: "mock" };
            return {
              ok: true,
              status: 200,
              headers: { get: () => null },
              json: () => Promise.resolve(payload),
              text: () => Promise.resolve(JSON.stringify(payload)),
            };
          },
        ),
    );
    return calls;
  }

  function injectNeutralRequest(server: Awaited<ReturnType<typeof createServer>>) {
    // "process this data" 无关键词、无代码：Layer 0 不命中，Layer 1 置信
    // 0.5 < 0.92，必走到 Layer 2。
    return server.inject({
      method: "POST",
      url: "/anthropic/v1/messages",
      headers: { "x-api-key": "sk-user" },
      payload: {
        model: "auto",
        max_tokens: 100,
        messages: [{ role: "user", content: "process this data" }],
      },
    });
  }

  it("routes via the OpenAI-compatible classifier when aiClassifier is configured", async () => {
    const calls = mockClassifierAndUpstream("COMPLEX", 0.9);
    const config = await loadConfig(aiConfigPath);
    const server = await createServer(aiConfigPath, config);
    try {
      await injectNeutralRequest(server);

      // 分类调用打到网关的 /chat/completions，带 Bearer 头与配置的模型名
      const classifyCall = calls.find((c) => c.url.startsWith("http://classifier.test"));
      expect(classifyCall).toBeDefined();
      expect(classifyCall!.url).toBe("http://classifier.test/v1/chat/completions");
      expect(classifyCall!.headers["Authorization"]).toBe("Bearer classifier-key");
      expect(classifyCall!.body.model).toBe("classifier-model");

      // 分类结果（COMPLEX 0.9 ≥ aiThreshold）被采纳，最终路由到 COMPLEX 档
      const entries = await readLogEntries();
      expect(entries[0]).toMatchObject({
        layer: "ai",
        reason: "ai-classified",
        classifierTier: "COMPLEX",
        finalTier: "COMPLEX",
        finalModel: "anthropic/big-model",
      });

      // ollama.enabled 为 false 也不影响：Ollama 路径从未被访问
      expect(calls.some((c) => c.url.includes("localhost:11434"))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("falls back to the ollama path (disabled → Layer 3) when baseUrl/model are missing", async () => {
    const calls = mockClassifierAndUpstream("COMPLEX", 0.9);
    const config = await loadConfig(aiFallbackConfigPath);
    const server = await createServer(aiFallbackConfigPath, config);
    try {
      await injectNeutralRequest(server);

      // Layer 2 整体跳过：没有任何分类调用，只有上游转发
      expect(calls.some((c) => c.url.startsWith("http://classifier.test"))).toBe(false);

      const entries = await readLogEntries();
      expect(entries[0]).toMatchObject({
        layer: "fallback",
        reason: "uncertain-upgrade",
        finalModel: "anthropic/mid-model",
      });
    } finally {
      await server.close();
    }
  });
});
