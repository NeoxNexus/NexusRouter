import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadConfig } from "../config/loader.js";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// Controllable homedir() so the default-path branch can target a temp dir
// without touching the real home. Falls back to the real homedir otherwise.
const { mockHomedir } = vi.hoisted(() => ({
  mockHomedir: vi.fn<() => string | undefined>(),
}));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    default: actual,
    homedir: () => mockHomedir() ?? actual.homedir(),
  };
});

describe("Config Loader", () => {
  const testConfigPath = path.join(os.tmpdir(), "test-config.yaml");
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(async () => {
    try {
      await fs.unlink(testConfigPath);
    } catch {
      // ignore
    }
    process.env = originalEnv;
  });

  it("should load config from yaml file", async () => {
    const configContent = `
router:
  port: 8402
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
    apiKey: test-key
    maxRetries: 3
tiers:
  SIMPLE:
    primary: openai/gpt-4o-mini
    fallback: []
  MEDIUM:
    primary: openai/gpt-4o
    fallback: []
  COMPLEX:
    primary: anthropic/claude-sonnet-4.6
    fallback: []
  REASONING:
    primary: openai/o3-mini
    fallback: []
ollama:
  enabled: false
  baseUrl: http://localhost:11434
  models:
    fast: qwen2.5:3b
    accurate: qwen2.5:14b
  timeout: 30000
`;
    await fs.writeFile(testConfigPath, configContent);

    const config = await loadConfig(testConfigPath);

    expect(config.router.port).toBe(8402);
    expect(config.router.classifier).toBe("hybrid");
    expect(config.providers.openai.apiKey).toBe("test-key");
  });

  it("should apply environment variable overrides", async () => {
    process.env.OPENAI_API_KEY = "env-key";
    process.env.ANTHROPIC_API_KEY = "anthropic-key";

    const configContent = `
router:
  port: 8402
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
    apiKey: \${OPENAI_API_KEY}
  anthropic:
    apiKey: \${ANTHROPIC_API_KEY}
tiers:
  SIMPLE:
    primary: openai/gpt-4o-mini
    fallback: []
  MEDIUM:
    primary: openai/gpt-4o
    fallback: []
  COMPLEX:
    primary: anthropic/claude-sonnet-4.6
    fallback: []
  REASONING:
    primary: openai/o3-mini
    fallback: []
ollama:
  enabled: false
`;
    await fs.writeFile(testConfigPath, configContent);

    const config = await loadConfig(testConfigPath);

    expect(config.providers.openai.apiKey).toBe("env-key");
    expect(config.providers.anthropic.apiKey).toBe("anthropic-key");
  });

  it("should fail validation for invalid config", async () => {
    const invalidConfig = `
router:
  port: "not-a-number"
providers: {}
tiers: {}
`;
    await fs.writeFile(testConfigPath, invalidConfig);

    await expect(loadConfig(testConfigPath)).rejects.toThrow();
  });

  it("should support ${VAR} standard format", async () => {
    process.env.OPENAI_API_KEY = "standard-format-key";

    const configContent = `
router:
  port: 8402
providers:
  openai:
    apiKey: \${OPENAI_API_KEY}
tiers:
  SIMPLE:
    primary: openai/gpt-4o-mini
  MEDIUM:
    primary: openai/gpt-4o
  COMPLEX:
    primary: openai/gpt-4o
  REASONING:
    primary: openai/o3-mini
`;
    await fs.writeFile(testConfigPath, configContent);

    const config = await loadConfig(testConfigPath);
    expect(config.providers.openai.apiKey).toBe("standard-format-key");
  });

  it("should support $VAR simple format", async () => {
    process.env.ANTHROPIC_API_KEY = "simple-format-key";

    const configContent = `
router:
  port: 8402
providers:
  anthropic:
    apiKey: $ANTHROPIC_API_KEY
tiers:
  SIMPLE:
    primary: openai/gpt-4o-mini
  MEDIUM:
    primary: openai/gpt-4o
  COMPLEX:
    primary: openai/gpt-4o
  REASONING:
    primary: openai/o3-mini
`;
    await fs.writeFile(testConfigPath, configContent);

    const config = await loadConfig(testConfigPath);
    expect(config.providers.anthropic.apiKey).toBe("simple-format-key");
  });

  it("should support ${VAR:-default} format with default value", async () => {
    // This var is not set, should use default
    delete process.env.MISSING_API_KEY;

    const configContent = `
router:
  port: 8402
providers:
  test:
    apiKey: \${MISSING_API_KEY:-default-key}
tiers:
  SIMPLE:
    primary: openai/gpt-4o-mini
  MEDIUM:
    primary: openai/gpt-4o
  COMPLEX:
    primary: openai/gpt-4o
  REASONING:
    primary: openai/o3-mini
`;
    await fs.writeFile(testConfigPath, configContent);

    const config = await loadConfig(testConfigPath);
    expect(config.providers.test.apiKey).toBe("default-key");
  });

  it("should use env value over default when set", async () => {
    process.env.MISSING_API_KEY = "env-value";

    const configContent = `
router:
  port: 8402
providers:
  test:
    apiKey: \${MISSING_API_KEY:-default-key}
tiers:
  SIMPLE:
    primary: openai/gpt-4o-mini
  MEDIUM:
    primary: openai/gpt-4o
  COMPLEX:
    primary: openai/gpt-4o
  REASONING:
    primary: openai/o3-mini
`;
    await fs.writeFile(testConfigPath, configContent);

    const config = await loadConfig(testConfigPath);
    expect(config.providers.test.apiKey).toBe("env-value");
  });

  it("should use default values for optional fields", async () => {
    const minimalConfig = `
router:
  port: 8402
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
`;
    await fs.writeFile(testConfigPath, minimalConfig);

    const config = await loadConfig(testConfigPath);

    expect(config.router.classifier).toBe("hybrid"); // default
    expect(config.router.layers.rules.enabled).toBe(true);
    expect(config.ollama.enabled).toBe(false);
    expect(config.ollama.timeout).toBe(30000);
  });

  it("should default router.hosts to loopback dual-stack", async () => {
    const minimalConfig = `
router:
  port: 8402
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
`;
    await fs.writeFile(testConfigPath, minimalConfig);

    const config = await loadConfig(testConfigPath);
    // Secure default: only reachable from the local host, over both IP families.
    expect(config.router.hosts).toEqual(["127.0.0.1", "::1"]);
  });

  it("should accept explicit router.hosts (e.g. LAN exposure opt-in)", async () => {
    const configContent = `
router:
  port: 8402
  hosts: ["0.0.0.0"]
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
`;
    await fs.writeFile(testConfigPath, configContent);

    const config = await loadConfig(testConfigPath);
    expect(config.router.hosts).toEqual(["0.0.0.0"]);
  });

  it("loads from the home-dir default path when no path is given", async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-home-"));
    mockHomedir.mockReturnValue(fakeHome);
    process.env.OPENAI_API_KEY = "home-key";

    const configDir = path.join(fakeHome, ".nexus-router");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "config.yaml"),
      `
router:
  port: 8500
providers:
  openai:
    apiKey: \${OPENAI_API_KEY}
tiers:
  SIMPLE:
    primary: openai/gpt-4o-mini
  MEDIUM:
    primary: openai/gpt-4o
  COMPLEX:
    primary: openai/gpt-4o
  REASONING:
    primary: openai/o3-mini
`,
    );

    try {
      const config = await loadConfig();
      expect(config.router.port).toBe(8500);
      expect(config.providers.openai?.apiKey).toBe("home-key");
    } finally {
      mockHomedir.mockReset();
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });
});
