import { z } from "zod";

export const ProviderConfigSchema = z.object({
  apiKey: z.string().default(""),
  baseUrl: z.string().optional(),
  maxRetries: z.number().default(3),
  /**
   * When true, the client's own API key (Authorization: Bearer / x-api-key)
   * is forwarded upstream instead of the configured apiKey. Intended for
   * deployments in front of a trusted gateway (e.g. new-api) where every
   * user brings their own token. The upstream baseUrl stays pinned by
   * server-side config, so client keys can only reach that gateway.
   */
  passthroughApiKey: z.boolean().default(false),
  /**
   * When true, automatically inject `stream_options: { include_usage: true }`
   * into OpenAI-protocol streaming requests so the upstream returns token usage
   * in the SSE stream. Does not modify non-streaming requests or Anthropic
   * requests. Safe opt-in: defaults to false for backward compatibility.
   */
  injectStreamUsage: z.boolean().default(false),
});

export const TierConfigSchema = z.object({
  primary: z.string(),
  fallback: z.array(z.string()).default([]),
});

export const OllamaModelsSchema = z.object({
  fast: z.string().default("qwen3:4b"),
  accurate: z.string().default("qwen3:8b"),
});

export const OllamaConfigSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().default("http://localhost:11434"),
  models: OllamaModelsSchema.default({}),
  // 分类在请求关键路径上：超时即降级到启发式兜底，默认压到 800ms，宁短勿长。
  timeout: z.number().default(800),
});

/**
 * Layer 2 大模型分类层的后端选择。与 router.classifier（"heuristic"/"hybrid"
 * 分层策略）是两回事：这里选的是 hybrid 模式下 Layer 2 实际调用的模型服务。
 * provider: "openai-compat" 时本段即视为启用（不看 ollama.enabled，它只管
 * ollama 路径），baseUrl 需含 /v1（new-api 网关 / vLLM 私有部署）；
 * baseUrl/model 缺失则启动时告警并回退 ollama 路径。
 */
export const AiClassifierConfigSchema = z.object({
  provider: z.enum(["ollama", "openai-compat"]).default("ollama"),
  baseUrl: z.string().optional(),
  // 空串 = 不带 Authorization 头，兼容无鉴权的内网网关。
  apiKey: z.string().default(""),
  model: z.string().optional(),
  timeout: z.number().default(800),
});

export const LayersRulesSchema = z.object({
  enabled: z.boolean().default(true),
});

export const LayersHeuristicSchema = z.object({
  confidenceThreshold: z.number().default(0.92),
});

export const LayersAiSchema = z.object({
  fallbackConfidence: z.number().default(0.75),
});

export const LayersConfigSchema = z.object({
  rules: LayersRulesSchema.default({}),
  heuristic: LayersHeuristicSchema.default({}),
  ai: LayersAiSchema.default({}),
});

export const RouterConfigSchema = z.object({
  port: z.number().default(8402),
  /**
   * Addresses to listen on. Defaults to loopback only (both IP families), so
   * the router is unreachable from other machines on the LAN and its
   * configured API keys can't be spent by anyone else. To expose it, set this
   * explicitly (e.g. ["0.0.0.0"]) and add your own auth/firewall.
   */
  hosts: z.array(z.string()).default(["127.0.0.1", "::1"]),
  classifier: z.enum(["heuristic", "hybrid"]).default("hybrid"),
  layers: LayersConfigSchema.default({}),
  timeout: z.number().default(1000),
  /**
   * 上下文 token 护栏：估算的总上下文 token（rawBody 字符数 / 4）超过此值时，
   * 无论分类器给什么档，都至少抬到 COMPLEX —— 超长上下文让小模型处理必劣化。
   */
  maxTokensForceComplex: z.number().default(100_000),
  /** Enable the built-in web dashboard at /dashboard (default true). */
  dashboard: z.boolean().default(true),
});

/**
 * How agent hints influence the routing tier.
 *
 * Claude Code attaches `thinking` to every request whenever an effort level
 * is set globally (e.g. CLAUDE_CODE_EFFORT_LEVEL=max), so it carries no
 * per-request signal under that configuration. The switch lets deployments
 * choose how much tier pull the hint is allowed.
 */
export const HintsConfigSchema = z.object({
  /** off: ignore the thinking flag; complex: at least COMPLEX; reasoning: at least REASONING (legacy). */
  thinking: z.enum(["off", "complex", "reasoning"]).default("off"),
});

export const PriceOverrideSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number().optional(),
  cacheWrite5m: z.number().optional(),
  cacheWrite1h: z.number().optional(),
});

export const PriceOverridesSchema = z.record(z.string(), PriceOverrideSchema).default({});

export const AccountingConfigSchema = z.object({
  /** First version ships as experimental, default off (向后兼容红线).
   *  The first-launch template in default-config.ts explicitly turns it on. */
  enabled: z.boolean().default(false),
  /** +0.1 µs — almost no reason to turn off. */
  captureNonStreaming: z.boolean().default(true),
  /** +22 µs — the first switch to flip if streaming path regresses. */
  captureStreaming: z.boolean().default(true),
  /** Persist to disk; when false, only response headers / in-memory stats remain. */
  persist: z.boolean().default(true),
  /** fs.watch(config.yaml) with 200 ms debounce, only accounting.* subtree. */
  hotReload: z.boolean().default(true),
  /** Queue ceiling; oldest lines dropped past it. */
  maxQueueLines: z.number().default(10_000),
  /** Consecutive overflows before persistence degrades one-way. */
  degradeAfterOverflows: z.number().default(3),
  /** Counterfactual baseline strategy. */
  baseline: z.enum(["requested", "reference", "off"]).default("requested"),
  /** Baseline model when baseline is "reference". */
  referenceModel: z.string().optional(),
  /** Deployment price overrides for gateway models not in the product registry. */
  priceOverrides: PriceOverridesSchema.default({}),
  /** Whether to redact prompt content in persisted logs. */
  redactPrompts: z.boolean().default(false),
  /** Streaming usage-sniffer tail window size in bytes. */
  tailWindowBytes: z.number().default(4096),
  /**
   * When true and the upstream does not report token usage (or reports an empty
   * usage block), fall back to estimating tokens from request/response text
   * length so the dashboard never shows all-zero usage for gateway models that
   * omit usage events. Existing upstream-reported usage is always preserved.
   */
  estimateMissingTokens: z.boolean().default(false),
  /** Batch-flush line threshold. */
  flushLines: z.number().default(64),
  /** Batch-flush timeout in ms. */
  flushIntervalMs: z.number().default(200),
});

export const ConfigSchema = z.object({
  router: RouterConfigSchema.default({}),
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  tiers: z
    .record(z.enum(["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]), TierConfigSchema)
    .default({}),
  hints: HintsConfigSchema.default({}),
  ollama: OllamaConfigSchema.default({}),
  aiClassifier: AiClassifierConfigSchema.default({}),
  /** Whole section missing ≡ enabled: false. */
  accounting: AccountingConfigSchema.default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type TierConfig = z.infer<typeof TierConfigSchema>;
export type OllamaConfig = z.infer<typeof OllamaConfigSchema>;
export type AiClassifierConfig = z.infer<typeof AiClassifierConfigSchema>;
export type RouterConfig = z.infer<typeof RouterConfigSchema>;
export type HintsConfig = z.infer<typeof HintsConfigSchema>;
export type AccountingConfig = z.infer<typeof AccountingConfigSchema>;
export type PriceOverride = z.infer<typeof PriceOverrideSchema>;
export type PriceOverrides = z.infer<typeof PriceOverridesSchema>;
