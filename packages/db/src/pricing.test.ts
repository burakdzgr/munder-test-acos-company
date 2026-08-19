// A1 (26 §3.1): the stored JSONB document → router port shape translation.
// The router's own lookup is covered by packages/llm/src/pricing.test.ts; what
// is proven here is that a price list written in the DOCUMENT shape
// (snake_case, model-keyed) survives the round trip, and that an empty column
// yields "no entry" so callers fall back to their compile-time defaults.
import { describe, expect, it } from "vitest";
import { parseStoredPricing } from "./pricing.js";

describe("parseStoredPricing (26 §3.1)", () => {
  it("translates the documented JSONB shape into per-model rates", () => {
    const parsed = parseStoredPricing({
      models: {
        "claude-sonnet-4-5": {
          in_per_mtok_cents: 300,
          out_per_mtok_cents: 1500,
          cached_in_per_mtok_cents: 30,
        },
        "claude-haiku-4-5": {
          in_per_mtok_cents: 100,
          out_per_mtok_cents: 500,
          cached_in_per_mtok_cents: 10,
        },
      },
      updated_at: "2026-08-15",
      source: "manual",
    });
    expect(parsed?.models["claude-sonnet-4-5"]).toEqual({
      inputPerMTokCents: 300,
      outputPerMTokCents: 1500,
      cachedInputPerMTokCents: 30,
    });
    // the whole point of a model-keyed table: one provider row, different rates
    expect(parsed?.models["claude-haiku-4-5"]?.inputPerMTokCents).toBe(100);
  });

  it("keeps a provider-wide default when the document carries one", () => {
    const parsed = parseStoredPricing({
      models: {},
      default: { in_per_mtok_cents: 250, out_per_mtok_cents: 1000 },
    });
    expect(parsed?.default).toEqual({
      inputPerMTokCents: 250,
      outputPerMTokCents: 1000,
      cachedInputPerMTokCents: 0,
    });
  });

  it("returns null for the empty column default so callers fall back to defaults", () => {
    expect(parseStoredPricing({})).toBeNull();
    expect(parseStoredPricing(null)).toBeNull();
    expect(parseStoredPricing({ models: {} })).toBeNull();
  });

  it("ignores malformed rates instead of inventing a price", () => {
    const parsed = parseStoredPricing({
      models: {
        good: { in_per_mtok_cents: 10 },
        bogus: { in_per_mtok_cents: "free" },
        negative: { in_per_mtok_cents: -5 },
      },
    });
    expect(Object.keys(parsed?.models ?? {})).toEqual(["good"]);
    expect(parsed?.models.good).toEqual({
      inputPerMTokCents: 10,
      outputPerMTokCents: 0,
      cachedInputPerMTokCents: 0,
    });
  });
});
