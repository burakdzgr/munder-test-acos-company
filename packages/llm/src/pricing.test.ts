// B1 (2026-08-15 code review) regression: ModelRouter was built without any
// pricing, so costCents was always 0 — recordCost() was never reached, no LLM
// cost_entries were written, and the budget guard + company circuit breaker
// were dead (INV-19). These tests pin the two properties that failure needed:
// pricing actually reaches the router, and it resolves PER MODEL (26 §3.1) —
// a per-provider flat rate cannot tell sonnet from haiku.
import { describe, expect, it } from "vitest";
import { ModelRouter, type ProviderAdapter } from "./router.js";
import { ANTHROPIC_PRICING, pricingDefaultsFor } from "./pricing-defaults.js";
import {
  resolveProviderPricing,
  type LlmCallLogEntry,
  type LlmUsage,
  type ProviderPricingEntry,
} from "./types.js";

const USAGE: LlmUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 0 };

const adapter: ProviderAdapter = {
  providerId: "anthropic",
  async complete() {
    return { text: "ok", usage: USAGE, finishReason: "stop" };
  },
  async embed() {
    return { embedding: [0.1], usage: USAGE };
  },
};

function routerWith(pricing: ReadonlyMap<string, ProviderPricingEntry>, log: LlmCallLogEntry[]) {
  return new ModelRouter({
    providers: new Map([["anthropic", adapter]]),
    pricing,
    logCall: (entry) => {
      log.push(entry);
    },
    now: () => 0,
  });
}

function routingFor(model: string) {
  return { bindings: [], profiles: [{ purpose: "reasoning" as const, providerId: "anthropic", model }] };
}

const PRICED = new Map<string, ProviderPricingEntry>([["anthropic", ANTHROPIC_PRICING]]);

describe("pricing reaches the router (INV-19)", () => {
  it("produces a non-zero cost once a pricing map is supplied", async () => {
    const log: LlmCallLogEntry[] = [];
    const result = await routerWith(PRICED, log).complete(
      { purpose: "reasoning", messages: [{ role: "user", content: "hi" }] },
      routingFor("claude-sonnet-4-5"),
    );
    // 1M input @300 + 1M output @1500 = 1800 cents
    expect(result.costCents).toBe(1800);
    expect(log[0]?.costCents).toBe(1800);
  });

  it("costs 0 without a pricing map — the exact B1 defect", async () => {
    const log: LlmCallLogEntry[] = [];
    const router = new ModelRouter({
      providers: new Map([["anthropic", adapter]]),
      logCall: (entry) => {
        log.push(entry);
      },
      now: () => 0,
    });
    const result = await router.complete(
      { purpose: "reasoning", messages: [{ role: "user", content: "hi" }] },
      routingFor("claude-sonnet-4-5"),
    );
    expect(result.costCents).toBe(0);
  });
});

describe("pricing resolves per model, not per provider (26 §3.1)", () => {
  it("charges sonnet and haiku differently through the same provider row", async () => {
    const log: LlmCallLogEntry[] = [];
    const router = routerWith(PRICED, log);
    const req = { purpose: "reasoning" as const, messages: [{ role: "user", content: "hi" }] };

    const sonnet = await router.complete(req, routingFor("claude-sonnet-4-5"));
    const haiku = await router.complete(req, routingFor("claude-haiku-4-5"));
    const opus = await router.complete(req, routingFor("claude-opus-5"));

    expect(sonnet.costCents).toBe(1800); // 300 + 1500
    expect(haiku.costCents).toBe(600); // 100 + 500
    expect(opus.costCents).toBe(3000); // 500 + 2500
    // the regression guard: a flat per-provider rate would collapse these
    expect(new Set([sonnet.costCents, haiku.costCents, opus.costCents]).size).toBe(3);
  });

  it("prices an unknown model at 0 rather than inventing a rate", async () => {
    const log: LlmCallLogEntry[] = [];
    const result = await routerWith(PRICED, log).complete(
      { purpose: "reasoning", messages: [{ role: "user", content: "hi" }] },
      routingFor("claude-not-a-real-model"),
    );
    expect(result.costCents).toBe(0);
  });

  it("applies the cached-input discount from the model entry", async () => {
    const cached: LlmUsage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    };
    const cachedAdapter: ProviderAdapter = {
      providerId: "anthropic",
      async complete() {
        return { text: "ok", usage: cached, finishReason: "stop" };
      },
      async embed() {
        return { embedding: [0.1], usage: cached };
      },
    };
    const router = new ModelRouter({
      providers: new Map([["anthropic", cachedAdapter]]),
      pricing: PRICED,
      logCall: () => {},
      now: () => 0,
    });
    const result = await router.complete(
      { purpose: "reasoning", messages: [{ role: "user", content: "hi" }] },
      routingFor("claude-sonnet-4-5"),
    );
    expect(result.costCents).toBe(30); // all input cached @30, no fresh input
  });
});

describe("resolveProviderPricing", () => {
  it("keeps a bare ProviderPricing provider-wide (backward compatible)", () => {
    const flat = { inputPerMTokCents: 300, outputPerMTokCents: 1500, cachedInputPerMTokCents: 30 };
    expect(resolveProviderPricing(flat, "anything-at-all")).toBe(flat);
  });

  it("falls back to the table default when the model has no entry", () => {
    const fallback = { inputPerMTokCents: 7, outputPerMTokCents: 9, cachedInputPerMTokCents: 1 };
    const table = { models: {}, default: fallback };
    expect(resolveProviderPricing(table, "unknown")).toBe(fallback);
  });

  it("returns null for an unpriced model and for no entry at all", () => {
    expect(resolveProviderPricing({ models: {} }, "unknown")).toBeNull();
    expect(resolveProviderPricing(undefined, "unknown")).toBeNull();
  });
});

describe("pricingDefaultsFor", () => {
  it("ships rates for the API providers", () => {
    expect(pricingDefaultsFor("anthropic")?.models["claude-opus-5"]?.inputPerMTokCents).toBe(500);
    expect(pricingDefaultsFor("openai")?.models["text-embedding-3-small"]?.outputPerMTokCents).toBe(0);
  });

  it("ships none for ollama/vLLM — zero API price, billed as compute (26 §3.2)", () => {
    expect(pricingDefaultsFor("ollama")).toBeUndefined();
    expect(pricingDefaultsFor("vllm")).toBeUndefined();
  });
});
