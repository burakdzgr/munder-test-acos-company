// T29 acceptance: resolution unit tests incl. fallback — binding override
// precedes profiles, 429/5xx falls to the next provider, non-retryable errors
// never mask, every attempt is logged, token caps min-combine, cost math.
import { describe, expect, it } from "vitest";
import { ModelRouter, type ProviderAdapter } from "./router.js";
import { resolveTargets } from "./resolution.js";
import {
  LlmError,
  computeCostCents,
  type LlmCallLogEntry,
  type LlmUsage,
} from "./types.js";

const USAGE: LlmUsage = { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 100 };

type Script = Array<{ error?: LlmError; text?: string }>;

function fakeAdapter(providerId: string, script: Script) {
  const calls: Array<{ model: string; maxTokens?: number | undefined }> = [];
  const adapter: ProviderAdapter = {
    providerId,
    async complete(input) {
      calls.push({ model: input.model, maxTokens: input.maxTokens });
      const step = script.shift() ?? {};
      if (step.error) throw step.error;
      return { text: step.text ?? "ok", usage: USAGE, finishReason: "stop" };
    },
    async embed(input) {
      calls.push({ model: input.model });
      const step = script.shift() ?? {};
      if (step.error) throw step.error;
      return { embedding: [0.1, 0.2, 0.3], usage: USAGE };
    },
  };
  return { adapter, calls };
}

const BINDING = { purpose: "primary" as const, providerId: "anthropic", model: "claude-fable-5" };
const PROFILE_A = {
  purpose: "reasoning" as const,
  providerId: "anthropic",
  model: "claude-sonnet-5",
  priority: 0,
  maxTokensPerCall: 4000,
};
const PROFILE_B = {
  purpose: "reasoning" as const,
  providerId: "openrouter",
  model: "meta-llama/llama-4",
  priority: 1,
};

function makeRouter(adapters: ProviderAdapter[], log: LlmCallLogEntry[]) {
  return new ModelRouter({
    providers: new Map(adapters.map((a) => [a.providerId, a])),
    pricing: new Map([
      ["anthropic", { inputPerMTokCents: 300, outputPerMTokCents: 1500, cachedInputPerMTokCents: 30 }],
    ]),
    logCall: (entry) => {
      log.push(entry);
    },
    now: () => 0,
  });
}

describe("resolution chain (_DECISIONS §17)", () => {
  it("agent binding overrides company profiles; profiles are the fallback chain", () => {
    const targets = resolveTargets("reasoning", [BINDING], [PROFILE_A, PROFILE_B]);
    expect(targets.map((t) => `${t.providerId}:${t.model}:${t.source}`)).toEqual([
      "anthropic:claude-fable-5:binding",
      "anthropic:claude-sonnet-5:profile",
      "openrouter:meta-llama/llama-4:profile",
    ]);
  });

  it("maps reasoning/coding/vision onto the primary binding; fast/embedding onto theirs", () => {
    const bindings = [
      BINDING,
      { purpose: "fast" as const, providerId: "openai", model: "gpt-fast" },
      { purpose: "embedding" as const, providerId: "openai", model: "text-embedding-3-small" },
    ];
    expect(resolveTargets("coding", bindings, [])[0]!.model).toBe("claude-fable-5");
    expect(resolveTargets("fast", bindings, [])[0]!.model).toBe("gpt-fast");
    expect(resolveTargets("embedding", bindings, [])[0]!.model).toBe("text-embedding-3-small");
  });

  it("skips disabled profiles, sorts by priority, dedupes provider+model", () => {
    const targets = resolveTargets(
      "reasoning",
      [BINDING],
      [
        { ...PROFILE_B, priority: 0 },
        { ...PROFILE_A, priority: 1 },
        { purpose: "reasoning", providerId: "anthropic", model: "claude-fable-5", priority: 2 }, // dup of binding
        { purpose: "reasoning", providerId: "openai", model: "gpt-x", enabled: false },
      ],
    );
    expect(targets.map((t) => t.model)).toEqual([
      "claude-fable-5",
      "meta-llama/llama-4",
      "claude-sonnet-5",
    ]);
  });
});

describe("router fallback (429/5xx → next provider)", () => {
  it("falls back on rate_limited and succeeds on the next target, logging BOTH attempts", async () => {
    const log: LlmCallLogEntry[] = [];
    const anthropic = fakeAdapter("anthropic", [
      { error: new LlmError("rate_limited", "429", "anthropic") }, // binding target
      { text: "from sonnet" }, // profile target (same adapter)
    ]);
    const router = makeRouter([anthropic.adapter], log);
    const result = await router.complete(
      { purpose: "reasoning", messages: [{ role: "user", content: "hi" }] },
      { bindings: [BINDING], profiles: [PROFILE_A] },
    );
    expect(result.text).toBe("from sonnet");
    expect(result.model).toBe("claude-sonnet-5");
    expect(log.map((l) => `${l.model}:${l.status}`)).toEqual([
      "claude-fable-5:error",
      "claude-sonnet-5:ok",
    ]);
    expect(log[0]!.errorKind).toBe("rate_limited");
  });

  it("falls across providers on 5xx; exhausting the chain rethrows the last error", async () => {
    const log: LlmCallLogEntry[] = [];
    const anthropic = fakeAdapter("anthropic", [
      { error: new LlmError("provider_unavailable", "503", "anthropic") },
      { error: new LlmError("provider_unavailable", "503", "anthropic") },
    ]);
    const openrouter = fakeAdapter("openrouter", [
      { error: new LlmError("rate_limited", "429", "openrouter") },
    ]);
    const router = makeRouter([anthropic.adapter, openrouter.adapter], log);
    await expect(
      router.complete(
        { purpose: "reasoning", messages: [{ role: "user", content: "hi" }] },
        { bindings: [BINDING], profiles: [PROFILE_A, PROFILE_B] },
      ),
    ).rejects.toMatchObject({ kind: "rate_limited", providerId: "openrouter" });
    expect(log).toHaveLength(3); // every attempt accounted
    expect(log.every((l) => l.status === "error")).toBe(true);
  });

  it("does NOT fall back on bad_request or auth — our fault is never masked", async () => {
    const log: LlmCallLogEntry[] = [];
    const anthropic = fakeAdapter("anthropic", [
      { error: new LlmError("bad_request", "422", "anthropic") },
    ]);
    const openrouter = fakeAdapter("openrouter", []);
    const router = makeRouter([anthropic.adapter, openrouter.adapter], log);
    await expect(
      router.complete(
        { purpose: "reasoning", messages: [{ role: "user", content: "hi" }] },
        { bindings: [BINDING], profiles: [PROFILE_B] },
      ),
    ).rejects.toMatchObject({ kind: "bad_request" });
    expect(openrouter.calls).toHaveLength(0);
    expect(log).toHaveLength(1);
  });

  it("an unconfigured provider is skipped toward the next target", async () => {
    const log: LlmCallLogEntry[] = [];
    const openrouter = fakeAdapter("openrouter", [{ text: "fallback ok" }]);
    const router = makeRouter([openrouter.adapter], log); // anthropic missing
    const result = await router.complete(
      { purpose: "reasoning", messages: [{ role: "user", content: "hi" }] },
      { bindings: [BINDING], profiles: [PROFILE_B] },
    );
    expect(result.providerId).toBe("openrouter");
  });

  it("no resolvable target → no_target", async () => {
    const router = makeRouter([], []);
    await expect(
      router.complete(
        { purpose: "vision", messages: [{ role: "user", content: "hi" }] },
        { bindings: [], profiles: [] },
      ),
    ).rejects.toMatchObject({ kind: "no_target" });
  });
});

describe("token caps + cost accounting", () => {
  it("min-combines request, profile and router caps", async () => {
    const log: LlmCallLogEntry[] = [];
    const anthropic = fakeAdapter("anthropic", [{ text: "ok" }]);
    const router = new ModelRouter({
      providers: new Map([["anthropic", anthropic.adapter]]),
      logCall: (e) => {
        log.push(e);
      },
      defaultMaxTokens: 8000,
      now: () => 0,
    });
    await router.complete(
      { purpose: "reasoning", messages: [{ role: "user", content: "hi" }], maxTokens: 6000 },
      { bindings: [], profiles: [PROFILE_A] }, // profile cap 4000
    );
    expect(anthropic.calls[0]!.maxTokens).toBe(4000);
  });

  it("computes cost from the pricing table with the cached-token discount", () => {
    const pricing = { inputPerMTokCents: 300, outputPerMTokCents: 1500, cachedInputPerMTokCents: 30 };
    // 900 fresh in ×300 + 100 cached ×30 + 200 out ×1500 = 270000+3000+300000 per MTok
    expect(computeCostCents(USAGE, pricing)).toBe(Math.ceil(573_000 / 1_000_000));
    expect(computeCostCents(USAGE, null)).toBe(0);
  });

  it("embed() rides the same port with the same fallback + accounting", async () => {
    const log: LlmCallLogEntry[] = [];
    const openai = fakeAdapter("openai", [{ text: "ignored" }]);
    const router = makeRouter([openai.adapter], log);
    const result = await router.embed(
      { text: "hello world" },
      {
        bindings: [],
        profiles: [{ purpose: "embedding", providerId: "openai", model: "text-embedding-3-small" }],
      },
    );
    expect(result.dimension).toBe(3);
    expect(log[0]).toMatchObject({ purpose: "embedding", status: "ok" });
  });
});
