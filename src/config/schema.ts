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
  classifier: z.enum(["heuristic", "hybrid"]).default("hybrid"),
  layers: LayersConfigSchema.default({}),
  timeout: z.number().default(1000),
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

export const ConfigSchema = z.object({
  router: RouterConfigSchema.default({}),
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  tiers: z
    .record(z.enum(["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]), TierConfigSchema)
    .default({}),
  hints: HintsConfigSchema.default({}),
  ollama: OllamaConfigSchema.default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type TierConfig = z.infer<typeof TierConfigSchema>;
export type OllamaConfig = z.infer<typeof OllamaConfigSchema>;
export type RouterConfig = z.infer<typeof RouterConfigSchema>;
export type HintsConfig = z.infer<typeof HintsConfigSchema>;
