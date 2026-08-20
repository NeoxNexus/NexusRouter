/**
 * Default configuration template & path resolution.
 *
 * The default config lives under the user's home directory at
 * `~/.nexus-router/config.yaml` (cross-platform via node:os homedir()).
 * On first launch the CLI creates it from the embedded template below.
 *
 * The template is embedded as a string (not read from disk) because
 * `config.yaml` is not shipped in the npm package and tsup bundles the
 * CLI into a flat `dist/`, so there is no reliable file to copy at runtime.
 * `default-config.test.ts` guards it by parsing it through the real
 * `ConfigSchema` and checking top-level section parity with the repo config —
 * deliberately *not* byte-identity, because the repo-root `config.yaml` is a
 * live deployment config (specific gateway, credential passthrough on) that
 * must never become a new user's default.
 */

import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Generic first-launch template. Intentionally not the repo-root `config.yaml`. */
export const DEFAULT_CONFIG_YAML = `router:
  port: 8402
  classifier: hybrid
  # 监听地址。默认只绑回环双栈（IPv4 + IPv6），同网段其他机器无法访问，
  # 避免 config 里的 API 额度被别人白嫖。localhost 解析成 ::1 时也能连。
  # 如需暴露到局域网，显式改为 hosts: ["0.0.0.0"]（务必自行加鉴权/防火墙）。
  hosts: ["127.0.0.1", "::1"]
  # 上游请求超时（毫秒）。schema 默认 1000ms 对真实 LLM 调用必超时，生产必须显式设置
  timeout: 300000
  # 是否开启内置 Web Dashboard（/dashboard）。默认 false，opt-in。
  dashboard: false
  layers:
    rules:
      enabled: true
    heuristic:
      confidenceThreshold: 0.92
    ai:
      fallbackConfidence: 0.75

providers:
  openai:
    # 留空则要求客户端自带 key（Authorization: Bearer <key>）。
    # 若对接 new-api 等网关，可设 baseUrl 并开启 passthroughApiKey: true。
    apiKey: \${OPENAI_API_KEY:-}
    maxRetries: 3
  anthropic:
    apiKey: \${ANTHROPIC_API_KEY:-}
    maxRetries: 3
  google:
    apiKey: \${GOOGLE_API_KEY:-}
    maxRetries: 3

tiers:
  SIMPLE:
    primary: openai/gpt-4o-mini
    fallback: [google/gemini-2.5-flash-lite-preview-06-05]
  MEDIUM:
    primary: openai/gpt-4o
    fallback: [google/gemini-2.5-flash-preview-05-20]
  COMPLEX:
    primary: anthropic/claude-sonnet-4-20250514
    fallback: [google/gemini-2.5-pro-preview-05-20]
  REASONING:
    primary: openai/o3-mini
    fallback: [anthropic/claude-haiku-3-5-20250620]

# Ollama 本地小模型分类层。服务器上没装 Ollama 时必须保持 false，
# 否则每个请求都要等连接失败降级，白白增加延迟
ollama:
  enabled: false
  baseUrl: http://localhost:11434
  models:
    fast: qwen3.5:2b
    accurate: qwen3.5:4b
  timeout: 30000
`;

/**
 * Resolve the default config path in the user's home directory.
 * Cross-platform: homedir() resolves %USERPROFILE% on Windows and $HOME
 * on Linux/macOS, and join() applies the correct path separator.
 */
export function getDefaultConfigPath(): string {
  return join(homedir(), ".nexus-router", "config.yaml");
}

/**
 * Ensure a config file exists at `path`, creating it (and its parent
 * directory) from the embedded template on first launch. Never overwrites
 * an existing file, so a user's filled-in API keys are preserved.
 */
export async function ensureConfigExists(
  path: string,
): Promise<{ path: string; created: boolean }> {
  try {
    await access(path);
    return { path, created: false };
  } catch {
    // File does not exist (or is unreadable) — create from template.
  }

  await mkdir(dirname(path), { recursive: true });
  // `wx` fails if the file appeared meanwhile, avoiding a TOCTOU overwrite.
  try {
    await writeFile(path, DEFAULT_CONFIG_YAML, { flag: "wx" });
    return { path, created: true };
  } catch {
    return { path, created: false };
  }
}
