/**
 * Anthropic Protocol Adapter
 *
 * Converts between Anthropic Messages API format and the unified internal format.
 * Supports both streaming (SSE) and non-streaming modes.
 *
 * Implements Passthrough optimization: when the upstream provider is also Anthropic,
 * the request is forwarded as-is with zero conversion overhead.
 */

import type { ProtocolAdapter, ForwardResult, ProviderConfig } from "./adapter.js";
import type { UnifiedRequest, UnifiedMessage, ProtocolType } from "./types.js";

// ─── Anthropic-specific types ───

interface AnthropicContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicRequestBody {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  max_tokens: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: unknown[];
  tool_choice?: unknown;
  thinking?: unknown;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

// ─── Helper: extract text from Anthropic content ───

function extractText(content: string | AnthropicContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("\n");
}

function extractSystemText(
  system: string | AnthropicContentBlock[] | undefined,
): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  return system
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("\n");
}

// ─── Anthropic Adapter ───

export class AnthropicAdapter implements ProtocolAdapter {
  readonly protocol: ProtocolType = "anthropic";

  toUnified(body: unknown, headers: Record<string, string | undefined>): UnifiedRequest {
    const req = body as AnthropicRequestBody;

    const messages: UnifiedMessage[] = (req.messages || []).map((m) => ({
      role: m.role as "user" | "assistant",
      content: extractText(m.content),
      rawContent: m.content,
    }));

    return {
      protocol: "anthropic",
      model: req.model || "auto",
      messages,
      system: extractSystemText(req.system),
      stream: req.stream ?? false,
      maxTokens: req.max_tokens,
      temperature: req.temperature,
      hasTools: Array.isArray(req.tools) && req.tools.length > 0,
      tools: req.tools,
      rawBody: body,
      rawHeaders: headers,
    };
  }

  async forward(request: UnifiedRequest, providerConfig: ProviderConfig): Promise<ForwardResult> {
    // Passthrough optimization: forward the raw Anthropic body with model override.
    // We still need to serialize because model may have changed.
    const rawBody = request.rawBody as AnthropicRequestBody;
    const upstreamBody = {
      ...rawBody,
      model: request.model, // Use router-selected model
      max_tokens: rawBody.max_tokens ?? 8192, // Anthropic requires max_tokens > 0
    };

    const baseUrl = providerConfig.baseUrl.replace(/\/+$/, "");
    const url = `${baseUrl}/v1/messages`;
    const timeoutMs = providerConfig.timeoutMs ?? 300_000;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // Build Anthropic-specific headers
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": providerConfig.apiKey,
      "anthropic-version": request.rawHeaders["anthropic-version"] || "2023-06-01",
    };

    // Pass through optional Anthropic headers
    for (const h of ["anthropic-beta", "anthropic-danger-accept-empty-tool-use"]) {
      if (request.rawHeaders[h]) {
        headers[h] = request.rawHeaders[h]!;
      }
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(upstreamBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Collect relevant response headers
      const responseHeaders: Record<string, string> = {};
      for (const h of ["content-type", "x-request-id"]) {
        const value = response.headers.get(h);
        if (value) responseHeaders[h] = value;
      }

      if (request.stream && response.ok && response.body) {
        return {
          status: response.status,
          headers: responseHeaders,
          body: response.body,
          isStream: true,
        };
      }

      return {
        status: response.status,
        headers: responseHeaders,
        body: await response.text(),
        isStream: false,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        return {
          status: 504,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "error",
            error: { type: "timeout_error", message: `Upstream timed out after ${timeoutMs}ms` },
          }),
          isStream: false,
        };
      }
      return {
        status: 502,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "error",
          error: {
            type: "api_error",
            message: error instanceof Error ? error.message : "Unknown error",
          },
        }),
        isStream: false,
      };
    }
  }
}
