import { describe, test, expect } from "vitest";
import {
    ConfigurationError,
    isConfigurationError,
    ProviderError,
    isProviderError,
    ClassificationError,
    isClassificationError,
    RoutingError,
    isRoutingError,
} from "./errors.js";

describe("NexusRouter Error Types", () => {
    describe("ConfigurationError", () => {
        test("should have CONFIGURATION_ERROR code", () => {
            const err = new ConfigurationError("bad config");
            expect(err.code).toBe("CONFIGURATION_ERROR");
        });

        test("should inherit Error and set correct name", () => {
            const err = new ConfigurationError("missing field");
            expect(err).toBeInstanceOf(Error);
            expect(err.name).toBe("ConfigurationError");
            expect(err.message).toBe("missing field");
        });

        test("should support optional path field", () => {
            const err = new ConfigurationError("invalid value", "router.port");
            expect(err.path).toBe("router.port");
        });

        test("isConfigurationError type guard works correctly", () => {
            const err = new ConfigurationError("test");
            expect(isConfigurationError(err)).toBe(true);
            expect(isConfigurationError(new Error("test"))).toBe(false);
            expect(isConfigurationError("string")).toBe(false);
            expect(isConfigurationError(null)).toBe(false);
        });
    });

    describe("ProviderError", () => {
        test("should have PROVIDER_ERROR code and provider field", () => {
            const err = new ProviderError("timeout", "openai");
            expect(err.code).toBe("PROVIDER_ERROR");
            expect(err.provider).toBe("openai");
        });

        test("should inherit Error and set correct name", () => {
            const err = new ProviderError("rate limited", "anthropic", 429);
            expect(err).toBeInstanceOf(Error);
            expect(err.name).toBe("ProviderError");
            expect(err.message).toBe("rate limited");
        });

        test("should support optional statusCode", () => {
            const err = new ProviderError("error", "google", 500);
            expect(err.statusCode).toBe(500);

            const err2 = new ProviderError("error", "google");
            expect(err2.statusCode).toBeUndefined();
        });

        test("isProviderError type guard works correctly", () => {
            const err = new ProviderError("test", "openai");
            expect(isProviderError(err)).toBe(true);
            expect(isProviderError(new Error("test"))).toBe(false);
        });
    });

    describe("ClassificationError", () => {
        test("should have CLASSIFICATION_ERROR code and layer field", () => {
            const err = new ClassificationError("failed", "heuristic");
            expect(err.code).toBe("CLASSIFICATION_ERROR");
            expect(err.layer).toBe("heuristic");
        });

        test("should inherit Error and set correct name", () => {
            const err = new ClassificationError("timeout", "ai");
            expect(err).toBeInstanceOf(Error);
            expect(err.name).toBe("ClassificationError");
        });

        test("should accept all valid layer types", () => {
            expect(new ClassificationError("a", "rule").layer).toBe("rule");
            expect(new ClassificationError("b", "heuristic").layer).toBe("heuristic");
            expect(new ClassificationError("c", "ai").layer).toBe("ai");
        });

        test("isClassificationError type guard works correctly", () => {
            const err = new ClassificationError("test", "rule");
            expect(isClassificationError(err)).toBe(true);
            expect(isClassificationError(new Error("test"))).toBe(false);
        });
    });

    describe("RoutingError", () => {
        test("should have ROUTING_ERROR code", () => {
            const err = new RoutingError("no model found");
            expect(err.code).toBe("ROUTING_ERROR");
        });

        test("should inherit Error and set correct name", () => {
            const err = new RoutingError("no fallback");
            expect(err).toBeInstanceOf(Error);
            expect(err.name).toBe("RoutingError");
        });

        test("should support optional tier and model fields", () => {
            const err = new RoutingError("failed", "COMPLEX", "openai/gpt-4o");
            expect(err.tier).toBe("COMPLEX");
            expect(err.model).toBe("openai/gpt-4o");
        });

        test("should work with no optional fields", () => {
            const err = new RoutingError("generic error");
            expect(err.tier).toBeUndefined();
            expect(err.model).toBeUndefined();
        });

        test("isRoutingError type guard works correctly", () => {
            const err = new RoutingError("test");
            expect(isRoutingError(err)).toBe(true);
            expect(isRoutingError(new Error("test"))).toBe(false);
        });
    });
});
