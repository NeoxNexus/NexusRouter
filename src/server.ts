import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import type { FastifyBaseLogger, FastifyLoggerOptions } from "fastify";
import { createServer as createHttpServer, type RequestListener, type Server } from "node:http";
import { loadConfig, getDefaultConfigPath, type Config } from "./config/loader.js";
import { OllamaClient } from "./ollama/client.js";
import { HybridClassifier } from "./classifier/hybrid.js";
import {
  createAdapter,
  registerAdapter,
  resolveProfile,
  getHintsAndWeights,
  sanitizeForClassification,
  AnthropicAdapter,
  OpenAIAdapter,
} from "./adapter/index.js";
import type { UnifiedRequest, AgentHints, ClassifierWeights } from "./adapter/types.js";
import type { ProtocolType } from "./adapter/types.js";
import { inferToolRequirement } from "./router/tool-intent.js";
import { queueRoutingDecision, logWriterState, type RoutingLogEntry, type UsageEntryV2 } from "./logger.js";
import { AccountingSwitch } from "./accounting/switch.js";
import { costOf, emptyUsage } from "./pricing/price-book.js";
import { resolveBaseline, type BaselineOptions } from "./accounting/baseline.js";
import {
  createUsageSniffer,
  extractAnthropicNonStreamingUsage,
  extractOpenAINonStreamingUsage,
} from "./adapter/usage-sniffer.js";
import { logFilePath, ensureLogDir, resolveLogDir } from "./paths.js";
import { registerDashboardRoutes } from "./dashboard/web.js";

// Fastify only manages the single server it creates. We capture its raw
// request handler (via serverFactory) so startServer can bind additional
// loopback addresses (e.g. both 127.0.0.1 and ::1) to the same handler.
declare module "fastify" {
  interface FastifyInstance {
    rawRequestHandler: RequestListener;
  }
}

import type { UsageCapture } from "./adapter/usage-sniffer.js";

// ─── Register adapters once at startup ───
registerAdapter("anthropic", () => new AnthropicAdapter());
registerAdapter("openai", () => new OpenAIAdapter());

type RecordUsageInput = {
  protocol: "anthropic" | "openai";
  finalModelWithProvider: string;
  tier: string;
  requestedModel: string;
  capture: UsageCapture;
  latencyMs: number;
  accounting: AccountingSwitch;
};

function recordUsage(input: RecordUsageInput): void {
  if (!input.accounting.persist || !input.accounting.ledgerWriter) return;

  const costUsd = costOf(
    input.capture.usage,
    input.finalModelWithProvider,
    input.accounting.priceOverrides,
  );
  const baseline = resolveBaseline(
    {
      usage: input.capture.usage,
      actualModel: input.finalModelWithProvider,
      actualCostUsd: costUsd,
      requestedModel: input.requestedModel,
    },
    {
      mode: input.accounting.baselineMode,
      referenceModel: input.accounting.referenceModel,
      prices: input.accounting.priceOverrides,
    },
  );

  const entry: UsageEntryV2 = {
    schema: 2,
    timestamp: new Date().toISOString(),
    tier: input.tier,
    model: input.finalModelWithProvider,
    usage: input.capture.usage,
    usageSource: input.capture.usageSource,
    costUsd,
    baselineModel: baseline.baselineModel,
    baselineCostUsd: baseline.baselineCostUsd,
    baselineMethod: baseline.baselineMethod,
    savedUsd: baseline.savedUsd,
    truncated: input.capture.truncated,
    latencyMs: input.latencyMs,
  };

  try {
    const dir = resolveLogDir();
    const date = entry.timestamp.slice(0, 10);
    input.accounting.ledgerWriter.append(logFilePath("usage", date, dir), JSON.stringify(entry));
  } catch {
    // Never break the request flow
  }
}

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
  accounting: AccountingSwitch,
) {
  const adapter = createAdapter(protocol);
  const profile = resolveProfile(agentPrefix, protocol);
  const startedAt = Date.now();

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
  const shouldAutoRoute = !unified.model || unified.model.toLowerCase() === "auto";
  // Populated only when auto-routing; drives the routing decision log.
  let routingLog: Omit<RoutingLogEntry, "upstreamStatus" | "totalLatencyMs"> | undefined;

  if (shouldAutoRoute) {
    // Extract text from all user messages for classification
    const userText = unified.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");

    if (userText) {
      const conversationLength: "short" | "medium" | "long" =
        unified.messages.length <= 2 ? "short" : unified.messages.length <= 6 ? "medium" : "long";

      // Hosts inject boilerplate into the user turn (Claude Code hooks append
      // <system-reminder> blocks). Classify the stripped text, but keep the
      // original for observability and forwarding — upstream gets userText
      // untouched. The guard above stays on userText so an all-boilerplate
      // turn still produces a routing decision and a log line.
      const classificationText = sanitizeForClassification(profile, userText);

      const rawBody = unified.rawBody as Record<string, unknown> | undefined;
      const requiresTools =
        !!unified.hasTools && inferToolRequirement(classificationText, rawBody?.tool_choice);

      // If the profile stripped the entire turn, skip the classifier rather than
      // sending an empty prompt to the local Ollama model. Keep a fallback entry
      // so observability still records the turn.
      const classifierResult =
        classificationText.length === 0
          ? {
              tier: "SIMPLE" as const,
              confidence: 0.5,
              latency: 0,
              layer: "fallback" as const,
              reason: "low-confidence-fallback" as const,
            }
          : await classifier.classify(classificationText, {
              messageCount: unified.messages.length,
              hasSystemPrompt: !!unified.system,
              hasTools: unified.hasTools,
              requiresTools,
              conversationLength,
            });

      // Step 4: Weighted fusion of hints + classifier
      const tier = resolveWeightedTier(
        classifierResult,
        hints,
        weights,
        config.hints?.thinking ?? "off",
      );

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

      routingLog = {
        timestamp: new Date().toISOString(),
        agent: profile.name,
        protocol,
        requestedModel: unified.model,
        classifierTier: classifierResult.tier,
        finalTier: tier,
        finalModel: rawModel,
        layer: classifierResult.layer,
        reason: classifierResult.reason,
        confidence: classifierResult.confidence,
        hasTools: !!unified.hasTools,
        toolCount: Array.isArray(unified.tools) ? unified.tools.length : 0,
        requiresTools,
        hasThinking: !!hints.preferThinking,
        hasSystemPrompt: !!unified.system,
        messageCount: unified.messages.length,
        promptChars: userText.length,
        promptCharsSanitized: classificationText.length,
        promptPreview: userText,
        stream: !!unified.stream,
        classifyLatencyMs: classifierResult.latency,
      };
    } else {
      // No text to classify — use default tier
      const defaultTierConfig = config.tiers.SIMPLE;
      targetModel = defaultTierConfig?.primary || unified.model;
    }
  }

  // Resolve provider from model string (format: "provider/model" or just "model")
  const parts = targetModel.split("/");
  let providerName: string;

  // Preserve the provider/model form for pricing and baseline accounting before
  // stripping the prefix for upstream forwarding.
  const finalModelWithProvider = targetModel;

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

  if (routingLog) {
    // Queued, not awaited: batching keeps the log off the throughput ceiling
    // (per-request appendFile caps at ~2,959 req/s — Savings Ledger 决策 5).
    queueRoutingDecision({
      ...routingLog,
      upstreamStatus: result.status,
      totalLatencyMs: Date.now() - startedAt,
    });
  }

  // Set response headers from upstream
  for (const [k, v] of Object.entries(result.headers)) {
    reply.header(k, v);
  }

  // Step 6: Stream or return
  let parsedBody: unknown;
  if (!result.isStream || typeof result.body === "string") {
    const bodyStr = result.body as string;
    try {
      parsedBody = JSON.parse(bodyStr);
    } catch {
      parsedBody = undefined;
    }
  }

  // Capture usage for non-streaming responses while the body is already parsed.
  if (!result.isStream && accounting.enabled && accounting.captureNonStreaming) {
    const capture =
      protocol === "anthropic"
        ? extractAnthropicNonStreamingUsage(parsedBody)
        : extractOpenAINonStreamingUsage(parsedBody);
    recordUsage({
      protocol,
      finalModelWithProvider,
      tier: routingLog?.finalTier ?? "DIRECT",
      requestedModel: unified.model || "",
      capture,
      latencyMs: Date.now() - startedAt,
      accounting,
    });
  }

  if (result.isStream && typeof result.body !== "string") {
    reply.raw.writeHead(result.status, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const sniffer = accounting.captureStreaming
      ? createUsageSniffer(protocol, accounting.tailWindowBytes)
      : null;
    const reader = result.body.getReader();
    let truncated = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sniffer?.push(value);
        reply.raw.write(value);
      }
    } catch (streamError) {
      req.log.error({ err: streamError }, "Stream read error from upstream");
      truncated = true;
    } finally {
      reader.releaseLock();
      reply.raw.end();
    }

    if (accounting.enabled && sniffer) {
      const capture = sniffer.finish(truncated);
      recordUsage({
        protocol,
        finalModelWithProvider,
        tier: routingLog?.finalTier ?? "DIRECT",
        requestedModel: unified.model || "",
        capture,
        latencyMs: Date.now() - startedAt,
        accounting,
      });
    }
    return;
  }

  const bodyStr = result.body as string;
  try {
    return reply.status(result.status).send(parsedBody ?? bodyStr);
  } catch {
    return reply.status(result.status).send(bodyStr);
  }
}

// ─── Weighted Tier Resolution ───

/**
 * Fuse classifier result with agent hints.
 *
 * `thinkingMode` governs how much pull the host's thinking flag is allowed:
 * - "off": ignored (default — CC attaches thinking on every turn when a
 *   global effort level is set, so it carries no per-request signal)
 * - "complex": a thinking request is at least COMPLEX
 * - "reasoning": a thinking request is at least REASONING (legacy behavior)
 *
 * The haiku/background-task hint keeps full pull in every mode: CC only asks
 * for haiku when it genuinely runs a background task.
 */
function resolveWeightedTier(
  classifierResult: { tier: string; confidence: number },
  hints: AgentHints,
  weights: ClassifierWeights,
  thinkingMode: "off" | "complex" | "reasoning" = "off",
): string {
  const TIER_RANK: Record<string, number> = { SIMPLE: 0, MEDIUM: 1, COMPLEX: 2, REASONING: 3 };
  const TIERS = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];

  const classifierRank = TIER_RANK[classifierResult.tier] ?? 0;
  let hintRank = classifierRank; // default: same as classifier

  // Hint-based tier adjustment
  if (hints.isBackgroundTask) {
    hintRank = 0; // Force SIMPLE
  } else if (hints.preferThinking && thinkingMode !== "off") {
    // Prefer the hint over the classifier rank when thinking is enabled.
    // The final floor is enforced after fusion below so the documented
    // "at least COMPLEX/REASONING" guarantee holds even when the classifier
    // produced a low tier with equal weights.
    hintRank = thinkingMode === "reasoning" ? 3 : 2;
  }

  // Weighted average of ranks (continuous), then round
  let fusedRank = Math.round(
    hintRank * weights.hintWeight + classifierRank * weights.classifierWeight,
  );

  // Enforce the thinking floor on the result tier.
  if (hints.preferThinking && thinkingMode !== "off") {
    const floor = thinkingMode === "reasoning" ? 3 : 2;
    fusedRank = Math.max(fusedRank, floor);
  }

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
  logger?: FastifyBaseLogger | FastifyLoggerOptions | boolean,
): Promise<FastifyInstance> {
  const config = preloadedConfig || (await loadConfig(configPath));

  // Accounting switch: kill-switch + hot-reload + health visibility.
  // Created even when disabled so /health can report the "off" state.
  const accounting = new AccountingSwitch({
    configPath: configPath || getDefaultConfigPath(),
    config: config.accounting,
  });

  // Capture Fastify's raw request handler so startServer can attach extra
  // listeners (multiple loopback addresses) that reuse the same pipeline.
  let capturedHandler!: RequestListener;
  const app = Fastify({
    logger: logger ?? true,
    serverFactory: (handler) => {
      capturedHandler = handler;
      return createHttpServer(handler);
    },
  });
  app.decorate("rawRequestHandler", capturedHandler);

  const ollama = new OllamaClient(config.ollama.baseUrl);
  const classifier = new HybridClassifier(ollama, {
    heuristicThreshold: config.router.layers.heuristic.confidenceThreshold,
    aiThreshold: config.router.layers.ai.fallbackConfidence,
  });

  // Health check. `ledger` makes the log-write state observable (决策 6 / L3) —
  // otherwise "did persistence degrade?" can only be guessed at.
  app.get("/health", async () => ({
    status: "ok",
    timestamp: Date.now(),
    ledger: logWriterState(),
    accounting: accounting.health(),
  }));

  // Ensure the accounting watcher is released when the server closes.
  app.addHook("onClose", async () => {
    accounting.close();
  });

  // Optional web dashboard (off by default; opt-in via router.dashboard).
  registerDashboardRoutes(app, {
    enabled: config.router.dashboard,
    logDir: resolveLogDir(),
    health: () => accounting.health(),
    baselineMode: accounting.baselineMode,
  });

  // ─── Route registration helper ───
  const registerRoutes = (prefix: string, protocol: ProtocolType, agentPrefix: string | null) => {
    // Anthropic Messages API path
    if (protocol === "anthropic") {
      app.post(`${prefix}/v1/messages`, async (req, reply) => {
        return handleUnified(req, reply, "anthropic", agentPrefix, config, classifier, accounting);
      });
    }

    // OpenAI Chat Completions path
    if (protocol === "openai") {
      app.post(`${prefix}/v1/chat/completions`, async (req, reply) => {
        return handleUnified(req, reply, "openai", agentPrefix, config, classifier, accounting);
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

export interface RunningServer {
  /** Addresses actually bound (subset of config.router.hosts). */
  hosts: string[];
  /** Port the server listens on. */
  port: number;
  /** Close the Fastify app and all extra loopback listeners. */
  close: () => Promise<void>;
}

export async function startServer(configPath?: string, port?: number): Promise<RunningServer> {
  const config = await loadConfig(configPath);
  const app = await createServer(configPath, config);
  const listenPort = port || config.router.port;
  const hosts = config.router.hosts;

  const bound: string[] = [];
  const extraServers: Server[] = [];

  for (const [i, host] of hosts.entries()) {
    try {
      if (i === 0) {
        // Primary address goes through Fastify's own lifecycle.
        await app.listen({ port: listenPort, host });
      } else {
        // Additional addresses reuse the same request handler via a sibling
        // http.Server, since a Fastify instance can only listen() once.
        const extra = createHttpServer(app.rawRequestHandler);
        await new Promise<void>((resolve, reject) => {
          extra.once("error", reject);
          extra.listen(listenPort, host, () => resolve());
        });
        extraServers.push(extra);
      }
      bound.push(host);
    } catch (err) {
      // A host may be unbindable (e.g. IPv6 disabled → ::1 throws). Skip it
      // but keep going, as long as at least one address binds.
      app.log.warn(
        { err, host, port: listenPort },
        `Failed to bind ${host}:${listenPort}, skipping`,
      );
    }
  }

  if (bound.length === 0) {
    await app.close();
    throw new Error(`Could not bind port ${listenPort} on any of: ${hosts.join(", ")}`);
  }

  const urls = bound
    .map((h) => `http://${h.includes(":") ? `[${h}]` : h}:${listenPort}`)
    .join(", ");
  console.log(`NexusRouter running on ${urls}`);

  return {
    hosts: bound,
    port: listenPort,
    close: async () => {
      await app.close();
      await Promise.all(
        extraServers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
      );
    },
  };
}
