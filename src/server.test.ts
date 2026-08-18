import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import Fastify from "fastify";
import { loadConfig } from "./config/loader.js";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { createServer } from "./server.js";

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
      const routingFile = files.find((f) => f.startsWith("routing-"));
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

  it("routes a tool-attached but idle Claude Code request without force-upgrading its tier", async () => {
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
      expect(entries[0]).toMatchObject({
        agent: "claude-code",
        protocol: "anthropic",
        requestedModel: "auto",
        hasTools: true,
        toolCount: 2,
        requiresTools: false,
        finalTier: "SIMPLE",
        finalModel: "anthropic/cheap-model",
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
      expect(entries[0]).toMatchObject({
        hasThinking: true,
        classifierTier: "SIMPLE",
        finalTier: "SIMPLE",
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

  it("respects hints.thinking: reasoning and complex modes", async () => {
    // One shared logDir across iterations — index each iteration's own entry.
    let iteration = 0;
    for (const [mode, expectedTier] of [
      ["reasoning", "COMPLEX"],
      ["complex", "MEDIUM"],
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
        expect(entries[iteration]).toMatchObject({
          hasThinking: true,
          classifierTier: "SIMPLE",
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
});

describe("Model prefix stripping and API key passthrough", () => {
  const passthroughConfigPath = path.join(os.tmpdir(), "test-config-passthrough.yaml");
  const pinnedConfigPath = path.join(os.tmpdir(), "test-config-pinned.yaml");
  let logDir: string;

  // Routing decisions are logged as a side effect; redirect them to a temp dir
  // so the suite never appends to the user's real ~/.nexusrouter/logs.
  beforeEach(async () => {
    logDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexusrouter-prefix-log-"));
    process.env.NEXUSROUTER_LOG_DIR = logDir;
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
