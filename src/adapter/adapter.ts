/**
 * Protocol Adapter Interface (Strategy Pattern)
 *
 * Each adapter converts between a specific protocol (Anthropic, OpenAI, etc.)
 * and the unified internal format. Factory creates the right adapter
 * based on protocol type detected from the request path.
 */

import type { UnifiedRequest, ProtocolType } from "./types.js";

// ─── Forward Result ───

export interface ForwardResult {
    status: number;
    headers: Record<string, string>;
    body: ReadableStream<Uint8Array> | string;
    isStream: boolean;
}

// ─── Protocol Adapter Interface (Strategy Pattern) ───

export interface ProtocolAdapter {
    /** Protocol this adapter handles */
    readonly protocol: ProtocolType;

    /**
     * Convert incoming request to unified format.
     * This is the "translate in" step.
     * @param body - Raw request body
     * @param headers - Raw request headers
     */
    toUnified(body: unknown, headers: Record<string, string | undefined>): UnifiedRequest;

    /**
     * Forward a unified request to the upstream provider.
     * Handles protocol-specific formatting, auth, and streaming.
     * @param request - Unified request (with model already set by router)
     * @param providerConfig - Provider configuration
     */
    forward(
        request: UnifiedRequest,
        providerConfig: ProviderConfig,
    ): Promise<ForwardResult>;
}

// ─── Provider Config ───

export interface ProviderConfig {
    baseUrl: string;
    apiKey: string;
    timeoutMs?: number;
    /** When true, inject `stream_options.include_usage` into OpenAI streaming requests. */
    injectStreamUsage?: boolean;
}

// ─── Adapter Factory (Factory Pattern) ───

const adapterRegistry = new Map<ProtocolType, () => ProtocolAdapter>();

/**
 * Register an adapter factory for a protocol type.
 * Call this at module init time.
 */
export function registerAdapter(protocol: ProtocolType, factory: () => ProtocolAdapter): void {
    adapterRegistry.set(protocol, factory);
}

/**
 * Create an adapter for the given protocol.
 * Throws if no adapter is registered for the protocol.
 */
export function createAdapter(protocol: ProtocolType): ProtocolAdapter {
    const factory = adapterRegistry.get(protocol);
    if (!factory) {
        throw new Error(`No adapter registered for protocol: ${protocol}`);
    }
    return factory();
}

// ─── Protocol Detection ───

/**
 * Detect protocol type from the request URL path.
 * O(1) string matching — no regex, no parsing overhead.
 *
 * Supports both:
 *   - Agent-prefixed: /anthropic/v1/messages, /openclaw/v1/chat/completions
 *   - Standard:       /v1/messages, /v1/chat/completions
 */
export function detectProtocol(path: string): ProtocolType | null {
    if (path.includes("/v1/messages")) return "anthropic";
    if (path.includes("/v1/chat/completions")) return "openai";
    return null;
}

/**
 * Extract agent name from URL prefix.
 * Returns null for standard (non-prefixed) paths.
 *
 * Examples:
 *   /anthropic/v1/messages     → "anthropic"
 *   /openclaw/v1/chat/...      → "openclaw"
 *   /cursor/v1/chat/...        → "cursor"
 *   /v1/messages               → null (standard path)
 *   /v1/chat/completions       → null (standard path)
 */
export function extractAgentFromPath(path: string): string | null {
    // Standard paths start with /v1/
    if (path.startsWith("/v1/")) return null;
    // Agent-prefixed: /<agent>/v1/...
    const match = path.match(/^\/([^/]+)\/v1\//);
    return match ? match[1] : null;
}
