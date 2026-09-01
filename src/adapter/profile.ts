/**
 * Agent Profile System (Plugin Pattern)
 *
 * Each agent (Claude Code, OpenClaw, Cursor, etc.) can have a profile
 * that provides optional hints to influence classification.
 *
 * Profiles produce AgentHints and compute dynamic weights that determine
 * how much the hint vs the 15-dimension classifier influence the final
 * routing decision.
 *
 * Design principle: the system works WITHOUT any profiles registered —
 * it degrades to pure classifier-based routing (which is what OpenClaw uses).
 */

import type { UnifiedRequest, AgentHints, ClassifierWeights, ProtocolType } from "./types.js";

// ─── Agent Profile Interface ───

export interface AgentProfile {
  /** Unique agent name */
  name: string;
  /** Protocol this agent speaks */
  protocolType: ProtocolType;
  /**
   * Extract agent-specific hints from the request.
   * These hints get passed alongside the classifier result
   * to influence the final routing decision.
   */
  extractHints?(request: UnifiedRequest): AgentHints;
  /**
   * Compute dynamic weights based on the extracted hints.
   * If not provided, defaults to { hintWeight: 0, classifierWeight: 1 }.
   */
  computeWeights?(hints: AgentHints): ClassifierWeights;
  /**
   * Strip host-injected boilerplate before the text reaches the classifier.
   * Only the classifier's input is affected — the body forwarded upstream
   * keeps the original text. If not provided, text passes through unchanged.
   */
  sanitizeForClassification?(text: string): string;
  /**
   * Recognize a host-injected skill document (an invoked skill's SKILL.md
   * delivered as a plain user message) and return the skill's name, or null
   * when the text is not a skill injection. The classifier must never score
   * the skill body itself (D-009): the body is a static procedure document
   * whose keywords ("proves", "trade-offs") say nothing about the task at
   * hand. The caller skips the message and keeps the name as a structured
   * observability signal.
   */
  matchSkillInjection?(text: string): string | null;
}

// ─── Default Weights ───

const DEFAULT_WEIGHTS: ClassifierWeights = {
  hintWeight: 0,
  classifierWeight: 1,
};

// ─── Agent Registry (Plugin Pattern) ───

const profileRegistry = new Map<string, AgentProfile>();

export function registerProfile(profile: AgentProfile): void {
  profileRegistry.set(profile.name, profile);
}

export function getProfile(name: string): AgentProfile | undefined {
  return profileRegistry.get(name);
}

export function getAllProfiles(): AgentProfile[] {
  return Array.from(profileRegistry.values());
}

// ─── Built-in Profiles ───

/**
 * Claude Code Agent Profile
 *
 * Claude Code's model selection provides useful signals:
 * - Requesting haiku = background task (high confidence hint)
 * - Enabling thinking = reasoning mode (medium confidence)
 * - Default sonnet = no signal (let classifier decide)
 */
export const claudeCodeProfile: AgentProfile = {
  name: "claude-code",
  protocolType: "anthropic",

  extractHints(request: UnifiedRequest): AgentHints {
    const model = request.model?.toLowerCase() || "";
    const rawBody = request.rawBody as Record<string, unknown> | undefined;

    return {
      isBackgroundTask: model.includes("haiku"),
      preferThinking: !!rawBody?.thinking,
    };
  },

  computeWeights(hints: AgentHints): ClassifierWeights {
    // Background task (haiku) — high confidence hint
    if (hints.isBackgroundTask) {
      return { hintWeight: 0.8, classifierWeight: 0.2 };
    }
    // Thinking mode — medium confidence
    if (hints.preferThinking) {
      return { hintWeight: 0.5, classifierWeight: 0.5 };
    }
    // Default (sonnet) — classifier is king
    return { hintWeight: 0.1, classifierWeight: 0.9 };
  },

  sanitizeForClassification(text: string): string {
    // Claude Code hooks inject <system-reminder> blocks into the user
    // turn (skill lists, hook output, permission instructions). They are
    // host boilerplate, not user intent — but they dominate keyword
    // matching (e.g. the skill list always contains "improve"). Strip
    // only fully-closed blocks; an unterminated tag is left untouched
    // rather than risking eating the user's own text.
    return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
  },

  matchSkillInjection(text: string): string | null {
    // Invoking a skill delivers its SKILL.md as a plain user message with
    // no <system-reminder> wrapper: a "Base directory for this skill: <path>"
    // header followed by the document body (D-009: 67/1114 logged requests
    // scored this body, e.g. "proves" → REASONING ×33). Exact-case match —
    // the header string is emitted verbatim by the host. The skill name is
    // the last path segment; both / and \ separators occur in real traffic.
    const match = /^Base directory for this skill:\s*(\S+)/.exec(text);
    if (!match) return null;
    const segments = match[1].split(/[/\\]/).filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : null;
  },
};

/**
 * OpenClaw Agent Profile
 *
 * OpenClaw speaks OpenAI protocol and doesn't provide
 * agent-specific signals. Pure classifier routing.
 */
export const openClawProfile: AgentProfile = {
  name: "openclaw",
  protocolType: "openai",
  // No extractHints — defaults to { hintWeight: 0, classifierWeight: 1 }
};

/**
 * Generic OpenAI Agent Profile (Cursor, etc.)
 */
export const genericOpenAIProfile: AgentProfile = {
  name: "openai",
  protocolType: "openai",
};

// ─── Resolve Profile from Agent Name ───

/**
 * Map URL prefix to agent profile name.
 * Falls back to protocol-based defaults.
 */
const agentPrefixMap: Record<string, string> = {
  anthropic: "claude-code",
  openclaw: "openclaw",
  openai: "openai",
  cursor: "openai", // Cursor uses OpenAI protocol
};

export function resolveProfile(
  agentPrefix: string | null,
  protocol: "anthropic" | "openai",
): AgentProfile {
  if (agentPrefix) {
    const profileName = agentPrefixMap[agentPrefix];
    if (profileName) {
      const profile = getProfile(profileName);
      if (profile) return profile;
    }
  }
  // Fallback: protocol-based defaults
  if (protocol === "anthropic") return getProfile("claude-code") || claudeCodeProfile;
  return getProfile("openclaw") || openClawProfile;
}

/**
 * Get hints and weights from a profile.
 * Safely handles missing methods with defaults.
 */
export function getHintsAndWeights(
  profile: AgentProfile,
  request: UnifiedRequest,
): { hints: AgentHints; weights: ClassifierWeights } {
  const hints = profile.extractHints?.(request) ?? {};
  const weights = profile.computeWeights?.(hints) ?? DEFAULT_WEIGHTS;
  return { hints, weights };
}

/**
 * Prepare the text that reaches the classifier for a given profile.
 *
 * Hosts inject boilerplate into the user turn (Claude Code hooks append
 * <system-reminder> blocks with skill lists and hook output). Those blocks
 * are host machinery, not user intent — but a keyword classifier reads them
 * as the prompt itself. Profiles may strip such blocks via the optional
 * `sanitizeForClassification` hook; profiles without one pass text through
 * unchanged.
 *
 * IMPORTANT: this only shapes the classifier's input. The body forwarded
 * upstream always keeps the original text, byte for byte.
 */
export function sanitizeForClassification(profile: AgentProfile, text: string): string {
  return profile.sanitizeForClassification?.(text) ?? text;
}

// ─── Auto-register built-in profiles ───

registerProfile(claudeCodeProfile);
registerProfile(openClawProfile);
registerProfile(genericOpenAIProfile);
