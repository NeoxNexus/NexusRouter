/**
 * OpenAI Protocol Adapter
 *
 * Converts between OpenAI Chat Completions API format and the unified internal format.
 * Supports both streaming (SSE) and non-streaming modes.
 *
 * This adapter is used by OpenClaw, Cursor, and any OpenAI-compatible agent.
 */

import type { ProtocolAdapter, ForwardResult, ProviderConfig } from "./adapter.js";
import type { UnifiedRequest, UnifiedMessage, ProtocolType } from "./types.js";

// ─── OpenAI-specific types ───

interface OpenAIMessage {
    role: "user" | "assistant" | "system";
    content: string;
}

interface OpenAIRequestBody {
    model: string;
    messages: OpenAIMessage[];
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
    tools?: unknown[];
    [key: string]: unknown;
}

// ─── OpenAI Adapter ───

export class OpenAIAdapter implements ProtocolAdapter {
    readonly protocol: ProtocolType = "openai";

    toUnified(body: unknown, headers: Record<string, string | undefined>): UnifiedRequest {
        const req = body as OpenAIRequestBody;

        // Extract system message if present
        const systemMsg = req.messages?.find((m) => m.role === "system");
        const nonSystemMessages: UnifiedMessage[] = (req.messages || [])
            .filter((m) => m.role !== "system")
            .map((m) => ({
                role: m.role as "user" | "assistant",
                content: m.content,
            }));

        return {
            protocol: "openai",
            model: req.model || "auto",
            messages: nonSystemMessages,
            system: systemMsg?.content,
            stream: req.stream ?? false,
            maxTokens: req.max_tokens,
            temperature: req.temperature,
            hasTools: Array.isArray(req.tools) && req.tools.length > 0,
            tools: req.tools,
            rawBody: body,
            rawHeaders: headers,
        };
    }

    async forward(
        request: UnifiedRequest,
        providerConfig: ProviderConfig,
    ): Promise<ForwardResult> {
        // Passthrough: forward the raw OpenAI body as-is
        const rawBody = request.rawBody as OpenAIRequestBody;
        const upstreamBody = {
            ...rawBody,
            model: request.model, // Use router-selected model
        };

        const baseUrl = providerConfig.baseUrl.replace(/\/+$/, "");
        const url = `${baseUrl}/chat/completions`;
        const timeoutMs = providerConfig.timeoutMs ?? 300_000;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${providerConfig.apiKey}`,
        };

        try {
            const response = await fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify(upstreamBody),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

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
                        error: { message: `Upstream timed out after ${timeoutMs}ms`, type: "timeout_error" },
                    }),
                    isStream: false,
                };
            }
            return {
                status: 502,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    error: { message: error instanceof Error ? error.message : "Unknown error", type: "api_error" },
                }),
                isStream: false,
            };
        }
    }
}
