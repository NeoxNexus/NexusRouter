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
  # 是否开启内置 Web Dashboard（/dashboard）。默认 true，开箱即用；
  # 需要关闭时显式设为 false。
  dashboard: true
  layers:
    rules:
      enabled: true
    heuristic:
      confidenceThreshold: 0.92
    ai:
      fallbackConfidence: 0.75

providers:
  openai:
    # 默认启用客户端 API Key 透传（passthroughApiKey: true）。
    # 客户端（Claude Code / Codex / OpenAI SDK 等）需在请求头中自带
    # Authorization: Bearer <key>，NexusRouter 会原样转发给上游。
    # 如需改为服务端固定 key，请关闭 passthroughApiKey 并填写 apiKey。
    apiKey: \${OPENAI_API_KEY:-}
    passthroughApiKey: true
    maxRetries: 3
  anthropic:
    apiKey: \${ANTHROPIC_API_KEY:-}
    passthroughApiKey: true
    maxRetries: 3
  google:
    apiKey: \${GOOGLE_API_KEY:-}
    passthroughApiKey: true
    maxRetries: 3

# 四档模型映射。fallback 已接线：primary 返回非 2xx 且尚未开始流式输出时
# 按序降级，全部失败时客户端收到最后一次错误。注意：fallback 复用请求协议
# 转发（Anthropic 协议的请求降级时仍以 Anthropic 格式发出），因此 fallback
# 必须与请求协议同构，或指向会做协议转换的网关；跨协议直连（如 Claude Code
# 流量降级到 google/* 的官方端点）必然失败，配置前请确认。
# 下方模型 ID 必须与 src/models.js 价格注册表保持一致，否则成本/基线会算不出。
tiers:
  SIMPLE:
    primary: openai/gpt-4o-mini
    fallback: [google/gemini-2.5-flash-lite]
  MEDIUM:
    primary: openai/gpt-4o
    fallback: [google/gemini-2.5-flash]
  COMPLEX:
    primary: anthropic/claude-sonnet-4.6
    fallback: [anthropic/claude-opus-4.6]
  REASONING:
    primary: openai/o3-mini
    fallback: [openai/o3]

# Ollama 本地小模型分类层（Layer 2）。enabled 是该层总开关：false 时分类器
# 整块跳过 Layer 2，不会向 baseUrl 发任何请求，低置信流量直接落启发式兜底。
# 启用前先 ollama pull 对应模型；pull 不等于加载进内存，建议再执行
# ollama run qwen3:4b "" 预热，否则冷启动/闲置卸载后的首个请求会因 800ms
# 超时降级（属预期，可按需调大 timeout）。分类在请求关键路径上，
# timeout（毫秒）到点即降级兜底，宁短勿长。
ollama:
  enabled: false
  baseUrl: http://localhost:11434
  models:
    fast: qwen3:4b
    accurate: qwen3:8b
  timeout: 800

# 省钱记账：默认开启，写 usage 日志到 ~/.nexus-router/logs/，
# 并基于 same-usage-repricing 估算反事实基线成本。
# referenceModel 用于客户端发送 auto/free/eco/premium 等占位符时的基线定价。
accounting:
  enabled: true
  persist: true
  baseline: requested
  referenceModel: anthropic/claude-opus-4.6
  captureNonStreaming: true
  captureStreaming: true
  hotReload: true
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
