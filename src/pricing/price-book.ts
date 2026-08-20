/**
 * Price book — tiered token pricing (Savings Ledger 决策 2).
 *
 * `cost = ( in_uncached    × P_in
 *         + cache_read     × P_in × 0.10
 *         + cache_write_5m × P_in × 1.25
 *         + cache_write_1h × P_in × 2.00
 *         + out            × P_out ) / 1e6`
 *
 * Two rules carry the whole module:
 *
 * 1. **An unknown model returns `null`, never `0`.** A zero would silently
 *    become the conclusion "this request was free", which is exactly the
 *    fabricated-dollars defect this ledger exists to remove. `0` is reserved
 *    for models that genuinely cost nothing (the NVIDIA free tier).
 * 2. **Cache reads are 0.1× input.** In long Claude Code sessions cache reads
 *    are routinely 90%+ of input tokens, so pricing them at full rate — or at
 *    zero, as `models.ts` currently does — is wrong by an order of magnitude.
 *
 * Prices come from the product registry (`models.ts`) and may be overridden per
 * deployment. The override path exists because gateway-specific rates are
 * deployment data, not product data: the four `claude-opus-*` tiers in the repo
 * `config.yaml` are served by a third-party gateway whose rates this repository
 * has no honest way to know. Unknown stays `null` until someone who knows the
 * real number supplies it.
 */

import { MODELS, MODEL_ALIASES } from "../models.js";

/** Token counts split by how each tier is billed. */
export type TokenUsage = {
  /** Input tokens billed at full rate (not served from cache). */
  inputUncached: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
};

/** Multipliers are relative to the model's input price. */
export type CacheMultipliers = {
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
};

/** A fully resolved price: USD per 1M tokens plus cache multipliers. */
export type ModelPrice = { input: number; output: number } & CacheMultipliers;

/** Per-deployment price entry. Multipliers are optional and default to Anthropic's. */
export type PriceOverride = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
};

export type PriceOverrides = Record<string, PriceOverride | undefined>;

/**
 * Anthropic's published cache multipliers, used whenever a price source does
 * not state its own. A missing 1h multiplier falls back to 2× rather than
 * dropping those tokens: silently understating cost is the worse failure.
 */
export const DEFAULT_CACHE_MULTIPLIERS: CacheMultipliers = {
  cacheRead: 0.1,
  cacheWrite5m: 1.25,
  cacheWrite1h: 2.0,
};

/**
 * Routing placeholders, not real models. They carry `inputPrice: 0` in the
 * registry, so without this set `costOf(usage, "auto")` would report $0 for a
 * request that really cost money.
 */
const META_MODEL_IDS = new Set(["auto", "free", "eco", "premium"]);

/**
 * True for routing placeholders like `auto`, where the request carries no
 * counterfactual model at all. Callers must treat this differently from a model
 * that is real but simply unpriced — the first has no answer, the second has an
 * answer nobody has supplied yet.
 */
export function isRoutingPlaceholder(modelId: string): boolean {
  return META_MODEL_IDS.has(normalize(modelId));
}

/** Zero-filled usage, handy for callers that accumulate into it. */
export function emptyUsage(): TokenUsage {
  return { inputUncached: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

type BasePrice = { input: number; output: number };

/** id → price, meta models excluded. */
const byId = new Map<string, BasePrice>();
/** bare model name (no provider prefix) → id, only where unambiguous. */
const byBareName = new Map<string, string | null>();

for (const m of MODELS) {
  if (META_MODEL_IDS.has(m.id)) continue;
  byId.set(m.id, { input: m.inputPrice, output: m.outputPrice });

  const bare = bareName(m.id);
  if (bare === m.id) continue;
  // `null` marks an ambiguous bare name (e.g. both moonshot/ and nvidia/ ship
  // kimi-k2.5). Guessing a provider there would quietly price the wrong model.
  byBareName.set(bare, byBareName.has(bare) ? null : m.id);
}

function bareName(id: string): string {
  const slash = id.indexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}

function normalize(modelId: string): string {
  return modelId.trim().toLowerCase();
}

function withDefaults(base: BasePrice, override?: PriceOverride): ModelPrice {
  return {
    input: base.input,
    output: base.output,
    cacheRead: override?.cacheRead ?? DEFAULT_CACHE_MULTIPLIERS.cacheRead,
    cacheWrite5m: override?.cacheWrite5m ?? DEFAULT_CACHE_MULTIPLIERS.cacheWrite5m,
    cacheWrite1h: override?.cacheWrite1h ?? DEFAULT_CACHE_MULTIPLIERS.cacheWrite1h,
  };
}

function findOverride(id: string, overrides?: PriceOverrides): PriceOverride | undefined {
  if (!overrides) return undefined;
  const exact = overrides[id];
  if (exact) return exact;

  const bare = bareName(id);
  for (const [key, value] of Object.entries(overrides)) {
    if (value && bareName(normalize(key)) === bare) return value;
  }
  return undefined;
}

/**
 * Resolve a model id to a full price, or `null` when nothing knows its rates.
 *
 * Lookup order: deployment override → registry id → alias → unambiguous bare
 * name. Meta models (`auto` / `eco` / `premium` / `free`) never resolve — the
 * caller wants the concrete model that actually ran.
 */
export function resolvePrice(modelId: string, overrides?: PriceOverrides): ModelPrice | null {
  const id = normalize(modelId);
  if (!id) return null;

  const override = findOverride(id, overrides);
  if (override) return withDefaults(override, override);

  if (META_MODEL_IDS.has(id)) return null;

  const direct = byId.get(id);
  if (direct) return withDefaults(direct);

  const aliased = MODEL_ALIASES[id];
  if (aliased) {
    const target = byId.get(normalize(aliased));
    if (target) return withDefaults(target);
  }

  const bareMatch = byBareName.get(bareName(id));
  if (bareMatch) {
    const target = byId.get(bareMatch);
    if (target) return withDefaults(target);
  }

  return null;
}

/** Clamp a reported token count: a malformed payload must not move the total. */
function tokens(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Cost of one request in USD, or `null` if the model's price is unknown.
 *
 * Pure function: no I/O, no clock, no config reads beyond the `overrides` it is
 * handed, so it is fully unit-testable and safe to call on the request path.
 */
export function costOf(
  usage: TokenUsage,
  modelId: string,
  overrides?: PriceOverrides,
): number | null {
  const price = resolvePrice(modelId, overrides);
  if (!price) return null;

  const inputUnits =
    tokens(usage.inputUncached) +
    tokens(usage.cacheRead) * price.cacheRead +
    tokens(usage.cacheWrite5m) * price.cacheWrite5m +
    tokens(usage.cacheWrite1h) * price.cacheWrite1h;

  return (inputUnits * price.input + tokens(usage.output) * price.output) / 1e6;
}
