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
});

export const TierConfigSchema = z.object({
  primary: z.string(),
  fallback: z.array(z.string()).default([]),
});

export const OllamaModelsSchema = z.object({
  fast: z.string().default("qwen2.5:3b"),
  accurate: z.string().default("qwen2.5:14b"),
});

export const OllamaConfigSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().default("http://localhost:11434"),
  models: OllamaModelsSchema.default({}),
  timeout: z.number().default(30000),
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
  /** Whole section missing ≡ enabled: false. */
  accounting: AccountingConfigSchema.default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type TierConfig = z.infer<typeof TierConfigSchema>;
export type OllamaConfig = z.infer<typeof OllamaConfigSchema>;
export type RouterConfig = z.infer<typeof RouterConfigSchema>;
export type HintsConfig = z.infer<typeof HintsConfigSchema>;
export type AccountingConfig = z.infer<typeof AccountingConfigSchema>;
export type PriceOverride = z.infer<typeof PriceOverrideSchema>;
export type PriceOverrides = z.infer<typeof PriceOverridesSchema>;
