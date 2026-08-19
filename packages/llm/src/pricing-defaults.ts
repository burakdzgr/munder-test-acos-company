// Seed pricing tables (26 §3.1). Rates are cents per million tokens, matching
// the `in_per_mtok_cents` / `out_per_mtok_cents` / `cached_in_per_mtok_cents`
// JSONB fields of 26 §3.1 field-for-field — when `model_providers.pricing`
// lands, these become the seeded defaults and the column overrides them at
// runtime (prices are read at call time and denormalized onto
// llm_calls.cost_cents; historical entries never re-price).
//
// B1 (2026-08-15 code review): ModelRouter was constructed without any pricing,
// so every call cost 0 — which meant recordCost() was never reached, no
// LLM cost_entries were ever written, and the budget guard plus company
// circuit breaker were dead (INV-19).
import type { ProviderPricing, ProviderPricingTable } from "./types.js";

const rate = (
  inputPerMTokCents: number,
  outputPerMTokCents: number,
  cachedInputPerMTokCents: number,
): ProviderPricing => ({ inputPerMTokCents, outputPerMTokCents, cachedInputPerMTokCents });

/** Anthropic list prices; cached input ≈ 10% of fresh input. */
export const ANTHROPIC_PRICING: ProviderPricingTable = {
  models: {
    "claude-opus-5": rate(500, 2500, 50),
    "claude-sonnet-5": rate(300, 1500, 30),
    "claude-sonnet-4-5": rate(300, 1500, 30),
    "claude-haiku-4-5": rate(100, 500, 10),
    // dated alias the seed pins by default (apps/server/src/seed.ts)
    "claude-haiku-4-5-20251001": rate(100, 500, 10),
  },
};

/** OpenAI: embeddings only in this stack (12 §5.4 semantic lane). */
export const OPENAI_PRICING: ProviderPricingTable = {
  models: { "text-embedding-3-small": rate(2, 0, 0) },
};

/**
 * Scripted lane (32 §6). The fake adapter burns no real tokens, but pricing it
 * keeps the accounting path — cost_entries, budget guard, circuit breaker —
 * exercised end to end in the e2e/demo profile instead of short-circuiting on
 * cost 0. Sonnet-equivalent rates so demo numbers look plausible.
 */
export const SCRIPTED_PRICING: ProviderPricingTable = {
  models: { scripted: rate(300, 1500, 30) },
};

/**
 * Defaults per `model_providers.kind`. Ollama/vLLM are deliberately absent:
 * they have zero API price and surface as **compute** instead (26 §3.1/§3.2),
 * so "offline mode is not free" stays visible. OpenRouter is absent because its
 * rates vary per upstream model — configure it explicitly rather than guess.
 */
const DEFAULTS_BY_KIND: Readonly<Record<string, ProviderPricingTable>> = {
  anthropic: ANTHROPIC_PRICING,
  openai: OPENAI_PRICING,
};

/** Seed table for a provider kind, or undefined when we ship no rates for it. */
export function pricingDefaultsFor(kind: string): ProviderPricingTable | undefined {
  return DEFAULTS_BY_KIND[kind];
}
