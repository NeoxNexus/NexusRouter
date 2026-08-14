/**
 * NexusRouter Model Definitions
 *
 * Maps 41+ AI models to OpenClaw's ModelDefinitionConfig format.
 * All models use the "openai-completions" API (OpenAI-compatible).
 *
 * Pricing is in USD per 1M tokens for cost estimation and savings calculation.
 */

import type { ModelDefinitionConfig, ModelProviderConfig } from "./types.js";

/**
 * Model aliases for convenient shorthand access.
 * Users can type `/model claude` instead of `/model anthropic/claude-sonnet-4.6`.
 */
export const MODEL_ALIASES: Record<string, string> = {
  // Claude - use newest versions (4.6)
  claude: "anthropic/claude-sonnet-4.6",
  sonnet: "anthropic/claude-sonnet-4.6",
  "sonnet-4": "anthropic/claude-sonnet-4.6",
  "sonnet-4.6": "anthropic/claude-sonnet-4.6",
  "sonnet-4-6": "anthropic/claude-sonnet-4.6",
  opus: "anthropic/claude-opus-4.6",
  "opus-4": "anthropic/claude-opus-4.6",
  "opus-4.6": "anthropic/claude-opus-4.6",
  "opus-4-6": "anthropic/claude-opus-4.6",
  haiku: "anthropic/claude-haiku-4.5",
  // Claude - provider/shortname patterns (common in agent frameworks)
  "anthropic/sonnet": "anthropic/claude-sonnet-4.6",
  "anthropic/opus": "anthropic/claude-opus-4.6",
  "anthropic/haiku": "anthropic/claude-haiku-4.5",
  "anthropic/claude": "anthropic/claude-sonnet-4.6",
  // Backward compatibility - map all variants to 4.6
  "anthropic/claude-sonnet-4": "anthropic/claude-sonnet-4.6",
  "anthropic/claude-sonnet-4-6": "anthropic/claude-sonnet-4.6",
  "anthropic/claude-opus-4": "anthropic/claude-opus-4.6",
  "anthropic/claude-opus-4-6": "anthropic/claude-opus-4.6",
  "anthropic/claude-opus-4.5": "anthropic/claude-opus-4.6",
  "anthropic/claude-haiku-4": "anthropic/claude-haiku-4.5",
  "anthropic/claude-haiku-4-5": "anthropic/claude-haiku-4.5",

  // OpenAI
  gpt: "openai/gpt-4o",
  gpt4: "openai/gpt-4o",
  gpt5: "openai/gpt-5.4",
  "gpt-5.4": "openai/gpt-5.4",
  "gpt5.4": "openai/gpt-5.4",
  "gpt-5.4-pro": "openai/gpt-5.4-pro",
  "gpt5.4-pro": "openai/gpt-5.4-pro",
  codex: "openai/gpt-5.4",
  "gpt-5.3-codex": "openai/gpt-5.4",
  "gpt5.3-codex": "openai/gpt-5.4",
  "openai/gpt-5.3-codex": "openai/gpt-5.4",
  mini: "openai/gpt-4o-mini",
  o1: "openai/o1",
  o3: "openai/o3",

  // DeepSeek
  deepseek: "deepseek/deepseek-chat",
  reasoner: "deepseek/deepseek-reasoner",

  // Kimi / Moonshot
  kimi: "moonshot/kimi-k2.5",
  moonshot: "moonshot/kimi-k2.5",
  "kimi-k2.5": "moonshot/kimi-k2.5",

  // Google
  gemini: "google/gemini-2.5-pro",
  flash: "google/gemini-2.5-flash",
  "gemini-3.1-pro-preview": "google/gemini-3.1-pro",
  "google/gemini-3.1-pro-preview": "google/gemini-3.1-pro",

  // xAI
  grok: "xai/grok-3",
  "grok-fast": "xai/grok-4-fast-reasoning",
  "grok-code": "xai/grok-code-fast-1",

  // NVIDIA
  nvidia: "nvidia/gpt-oss-120b",
  "gpt-120b": "nvidia/gpt-oss-120b",

  // MiniMax
  minimax: "minimax/minimax-m2.5",

  // Routing profile aliases (common variations)
  "auto-router": "auto",
  router: "auto",

  // Note: auto, free, eco, premium are virtual routing profiles registered in MODELS
  // They don't need aliases since they're already top-level model IDs
};

/**
 * Resolve a model alias to its full model ID.
 * Examples:
 *   - "claude" -> "anthropic/claude-sonnet-4.6" (alias)
 *   - "openai/gpt-4o" -> "openai/gpt-4o" (unchanged)
 *   - "unknown" -> "unknown" (returned as-is)
 */
export function resolveModelAlias(model: string): string {
  const normalized = model.trim().toLowerCase();
  const resolved = MODEL_ALIASES[normalized];
  if (resolved) return resolved;
  return model;
}

export type ModelDefinition = {
  id: string;
  name: string;
  /** Model version (e.g., "4.6", "3.1", "5.2") for tracking updates */
  version?: string;
  inputPrice: number;
  outputPrice: number;
  contextWindow: number;
  maxOutput: number;
  reasoning?: boolean;
  vision?: boolean;
  /** Models optimized for agentic workflows (multi-step autonomous tasks) */
  agentic?: boolean;
  /**
   * Model supports OpenAI-compatible structured function/tool calling.
   * Models without this flag output tool invocations as plain text JSON,
   * which leaks raw {"command":"..."} into visible chat messages.
   * Default: false (must opt-in to prevent silent regressions on new models).
   */
  toolCalling?: boolean;
};

export const MODELS: ModelDefinition[] = [
  // Smart routing meta-models — router replaces with actual model
  // NOTE: Model IDs use "provider/model" format (e.g., "openai/gpt-4o")
  {
    id: "auto",
    name: "Auto (Smart Router - Balanced)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 1_050_000,
    maxOutput: 128_000,
  },
  {
    id: "free",
    name: "Free (NVIDIA GPT-OSS-120B only)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 128_000,
    maxOutput: 4_096,
  },
  {
    id: "eco",
    name: "Eco (Smart Router - Cost Optimized)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 1_050_000,
    maxOutput: 128_000,
  },
  {
    id: "premium",
    name: "Premium (Smart Router - Best Quality)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 2_000_000,
    maxOutput: 200_000,
  },

  // OpenAI GPT-5 Family
  {
    id: "openai/gpt-5.4",
    name: "GPT-5.4",
    version: "5.4",
    inputPrice: 2.5,
    outputPrice: 15.0,
    contextWindow: 1050000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "openai/gpt-5.4-pro",
    name: "GPT-5.4 Pro",
    version: "5.4",
    inputPrice: 30.0,
    outputPrice: 180.0,
    contextWindow: 1050000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "openai/gpt-5.2",
    name: "GPT-5.2",
    version: "5.2",
    inputPrice: 1.75,
    outputPrice: 14.0,
    contextWindow: 400000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "openai/gpt-5-mini",
    name: "GPT-5 Mini",
    version: "5.0",
    inputPrice: 0.25,
    outputPrice: 2.0,
    contextWindow: 200000,
    maxOutput: 65536,
    toolCalling: true,
  },
  {
    id: "openai/gpt-5-nano",
    name: "GPT-5 Nano",
    version: "5.0",
    inputPrice: 0.05,
    outputPrice: 0.4,
    contextWindow: 128000,
    maxOutput: 32768,
    toolCalling: true,
  },
  {
    id: "openai/gpt-5.2-pro",
    name: "GPT-5.2 Pro",
    version: "5.2",
    inputPrice: 21.0,
    outputPrice: 168.0,
    contextWindow: 400000,
    maxOutput: 128000,
    reasoning: true,
    toolCalling: true,
  },

  // OpenAI Codex Family
  {
    id: "openai/gpt-5.2-codex",
    name: "GPT-5.2 Codex",
    version: "5.2",
    inputPrice: 1.75,
    outputPrice: 14.0,
    contextWindow: 128000,
    maxOutput: 32000,
    agentic: true,
    toolCalling: true,
  },

  // OpenAI GPT-4 Family
  {
    id: "openai/gpt-4.1",
    name: "GPT-4.1",
    version: "4.1",
    inputPrice: 2.0,
    outputPrice: 8.0,
    contextWindow: 128000,
    maxOutput: 16384,
    vision: true,
    toolCalling: true,
  },
  {
    id: "openai/gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    version: "4.1",
    inputPrice: 0.4,
    outputPrice: 1.6,
    contextWindow: 128000,
    maxOutput: 16384,
    toolCalling: true,
  },
  {
    id: "openai/gpt-4.1-nano",
    name: "GPT-4.1 Nano",
    version: "4.1",
    inputPrice: 0.1,
    outputPrice: 0.4,
    contextWindow: 128000,
    maxOutput: 16384,
    toolCalling: true,
  },
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    version: "4o",
    inputPrice: 2.5,
    outputPrice: 10.0,
    contextWindow: 128000,
    maxOutput: 16384,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "openai/gpt-4o-mini",
    name: "GPT-4o Mini",
    version: "4o-mini",
    inputPrice: 0.15,
    outputPrice: 0.6,
    contextWindow: 128000,
    maxOutput: 16384,
    toolCalling: true,
  },

  // OpenAI O-series (Reasoning)
  {
    id: "openai/o1",
    name: "o1",
    version: "1",
    inputPrice: 15.0,
    outputPrice: 60.0,
    contextWindow: 200000,
    maxOutput: 100000,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "openai/o1-mini",
    name: "o1-mini",
    version: "1-mini",
    inputPrice: 1.1,
    outputPrice: 4.4,
    contextWindow: 128000,
    maxOutput: 65536,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "openai/o3",
    name: "o3",
    version: "3",
    inputPrice: 2.0,
    outputPrice: 8.0,
    contextWindow: 200000,
    maxOutput: 100000,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "openai/o3-mini",
    name: "o3-mini",
    version: "3-mini",
    inputPrice: 1.1,
    outputPrice: 4.4,
    contextWindow: 128000,
    maxOutput: 65536,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "openai/o4-mini",
    name: "o4-mini",
    version: "4-mini",
    inputPrice: 1.1,
    outputPrice: 4.4,
    contextWindow: 128000,
    maxOutput: 65536,
    reasoning: true,
    toolCalling: true,
  },

  // Anthropic - all Claude models excel at agentic workflows
  // Use newest versions (4.6) with full provider prefix
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    version: "4.5",
    inputPrice: 1.0,
    outputPrice: 5.0,
    contextWindow: 200000,
    maxOutput: 8192,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    version: "4.6",
    inputPrice: 3.0,
    outputPrice: 15.0,
    contextWindow: 200000,
    maxOutput: 64000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "anthropic/claude-opus-4.6",
    name: "Claude Opus 4.6",
    version: "4.6",
    inputPrice: 5.0,
    outputPrice: 25.0,
    contextWindow: 200000,
    maxOutput: 32000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },

  // Google
  {
    id: "google/gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    version: "3.1",
    inputPrice: 2.0,
    outputPrice: 12.0,
    contextWindow: 1050000,
    maxOutput: 65536,
    reasoning: true,
    vision: true,
    toolCalling: true,
  },
  {
    id: "google/gemini-3-pro-preview",
    name: "Gemini 3 Pro Preview",
    version: "3.0",
    inputPrice: 2.0,
    outputPrice: 12.0,
    contextWindow: 1050000,
    maxOutput: 65536,
    reasoning: true,
    vision: true,
    toolCalling: true,
  },
  {
    id: "google/gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview",
    version: "3.0",
    inputPrice: 0.5,
    outputPrice: 3.0,
    contextWindow: 1000000,
    maxOutput: 65536,
    vision: true,
    toolCalling: true,
  },
  {
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    version: "2.5",
    inputPrice: 1.25,
    outputPrice: 10.0,
    contextWindow: 1050000,
    maxOutput: 65536,
    reasoning: true,
    vision: true,
    toolCalling: true,
  },
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    version: "2.5",
    inputPrice: 0.3,
    outputPrice: 2.5,
    contextWindow: 1000000,
    maxOutput: 65536,
    vision: true,
    toolCalling: true,
  },
  {
    id: "google/gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    version: "2.5",
    inputPrice: 0.1,
    outputPrice: 0.4,
    contextWindow: 1000000,
    maxOutput: 65536,
    toolCalling: true,
  },

  // DeepSeek
  {
    id: "deepseek/deepseek-chat",
    name: "DeepSeek V3.2 Chat",
    version: "3.2",
    inputPrice: 0.28,
    outputPrice: 0.42,
    contextWindow: 128000,
    maxOutput: 8192,
    toolCalling: true,
  },
  {
    id: "deepseek/deepseek-reasoner",
    name: "DeepSeek V3.2 Reasoner",
    version: "3.2",
    inputPrice: 0.28,
    outputPrice: 0.42,
    contextWindow: 128000,
    maxOutput: 8192,
    reasoning: true,
    toolCalling: true,
  },

  // Moonshot / Kimi - optimized for agentic workflows
  {
    id: "moonshot/kimi-k2.5",
    name: "Kimi K2.5",
    version: "k2.5",
    inputPrice: 0.6,
    outputPrice: 3.0,
    contextWindow: 262144,
    maxOutput: 8192,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },

  // xAI / Grok
  {
    id: "xai/grok-3",
    name: "Grok 3",
    version: "3",
    inputPrice: 3.0,
    outputPrice: 15.0,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
    toolCalling: true,
  },
  // grok-3-fast removed - too expensive ($5/$25), use grok-4-fast instead
  {
    id: "xai/grok-3-mini",
    name: "Grok 3 Mini",
    version: "3-mini",
    inputPrice: 0.3,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384,
    toolCalling: true,
  },

  // xAI Grok 4 Family - Ultra-cheap fast models
  {
    id: "xai/grok-4-fast-reasoning",
    name: "Grok 4 Fast Reasoning",
    version: "4",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "xai/grok-4-fast-non-reasoning",
    name: "Grok 4 Fast",
    version: "4",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384,
    toolCalling: true,
  },
  {
    id: "xai/grok-4-1-fast-reasoning",
    name: "Grok 4.1 Fast Reasoning",
    version: "4.1",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "xai/grok-4-1-fast-non-reasoning",
    name: "Grok 4.1 Fast",
    version: "4.1",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384,
    toolCalling: true,
  },
  {
    id: "xai/grok-code-fast-1",
    name: "Grok Code Fast",
    version: "1",
    inputPrice: 0.2,
    outputPrice: 1.5,
    contextWindow: 131072,
    maxOutput: 16384,
    // toolCalling intentionally omitted: outputs tool calls as plain text JSON,
    // not OpenAI-compatible structured function calls. Will be skipped when
    // request has tools to prevent the "talking to itself" bug.
  },
  {
    id: "xai/grok-4-0709",
    name: "Grok 4 (0709)",
    version: "4-0709",
    inputPrice: 0.2,
    outputPrice: 1.5,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "xai/grok-2-vision",
    name: "Grok 2 Vision",
    version: "2",
    inputPrice: 2.0,
    outputPrice: 10.0,
    contextWindow: 131072,
    maxOutput: 16384,
    vision: true,
    toolCalling: true,
  },

  // MiniMax
  {
    id: "minimax/minimax-m2.5",
    name: "MiniMax M2.5",
    version: "m2.5",
    inputPrice: 0.3,
    outputPrice: 1.2,
    contextWindow: 204800,
    maxOutput: 16384,
    reasoning: true,
    agentic: true,
    toolCalling: true,
  },

  // NVIDIA - Free/cheap models
  {
    id: "nvidia/gpt-oss-120b",
    name: "NVIDIA GPT-OSS 120B",
    version: "120b",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 128000,
    maxOutput: 16384,
    // toolCalling intentionally omitted: free model, structured function
    // calling support unverified. Excluded from tool-heavy routing paths.
  },
  {
    id: "nvidia/kimi-k2.5",
    name: "NVIDIA Kimi K2.5",
    version: "k2.5",
    inputPrice: 0.55,
    outputPrice: 2.5,
    contextWindow: 262144,
    maxOutput: 16384,
    toolCalling: true,
  },
];

/**
 * Convert model definitions to OpenClaw ModelDefinitionConfig format.
 */
function toOpenClawModel(m: ModelDefinition): ModelDefinitionConfig {
  return {
    id: m.id,
    name: m.name,
    api: "openai-completions",
    reasoning: m.reasoning ?? false,
    input: m.vision ? ["text", "image"] : ["text"],
    cost: {
      input: m.inputPrice,
      output: m.outputPrice,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: m.contextWindow,
    maxTokens: m.maxOutput,
  };
}

/**
 * Alias models that map to real models.
 * These allow users to use friendly names like "free" or "gpt-120b".
 */
const ALIAS_MODELS: ModelDefinitionConfig[] = Object.entries(MODEL_ALIASES)
  .map(([alias, targetId]) => {
    const target = MODELS.find((m) => m.id === targetId);
    if (!target) return null;
    return toOpenClawModel({ ...target, id: alias, name: `${alias} → ${target.name}` });
  })
  .filter((m): m is ModelDefinitionConfig => m !== null);

/**
 * All models in OpenClaw format (including aliases).
 */
export const OPENCLAW_MODELS: ModelDefinitionConfig[] = [
  ...MODELS.map(toOpenClawModel),
  ...ALIAS_MODELS,
];

/**
 * Build a ModelProviderConfig for NexusRouter.
 *
 * @param baseUrl - The proxy's local base URL (e.g., "http://127.0.0.1:8402")
 */
export function buildProviderModels(baseUrl: string): ModelProviderConfig {
  return {
    baseUrl: `${baseUrl}/v1`,
    api: "openai-completions",
    models: OPENCLAW_MODELS,
  };
}

/**
 * Check if a model is optimized for agentic workflows.
 * Agentic models continue autonomously with multi-step tasks
 * instead of stopping and waiting for user input.
 */
export function isAgenticModel(modelId: string): boolean {
  const model = MODELS.find((m) => m.id === modelId);
  return model?.agentic ?? false;
}

/**
 * Get all agentic-capable models.
 */
export function getAgenticModels(): string[] {
  return MODELS.filter((m) => m.agentic).map((m) => m.id);
}

/**
 * Check if a model supports OpenAI-compatible structured tool/function calling.
 * Models without this flag (e.g. grok-code-fast-1) output tool invocations as
 * plain text JSON, which leaks {"command":"..."} into visible chat messages.
 */
export function supportsToolCalling(modelId: string): boolean {
  const model = MODELS.find((m) => m.id === modelId);
  return model?.toolCalling ?? false;
}

/**
 * Check if a model supports vision (image inputs).
 * Models without this flag cannot process image_url content parts.
 */
export function supportsVision(modelId: string): boolean {
  const model = MODELS.find((m) => m.id === modelId);
  return model?.vision ?? false;
}

/**
 * Get context window size for a model.
 * Returns undefined if model not found.
 */
export function getModelContextWindow(modelId: string): number | undefined {
  const model = MODELS.find((m) => m.id === modelId);
  return model?.contextWindow;
}

/**
 * Check if a model has reasoning/thinking capabilities.
 * Reasoning models may require reasoning_content in assistant tool_call messages.
 */
export function isReasoningModel(modelId: string): boolean {
  const model = MODELS.find((m) => m.id === modelId);
  return model?.reasoning ?? false;
}
