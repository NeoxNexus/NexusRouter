import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import { loadConfig, type Config } from "./config/loader.js";
import { OllamaClient } from "./ollama/client.js";
import { HybridClassifier } from "./classifier/hybrid.js";
import {
  createAdapter,
  registerAdapter,
  resolveProfile,
  getHintsAndWeights,
  AnthropicAdapter,
  OpenAIAdapter,
} from "./adapter/index.js";
import type { UnifiedRequest, AgentHints, ClassifierWeights } from "./adapter/types.js";
import type { ProtocolType } from "./adapter/types.js";

// ─── Register adapters once at startup ───
registerAdapter("anthropic", () => new AnthropicAdapter());
registerAdapter("openai", () => new OpenAIAdapter());

// ─── Unified Request Handler (Pipeline) ───
//
// All requests — regardless of protocol or agent prefix — go through this pipeline:
//
//   1. toUnified()        — Convert raw request to internal format
//   2. extractHints()     — Get agent-specific hints (optional)
//   3. classify()         — 15-dim classifier
//   4. weightedModel()    — Fuse hints + classifier result
//   5. forward()          — Send to upstream provider
//   6. Stream/Return      — Return response to caller

async function handleUnified(
  req: FastifyRequest,
  reply: FastifyReply,
  protocol: ProtocolType,
  agentPrefix: string | null,
  config: Config,
  classifier: HybridClassifier,
) {
  const adapter = createAdapter(protocol);
  const profile = resolveProfile(agentPrefix, protocol);

  // Step 1: Convert to unified format
  const rawHeaders: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") rawHeaders[k] = v;
  }
  const unified: UnifiedRequest = adapter.toUnified(req.body, rawHeaders);

  // Validate
  if (!unified.messages || unified.messages.length === 0) {
    return reply.status(400).send({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "messages array is required and must not be empty",
      },
    });
  }

  // Step 2-3: Extract hints + classify
  const { hints, weights } = getHintsAndWeights(profile, unified);

  let targetModel = unified.model;
  const shouldAutoRoute = !unified.model || unified.model === "auto";

  if (shouldAutoRoute) {
    // Extract text from all user messages for classification
    const userText = unified.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");

    if (userText) {
      const conversationLength: "short" | "medium" | "long" =
        unified.messages.length <= 2 ? "short" : unified.messages.length <= 6 ? "medium" : "long";

      const classifierResult = await classifier.classify(userText, {
        messageCount: unified.messages.length,
        hasSystemPrompt: !!unified.system,
        hasTools: unified.hasTools,
        conversationLength,
      });

      // Step 4: Weighted fusion of hints + classifier
      const tier = resolveWeightedTier(classifierResult, hints, weights);

      const tierConfig = config.tiers[tier as keyof typeof config.tiers];
      if (!tierConfig) {
        return reply.status(500).send({
          type: "error",
          error: { type: "api_error", message: `No model configured for tier: ${tier}` },
        });
      }

      const rawModel = tierConfig.primary;
      targetModel = rawModel;

      // Add routing metadata headers
      reply.header("x-nexusrouter-tier", tier);
      reply.header("x-nexusrouter-layer", classifierResult.layer);
      reply.header("x-nexusrouter-confidence", String(classifierResult.confidence));
      reply.header("x-nexusrouter-agent", profile.name);
    } else {
      // No text to classify — use default tier
      const defaultTierConfig = config.tiers.SIMPLE;
      targetModel = defaultTierConfig?.primary || unified.model;
    }
  }

  // Resolve provider from model string (format: "provider/model" or just "model")
  const parts = targetModel.split("/");
  let providerName: string;

  if (parts.length >= 2) {
    // Explicit provider prefix: e.g. "openai/gpt-4o"
    providerName = parts[0];
  } else {
    // No slash — must be an explicit model name without provider prefix
    // This is an invalid format when not auto-routing
    if (!shouldAutoRoute) {
      return reply.status(400).send({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `Invalid model format: "${targetModel}". Use "provider/model" format (e.g., "openai/gpt-4o") or "auto".`,
        },
      });
    }
    providerName = protocol === "anthropic" ? "anthropic" : "openai";
  }

  // Strip provider prefix before forwarding — upstreams expect bare model
  // names (e.g. "openai/gpt-4o" → "gpt-4o", "anthropic/claude-sonnet-4" → "claude-sonnet-4")
  if (parts.length >= 2) {
    targetModel = parts.slice(1).join("/");
  }

  const providerConfig = config.providers[providerName];
  if (!providerConfig) {
    return reply.status(400).send({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: `Provider '${providerName}' not configured`,
      },
    });
  }

  // Resolve which API key to send upstream.
  //
  // Default (passthroughApiKey: false): only use the API key from config,
  // never trust client-supplied keys. If apiKey is empty string, the
  // upstream will return 401, which is the correct behavior.
  //
  // Passthrough mode (passthroughApiKey: true): forward the client's own
  // key instead. Safe only because baseUrl is pinned by server-side config,
  // so client keys can only reach the configured trusted gateway (e.g.
  // a company new-api instance where every user brings their own token).
  let apiKey = providerConfig.apiKey || "";
  if (providerConfig.passthroughApiKey) {
    const clientKey = extractClientApiKey(rawHeaders);
    if (!clientKey) {
      return reply.status(401).send({
        type: "error",
        error: {
          type: "authentication_error",
          message:
            "API key required. Provide your own key via 'Authorization: Bearer <key>' or 'x-api-key: <key>'.",
        },
      });
    }
    apiKey = clientKey;
  }

  // Step 5: Forward request (with resolved model)
  const forwardedUnified: UnifiedRequest = {
    ...unified,
    model: targetModel,
  };

  const result = await adapter.forward(forwardedUnified, {
    baseUrl: providerConfig.baseUrl || getDefaultProviderUrl(providerName),
    apiKey,
    timeoutMs: config.router?.timeout || 300_000,
  });

  // Set response headers from upstream
  for (const [k, v] of Object.entries(result.headers)) {
    reply.header(k, v);
  }

  // Step 6: Stream or return
  if (result.isStream && typeof result.body !== "string") {
    reply.raw.writeHead(result.status, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const reader = result.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        reply.raw.write(value);
      }
    } catch (streamError) {
      req.log.error({ err: streamError }, "Stream read error from upstream");
    } finally {
      reader.releaseLock();
      reply.raw.end();
    }
    return;
  }

  const bodyStr = result.body as string;
  try {
    return reply.status(result.status).send(JSON.parse(bodyStr));
  } catch {
    return reply.status(result.status).send(bodyStr);
  }
}

// ─── Weighted Tier Resolution ───

function resolveWeightedTier(
  classifierResult: { tier: string; confidence: number },
  hints: AgentHints,
  weights: ClassifierWeights,
): string {
  const TIER_RANK: Record<string, number> = { SIMPLE: 0, MEDIUM: 1, COMPLEX: 2, REASONING: 3 };
  const TIERS = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];

  const classifierRank = TIER_RANK[classifierResult.tier] ?? 0;
  let hintRank = classifierRank; // default: same as classifier

  // Hint-based tier adjustment
  if (hints.isBackgroundTask)
    hintRank = 0; // Force SIMPLE
  else if (hints.preferThinking) hintRank = Math.max(classifierRank, 3); // At least REASONING

  // Weighted average of ranks (continuous), then round
  const fusedRank = Math.round(
    hintRank * weights.hintWeight + classifierRank * weights.classifierWeight,
  );

  return TIERS[Math.min(fusedRank, 3)];
}

// ─── Client API Key Extraction (passthrough mode) ───

/**
 * Extract the client's own API key from request headers.
 * Accepts `Authorization: Bearer <key>` (OpenAI style, also used by
 * Claude Code with ANTHROPIC_AUTH_TOKEN) and `x-api-key: <key>`
 * (Anthropic style, used by Claude Code with ANTHROPIC_API_KEY).
 * Header names are lowercase — Node/Fastify normalize them.
 */
function extractClientApiKey(rawHeaders: Record<string, string | undefined>): string | null {
  const authorization = rawHeaders["authorization"];
  if (authorization) {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match && match[1].trim()) {
      return match[1].trim();
    }
  }

  const xApiKey = rawHeaders["x-api-key"];
  if (xApiKey && xApiKey.trim()) {
    return xApiKey.trim();
  }

  return null;
}

// ─── Default Provider URLs ───

function getDefaultProviderUrl(provider: string): string {
  const urls: Record<string, string> = {
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com",
    google: "https://generativelanguage.googleapis.com/v1beta",
  };
  return urls[provider] || "";
}

// ─── Server Factory ───

export async function createServer(
  configPath?: string,
  preloadedConfig?: Config,
): Promise<FastifyInstance> {
  const config = preloadedConfig || (await loadConfig(configPath));

  const app = Fastify({ logger: true });

  const ollama = new OllamaClient(config.ollama.baseUrl);
  const classifier = new HybridClassifier(ollama, {
    heuristicThreshold: config.router.layers.heuristic.confidenceThreshold,
    aiThreshold: config.router.layers.ai.fallbackConfidence,
  });

  // Health check
  app.get("/health", async () => ({ status: "ok", timestamp: Date.now() }));

  // ─── Route registration helper ───
  const registerRoutes = (prefix: string, protocol: ProtocolType, agentPrefix: string | null) => {
    // Anthropic Messages API path
    if (protocol === "anthropic") {
      app.post(`${prefix}/v1/messages`, async (req, reply) => {
        return handleUnified(req, reply, "anthropic", agentPrefix, config, classifier);
      });
    }

    // OpenAI Chat Completions path
    if (protocol === "openai") {
      app.post(`${prefix}/v1/chat/completions`, async (req, reply) => {
        return handleUnified(req, reply, "openai", agentPrefix, config, classifier);
      });
    }
  };

  // ─── Agent-prefixed routes (new) ───
  registerRoutes("/anthropic", "anthropic", "anthropic"); // Claude Code
  registerRoutes("/openclaw", "openai", "openclaw"); // OpenClaw
  registerRoutes("/openai", "openai", "openai"); // Generic OpenAI
  registerRoutes("/cursor", "openai", "cursor"); // Cursor (future)

  // ─── Standard routes (backward compatibility) ───
  // These ensure existing OpenClaw/client configs need zero changes.
  registerRoutes("", "openai", "openclaw"); // /v1/chat/completions → openclaw profile
  registerRoutes("", "anthropic", "claude-code"); // /v1/messages → claude-code profile

  return app;
}

export async function startServer(configPath?: string, port?: number): Promise<void> {
  const config = await loadConfig(configPath);
  const app = await createServer(configPath, config);
  const listenPort = port || config.router.port;

  await app.listen({ port: listenPort, host: "0.0.0.0" });
  console.log(`NexusRouter running on http://0.0.0.0:${listenPort}`);
}
