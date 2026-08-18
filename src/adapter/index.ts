/**
 * Adapter Module Entry Point
 *
 * Re-exports all adapter components for clean imports.
 */

export type { UnifiedRequest, UnifiedMessage, AgentHints, ClassifierWeights, ProtocolType } from "./types.js";
export type { ProtocolAdapter, ForwardResult, ProviderConfig } from "./adapter.js";
export { registerAdapter, createAdapter, detectProtocol, extractAgentFromPath } from "./adapter.js";
export { AnthropicAdapter } from "./anthropic.js";
export { OpenAIAdapter } from "./openai.js";
export type { AgentProfile } from "./profile.js";
export {
    registerProfile,
    getProfile,
    resolveProfile,
    getHintsAndWeights,
    sanitizeForClassification,
    claudeCodeProfile,
    openClawProfile,
} from "./profile.js";
