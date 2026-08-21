import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import type { FastifyBaseLogger, FastifyLoggerOptions } from "fastify";
import { createServer as createHttpServer, type RequestListener, type Server } from "node:http";
import { loadConfig, getDefaultConfigPath, type Config } from "./config/loader.js";
import { OllamaClient } from "./ollama/client.js";
import { HybridClassifier } from "./classifier/hybrid.js";
import { OpenAICompatClassifier } from "./classifier/openai-compat.js";
import type { AiClassifier } from "./classifier/ai-classifier.js";
import {
  createAdapter,
  registerAdapter,
  resolveProfile,
  getHintsAndWeights,
  sanitizeForClassification,
  AnthropicAdapter,
  OpenAIAdapter,
} from "./adapter/index.js";
import type { AgentProfile } from "./adapter/index.js";
import type { ForwardResult } from "./adapter/index.js";
import type { UnifiedRequest, AgentHints, ClassifierWeights } from "./adapter/types.js";
import type { ProtocolType } from "./adapter/types.js";
import { inferToolRequirement } from "./router/tool-intent.js";
import {
  queueRoutingDecision,
  logRoutingDecision,
  logOutcome,
  logWriterState,
  type RoutingLogEntry,
  type UsageEntryV2,
} from "./logger.js";
import { AccountingSwitch } from "./accounting/switch.js";
import { costOf, emptyUsage } from "./pricing/price-book.js";
import { resolveBaseline, type BaselineOptions } from "./accounting/baseline.js";
import {
  createUsageSniffer,
  extractAnthropicNonStreamingUsage,
  extractOpenAINonStreamingUsage,
} from "./adapter/usage-sniffer.js";
import { logFilePath, ensureLogDir, resolveLogDir, migrateLegacyLogDir } from "./paths.js";
import { registerDashboardRoutes } from "./dashboard/web.js";
declare module "fastify" {
  interface FastifyInstance {
    rawRequestHandler: RequestListener;
  }
}

import type { UsageCapture } from "./adapter/usage-sniffer.js";

// ─── Register adapters once at startup ───
registerAdapter("anthropic", () => new AnthropicAdapter());
registerAdapter("openai", () => new OpenAIAdapter());

// Tier ordering shared by the context guardrail and weighted fusion.
const TIER_RANK: Record<string, number> = { SIMPLE: 0, MEDIUM: 1, COMPLEX: 2, REASONING: 3 };

// ─── Retry outcome detection ───
//
// Routing JSONL is append-only, so a "the previous answer was bad" signal
// can't be patched onto the old row. When a new request looks like a retry
// of one logged within the last RETRY_WINDOW_MS, a companion row is appended
// to routing-outcome-YYYY-MM-DD.jsonl instead (joined back by `timestamp`,
// the referenced routing entry's ISO time). Two retry shapes are recognized:
//   same-text    — identical normalized classification text (verbatim resend)
//   model-switch — same agent, different requestedModel (explicit model swap)
// Only auto-routed requests are indexed (they are the ones with routing log
// rows to join against), but any request can trigger the signal. Background
// tasks are excluded by the caller: Claude Code's haiku side-requests would
// otherwise look like constant model-switches. Both indexes are bounded
// (RETRY_INDEX_MAX entries + window expiry) so a long-lived server process
// can't leak memory here. Pure observability — routing behavior is unchanged.

const RETRY_WINDOW_MS = 60_000;
const RETRY_INDEX_MAX = 200;

type IndexedRequest = {
  /** ISO timestamp of the routing log row — the outcome join key. */
  timestamp: string;
  seenAtMs: number;
  agent: string;
  /** Normalized: "" and "auto" (any case) both mean auto-routing. */
  requestedModel: string;
  textKey: string;
};

const retryIndexByText = new Map<string, IndexedRequest>();
const retryIndexByAgent = new Map<string, IndexedRequest>();

function normalizeRetryTextKey(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeRequestedModel(model: string): string {
  return !model || model.toLowerCase() === "auto" ? "auto" : model;
}

function evictRetryIndex(nowMs: number): void {
  for (const [key, entry] of retryIndexByText) {
    if (nowMs - entry.seenAtMs > RETRY_WINDOW_MS) retryIndexByText.delete(key);
  }
  for (const [key, entry] of retryIndexByAgent) {
    if (nowMs - entry.seenAtMs > RETRY_WINDOW_MS) retryIndexByAgent.delete(key);
  }
  // Maps iterate in insertion order, so the first key is the oldest.
  while (retryIndexByText.size > RETRY_INDEX_MAX) {
    retryIndexByText.delete(retryIndexByText.keys().next().value as string);
  }
  while (retryIndexByAgent.size > RETRY_INDEX_MAX) {
    retryIndexByAgent.delete(retryIndexByAgent.keys().next().value as string);
  }
}

function removeFromRetryIndex(entry: IndexedRequest): void {
  retryIndexByText.delete(`${entry.agent}\n${entry.textKey}`);
  if (retryIndexByAgent.get(entry.agent) === entry) retryIndexByAgent.delete(entry.agent);
}

/** Test hook: the index is module-level, so suites reset it between tests. */
export function resetRetryOutcomeIndex(): void {
  retryIndexByText.clear();
  retryIndexByAgent.clear();
}

function trackRetryOutcome(input: {
  timestamp: string;
  agent: string;
  requestedModel: string;
  textKey: string;
  /** True when this request gets its own routing log row (auto-routed). */
  index: boolean;
}): void {
  const nowMs = Date.now();
  evictRetryIndex(nowMs);

  let matched: IndexedRequest | undefined;
  let retryReason: "same-text" | "model-switch" | undefined;

  // Same-text wins when both rules match: an identical prompt pins exactly
  // which logged request the user was unhappy with, while model-switch can
  // only point at the agent's most recent one.
  if (input.textKey) {
    matched = retryIndexByText.get(`${input.agent}\n${input.textKey}`);
    if (matched) retryReason = "same-text";
  }
  if (!matched) {
    const lastForAgent = retryIndexByAgent.get(input.agent);
    if (lastForAgent && lastForAgent.requestedModel !== input.requestedModel) {
      matched = lastForAgent;
      retryReason = "model-switch";
    }
  }

  if (matched && retryReason) {
    // One outcome row per logged request — remove it so a further retry
    // references the newer row instead of stacking duplicates.
    removeFromRetryIndex(matched);
    void logOutcome({ timestamp: matched.timestamp, outcome: "retried", retryReason });
  }

  if (input.index) {
    const entry: IndexedRequest = {
      timestamp: input.timestamp,
      seenAtMs: nowMs,
      agent: input.agent,
      requestedModel: input.requestedModel,
      textKey: input.textKey,
    };
    if (entry.textKey) retryIndexByText.set(`${entry.agent}\n${entry.textKey}`, entry);
    retryIndexByAgent.set(entry.agent, entry);
  }
}

/**
 * Extract the most recent user message with real text, for classification.
 *
 * The most recent message is preferred over the joined transcript: long
 * histories always trip Layer 1's >200-word heuristic, and stale keywords
 * (e.g. "analyze security") pollute the current turn. Hosts inject
 * boilerplate into the user turn (Claude Code hooks append
 * <system-reminder> blocks) and tool_result-only continuations carry no
 * text at all — the walk below skips both and lands on the task's original
 * instruction.
 */
function extractClassificationText(
  profile: AgentProfile,
  messages: UnifiedRequest["messages"],
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const text = sanitizeForClassification(profile, message.content);
    if (text) return text;
  }
  return "";
}

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
//   3. classify()         — HybridClassifier layered rules → heuristic → AI → fallback
//   4. weightedModel()    — Fuse hints + classifier result
//   5. forward()          — Send to upstream provider (tier fallbacks on failure)
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
  const requestTimestamp = new Date().toISOString();

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
  // servedModel/fallbackAttempts stay out of the Omit for the same reason as
  // upstreamStatus: they are only known after forwarding, so they are filled
  // at the log write, not here.
  let routingLog:
    | Omit<
        RoutingLogEntry,
        "upstreamStatus" | "totalLatencyMs" | "servedModel" | "fallbackAttempts"
      >
    | undefined;
  // Tier fallback models ("provider/model" strings), tried in order when the
  // primary upstream fails before streaming starts.
  let fallbackModels: string[] = [];

  // Text of all user messages, kept for observability (routing log) only —
  // classification uses the latest real-text user message instead.
  const userText = unified.messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");

  // Latest real user text — shared by the classifier and the retry detector,
  // so it is computed even when this request is not auto-routed.
  const classificationText = extractClassificationText(profile, unified.messages);

  // Outcome signal: if this request looks like a retry of one logged in the
  // last 60s, append a companion row for the earlier entry (see the retry
  // outcome detection block above). Background tasks (haiku side-requests)
  // are excluded — their explicit model would fake constant model-switches.
  if (!hints.isBackgroundTask) {
    trackRetryOutcome({
      timestamp: requestTimestamp,
      agent: profile.name,
      requestedModel: normalizeRequestedModel(unified.model),
      textKey: normalizeRetryTextKey(classificationText),
      index: shouldAutoRoute && userText.length > 0,
    });
  }

  if (shouldAutoRoute) {
    // Context-size guardrail: when the whole request body is huge, route to
    // at least COMPLEX no matter what the classifier made of the prompt
    // text — oversized contexts degrade smaller models. Rough estimate
    // (~4 chars/token over the raw body); precision isn't needed here.
    // Computed on the shared auto-route path so a textless giant body (the
    // else branch below) can't slip past the guardrail either.
    const estimatedTokens = JSON.stringify(unified.rawBody).length / 4;
    const contextForcesComplex = estimatedTokens > config.router.maxTokensForceComplex;

    if (userText) {
      // The guard is on userText (not classificationText) so an
      // all-boilerplate turn still produces a routing decision and a log line.
      const conversationLength: "short" | "medium" | "long" =
        unified.messages.length <= 2 ? "short" : unified.messages.length <= 6 ? "medium" : "long";

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
      let tier = resolveWeightedTier(
        classifierResult,
        hints,
        weights,
        config.hints?.thinking ?? "off",
      );

      // Guardrail floor: only raises tiers below COMPLEX (see the shared
      // computation above).
      let contextForcedComplex = false;
      if (contextForcesComplex && (TIER_RANK[tier] ?? 0) < 2) {
        tier = "COMPLEX";
        contextForcedComplex = true;
      }

      const tierConfig = config.tiers[tier as keyof typeof config.tiers];
      if (!tierConfig) {
        return reply.status(500).send({
          type: "error",
          error: { type: "api_error", message: `No model configured for tier: ${tier}` },
        });
      }

      const rawModel = tierConfig.primary;
      targetModel = rawModel;
      fallbackModels = tierConfig.fallback;

      // Add routing metadata headers
      reply.header("x-nexusrouter-tier", tier);
      reply.header("x-nexusrouter-layer", classifierResult.layer);
      reply.header("x-nexusrouter-confidence", String(classifierResult.confidence));
      reply.header("x-nexusrouter-agent", profile.name);

      routingLog = {
        timestamp: requestTimestamp,
        agent: profile.name,
        protocol,
        requestedModel: unified.model,
        classifierTier: classifierResult.tier,
        finalTier: tier,
        ...(contextForcedComplex ? { contextForcedComplex: true } : {}),
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
      // No text to classify — use the default tier. The context guardrail
      // still applies here: a textless request with a huge body must not
      // sneak onto the small model. This branch builds no routingLog
      // (nothing was classified, so there is no decision row to enrich), so
      // the uplift is recorded via req.log.warn only.
      if (contextForcesComplex) {
        req.log.warn(
          {
            estimatedTokens,
            maxTokensForceComplex: config.router.maxTokensForceComplex,
          },
          "Context guardrail forced COMPLEX for a textless auto-routed request",
        );
      }
      const defaultTierConfig = config.tiers[contextForcesComplex ? "COMPLEX" : "SIMPLE"];
      targetModel = defaultTierConfig?.primary || unified.model;
      fallbackModels = defaultTierConfig?.fallback ?? [];
    }
  }

  // Step 5: Forward request (with resolved model).
  //
  // forwardToModel resolves "provider/model" → provider config + API key →
  // adapter.forward. Shared by the primary model and tier fallbacks so both
  // paths apply identical prefix parsing, key resolution, and passthrough
  // rules. The provider prefix is stripped before forwarding — upstreams
  // expect bare model names ("openai/gpt-4o" → "gpt-4o").
  type ForwardAttempt =
    | { ok: true; result: ForwardResult }
    | { ok: false; status: number; errorType: string; message: string };

  const forwardToModel = async (fullModel: string): Promise<ForwardAttempt> => {
    const parts = fullModel.split("/");
    let providerName: string;

    if (parts.length >= 2) {
      // Explicit provider prefix: e.g. "openai/gpt-4o"
      providerName = parts[0];
    } else {
      // No slash — must be an explicit model name without provider prefix
      // This is an invalid format when not auto-routing
      if (!shouldAutoRoute) {
        return {
          ok: false,
          status: 400,
          errorType: "invalid_request_error",
          message: `Invalid model format: "${fullModel}". Use "provider/model" format (e.g., "openai/gpt-4o") or "auto".`,
        };
      }
      providerName = protocol === "anthropic" ? "anthropic" : "openai";
    }

    const providerConfig = config.providers[providerName];
    if (!providerConfig) {
      return {
        ok: false,
        status: 400,
        errorType: "invalid_request_error",
        message: `Provider '${providerName}' not configured`,
      };
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
        return {
          ok: false,
          status: 401,
          errorType: "authentication_error",
          message:
            "API key required. Provide your own key via 'Authorization: Bearer <key>' or 'x-api-key: <key>'.",
        };
      }
      apiKey = clientKey;
    }

    const bareModel = parts.length >= 2 ? parts.slice(1).join("/") : fullModel;
    const result = await adapter.forward(
      { ...unified, model: bareModel },
      {
        baseUrl: providerConfig.baseUrl || getDefaultProviderUrl(providerName),
        apiKey,
        timeoutMs: config.router?.timeout || 300_000,
      },
    );
    return { ok: true, result };
  };

  const primaryAttempt = await forwardToModel(targetModel);
  if (!primaryAttempt.ok) {
    return reply.status(primaryAttempt.status).send({
      type: "error",
      error: { type: primaryAttempt.errorType, message: primaryAttempt.message },
    });
  }
  let result = primaryAttempt.result;

  // Fallback observability: how many upstream attempts failed before the
  // request was served (the primary failure included — it is what opens the
  // fallback path), and which model actually served it. Both land on the
  // routing log below, at the same post-forward point as upstreamStatus.
  let fallbackAttempts = 0;
  let servedModel: string | undefined;

  // Tier fallbacks: the primary upstream failed before streaming anything
  // back, so the model can still be swapped transparently. Once a stream has
  // started the response is committed — retrying would duplicate output. If
  // every candidate fails, the last error response is what the client gets.
  if (!result.isStream && (result.status < 200 || result.status >= 300)) {
    fallbackAttempts++; // the primary attempt failed
    for (const fallbackModel of fallbackModels) {
      const attempt = await forwardToModel(fallbackModel);
      if (!attempt.ok) {
        // Misconfigured fallback (unknown provider, missing client key) — the
        // upstream was never reached; count it and try the next one.
        fallbackAttempts++;
        req.log.warn(
          { model: fallbackModel, status: attempt.status, err: attempt.message },
          "Fallback attempt failed",
        );
        continue;
      }
      result = attempt.result;
      if (result.isStream || (result.status >= 200 && result.status < 300)) {
        servedModel = fallbackModel;
        break;
      }
      fallbackAttempts++;
      req.log.warn({ model: fallbackModel, status: result.status }, "Fallback attempt failed");
    }
  }

  // The model that actually served the request, provider prefix included.
  const finalModelWithProvider = servedModel ?? targetModel;

  if (routingLog) {
    // Queued, not awaited: batching keeps the log off the throughput ceiling
    // (per-request appendFile caps at ~2,959 req/s — Savings Ledger 决策 5).
    queueRoutingDecision({
      ...routingLog,
      // finalModel stays the tier's primary; when a fallback actually served
      // the request, servedModel + fallbackAttempts record the detour.
      ...(servedModel ? { servedModel } : {}),
      ...(fallbackAttempts > 0 ? { fallbackAttempts } : {}),
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
 * Background tasks (haiku requests) short-circuit to SIMPLE before any
 * weighting: CC only asks for haiku when it genuinely runs a background task.
 * A weighted average would still land on MEDIUM whenever the classifier said
 * REASONING (0.8·0 + 0.2·3 rounds to 1), defeating the cost-saving intent.
 */
export function resolveWeightedTier(
  classifierResult: { tier: string; confidence: number },
  hints: AgentHints,
  weights: ClassifierWeights,
  thinkingMode: "off" | "complex" | "reasoning" = "off",
): string {
  const TIERS = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];

  // Background task — pinned to SIMPLE outright (see docblock).
  if (hints.isBackgroundTask) {
    return "SIMPLE";
  }

  const classifierRank = TIER_RANK[classifierResult.tier] ?? 0;
  let hintRank = classifierRank; // default: same as classifier

  // Hint-based tier adjustment
  if (hints.preferThinking && thinkingMode !== "off") {
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

  // ─── Layer 2 分类后端选择 ───
  // 默认走 Ollama 本地小模型；aiClassifier.provider === "openai-compat" 时改用
  // OpenAI 兼容网关（new-api / vLLM）。该段被显式配置即视为启用 Layer 2，
  // 不看 ollama.enabled —— 它只管 ollama 路径。baseUrl/model 缺一无法构造，
  // 告警后回退 Ollama 路径（此时仍由 ollama.enabled 决定是否启用）。
  const aiLayer = config.aiClassifier;
  let ai: AiClassifier | undefined;
  let aiEnabled = config.ollama.enabled;
  if (aiLayer.provider === "openai-compat") {
    if (aiLayer.baseUrl && aiLayer.model) {
      ai = new OpenAICompatClassifier({
        baseUrl: aiLayer.baseUrl,
        apiKey: aiLayer.apiKey,
        model: aiLayer.model,
        timeout: aiLayer.timeout,
      });
      aiEnabled = true;
    } else {
      app.log.warn(
        "aiClassifier.provider is openai-compat but baseUrl/model is missing; " +
          (config.ollama.enabled
            ? "falling back to the Ollama classifier path"
            : "ollama.enabled is false, so the AI classifier layer is disabled entirely"),
      );
    }
  }
  ai ??= new OllamaClient({
    baseUrl: config.ollama.baseUrl,
    timeout: config.ollama.timeout,
    model: config.ollama.models.fast,
  });
  const classifier = new HybridClassifier(ai, {
    heuristicThreshold: config.router.layers.heuristic.confidenceThreshold,
    aiThreshold: config.router.layers.ai.fallbackConfidence,
    aiEnabled,
    onAiError: (err) =>
      app.log.warn({ err }, "AI classifier layer failing — check aiClassifier config"),
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

  // Migrate legacy `~/.nexusrouter/logs` to the unified `~/.nexus-router/logs`
  // before any logger or dashboard opens a file descriptor. Skip in Vitest so
  // tests never touch the developer's home directory.
  if (!process.env.VITEST) {
    await migrateLegacyLogDir();
  }

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
