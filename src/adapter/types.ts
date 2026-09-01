/**
 * Unified Request/Response Types for NexusRouter Adapter Layer
 *
 * These types provide a protocol-agnostic internal representation
 * that the classifier and router operate on. Protocol-specific
 * adapters convert to/from these types.
 */

// ─── Protocol Type ───

export type ProtocolType = "anthropic" | "openai";

// ─── Unified Message ───

export type UnifiedRole = "user" | "assistant" | "system";

export interface UnifiedMessage {
  role: UnifiedRole;
  /** Plain text content (extracted from content blocks if needed) */
  content: string;
  /** Raw content blocks preserved for passthrough scenarios */
  rawContent?: unknown;
}

// ─── Unified Request ───

export interface UnifiedRequest {
  /** Original protocol type */
  protocol: ProtocolType;
  /** Requested model (may be "auto" for routing) */
  model: string;
  /** Normalized messages */
  messages: UnifiedMessage[];
  /** System prompt (if any) */
  system?: string;
  /** Whether streaming is requested */
  stream: boolean;
  /** Max tokens to generate */
  maxTokens?: number;
  /** Temperature */
  temperature?: number;
  /** Whether tools are present */
  hasTools: boolean;
  /** Tool definitions (preserved for forwarding) */
  tools?: unknown[];
  /** Full raw request body (preserved for passthrough) */
  rawBody: unknown;
  /** Original request headers */
  rawHeaders: Record<string, string | undefined>;
}

// ─── Agent Hints ───

export interface AgentHints {
  /** Agent explicitly requested a background/cheap model */
  isBackgroundTask?: boolean;
  /** Agent requested thinking/reasoning mode */
  preferThinking?: boolean;
  /** Estimated token count */
  tokenCount?: number;
  /** Agent-specific custom tags */
  customTags?: string[];
}

// ─── Classifier Weights ───

export interface ClassifierWeights {
  /** Weight for agent hints (0.0 - 1.0) */
  hintWeight: number;
  /** Weight for 15-dim classifier (0.0 - 1.0) */
  classifierWeight: number;
}
