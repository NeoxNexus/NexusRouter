/**
 * Typed Error Classes for NexusRouter
 *
 * Provides structured errors for configuration, provider, classification,
 * and routing failures with all necessary context for debugging.
 */

/**
 * Thrown when configuration is invalid or missing required fields.
 */
export class ConfigurationError extends Error {
  readonly code = "CONFIGURATION_ERROR" as const;
  readonly path?: string;

  constructor(message: string, path?: string) {
    super(message);
    this.name = "ConfigurationError";
    this.path = path;
  }
}

/**
 * Thrown when an upstream LLM provider returns an error.
 */
export class ProviderError extends Error {
  readonly code = "PROVIDER_ERROR" as const;
  readonly provider: string;
  readonly statusCode?: number;

  constructor(message: string, provider: string, statusCode?: number) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.statusCode = statusCode;
  }
}

/**
 * Thrown when the classification layer fails.
 */
export class ClassificationError extends Error {
  readonly code = "CLASSIFICATION_ERROR" as const;
  readonly layer: "rule" | "heuristic" | "ai";

  constructor(message: string, layer: "rule" | "heuristic" | "ai") {
    super(message);
    this.name = "ClassificationError";
    this.layer = layer;
  }
}

/**
 * Thrown when routing fails (no model found, fallback exhausted, etc).
 */
export class RoutingError extends Error {
  readonly code = "ROUTING_ERROR" as const;
  readonly tier?: string;
  readonly model?: string;

  constructor(message: string, tier?: string, model?: string) {
    super(message);
    this.name = "RoutingError";
    this.tier = tier;
    this.model = model;
  }
}

// ─── Type Guards ───

export function isConfigurationError(error: unknown): error is ConfigurationError {
  return error instanceof Error && (error as ConfigurationError).code === "CONFIGURATION_ERROR";
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof Error && (error as ProviderError).code === "PROVIDER_ERROR";
}

export function isClassificationError(error: unknown): error is ClassificationError {
  return error instanceof Error && (error as ClassificationError).code === "CLASSIFICATION_ERROR";
}

export function isRoutingError(error: unknown): error is RoutingError {
  return error instanceof Error && (error as RoutingError).code === "ROUTING_ERROR";
}
