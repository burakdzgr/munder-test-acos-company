// ModelRouter (ADR-015; _DECISIONS §17). The router owns resolution and
// accounting: fallback to the next target ONLY on 429/5xx, per-call token
// caps, and an llm_calls log entry for EVERY attempt (success and failure) —
// accounting cannot be skipped by any call path. The router does not retry
// beyond provider fallback; retry policy lives in Temporal (ADR-005).
import {
  FALLBACK_ELIGIBLE,
  LlmError,
  computeCostCents,
  resolveProviderPricing,
  type AgentBindingInput,
  type CompleteRequest,
  type CompleteResult,
  type EmbedRequest,
  type EmbedResult,
  type LlmCallLogger,
  type LlmUsage,
  type ModelProfileInput,
  type ProviderPricingEntry,
  type ResolvedTarget,
} from "./types.js";
import { resolveTargets } from "./resolution.js";

/** What an adapter implements — transport only; adapters never choose models. */
export interface ProviderAdapter {
  readonly providerId: string;
  complete(input: {
    model: string;
    messages: CompleteRequest["messages"];
    maxTokens?: number | undefined;
    temperature?: number | undefined;
    params?: Record<string, unknown> | undefined;
  }): Promise<{ text: string; usage: LlmUsage; finishReason: CompleteResult["finishReason"] }>;
  embed(input: {
    model: string;
    text: string;
  }): Promise<{ embedding: number[]; usage: LlmUsage }>;
}

export interface RouterOptions {
  providers: ReadonlyMap<string, ProviderAdapter>;
  /**
   * model_providers.pricing per providerId (26 §3.1); absent ⇒ cost 0.
   * Values are model-keyed tables; a bare {@link ProviderPricing} is still
   * accepted and applies provider-wide.
   */
  pricing?: ReadonlyMap<string, ProviderPricingEntry> | undefined;
  logCall: LlmCallLogger;
  /** router-wide hard ceiling on output tokens per call. */
  defaultMaxTokens?: number | undefined;
  now?: (() => number) | undefined;
}

export interface RoutingContext {
  bindings: readonly AgentBindingInput[];
  profiles: readonly ModelProfileInput[];
}

const ZERO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

export class ModelRouter {
  constructor(private readonly options: RouterOptions) {}

  async complete(request: CompleteRequest, routing: RoutingContext): Promise<CompleteResult> {
    const targets = resolveTargets(request.purpose, routing.bindings, routing.profiles);
    if (targets.length === 0) {
      throw new LlmError("no_target", `no provider resolves purpose "${request.purpose}"`);
    }
    let lastError: LlmError | null = null;
    for (const target of targets) {
      const adapter = this.options.providers.get(target.providerId);
      if (!adapter) {
        lastError = new LlmError(
          "provider_unavailable",
          `provider ${target.providerId} is not configured`,
          target.providerId,
        );
        continue;
      }
      const maxTokens = this.effectiveMaxTokens(request.maxTokens, target);
      const startedAt = (this.options.now ?? Date.now)();
      try {
        const output = await adapter.complete({
          model: target.model,
          messages: request.messages,
          maxTokens,
          temperature: request.temperature,
          params: target.params,
        });
        const latencyMs = (this.options.now ?? Date.now)() - startedAt;
        const costCents = computeCostCents(
          output.usage,
          resolveProviderPricing(this.options.pricing?.get(target.providerId), target.model),
        );
        await this.options.logCall({
          providerId: target.providerId,
          model: target.model,
          purpose: request.purpose,
          status: "ok",
          usage: output.usage,
          costCents,
          latencyMs,
          agentId: request.agentId,
          taskId: request.taskId,
          sessionId: request.sessionId,
        });
        return {
          text: output.text,
          usage: output.usage,
          providerId: target.providerId,
          model: target.model,
          latencyMs,
          costCents,
          finishReason: output.finishReason,
        };
      } catch (err) {
        const latencyMs = (this.options.now ?? Date.now)() - startedAt;
        const llmError =
          err instanceof LlmError
            ? err
            : new LlmError("provider_unavailable", String(err), target.providerId);
        await this.options.logCall({
          providerId: target.providerId,
          model: target.model,
          purpose: request.purpose,
          status: "error",
          errorKind: llmError.kind,
          usage: ZERO_USAGE,
          costCents: 0,
          latencyMs,
          agentId: request.agentId,
          taskId: request.taskId,
          sessionId: request.sessionId,
        });
        if (!FALLBACK_ELIGIBLE.has(llmError.kind)) throw llmError; // our fault — no masking
        lastError = llmError;
      }
    }
    throw lastError ?? new LlmError("provider_unavailable", "all providers failed");
  }

  async embed(request: EmbedRequest, routing: RoutingContext): Promise<EmbedResult> {
    const targets = resolveTargets("embedding", routing.bindings, routing.profiles);
    if (targets.length === 0) {
      throw new LlmError("no_target", 'no provider resolves purpose "embedding"');
    }
    let lastError: LlmError | null = null;
    for (const target of targets) {
      const adapter = this.options.providers.get(target.providerId);
      if (!adapter) {
        lastError = new LlmError(
          "provider_unavailable",
          `provider ${target.providerId} is not configured`,
          target.providerId,
        );
        continue;
      }
      const startedAt = (this.options.now ?? Date.now)();
      try {
        const output = await adapter.embed({ model: target.model, text: request.text });
        const latencyMs = (this.options.now ?? Date.now)() - startedAt;
        const costCents = computeCostCents(
          output.usage,
          resolveProviderPricing(this.options.pricing?.get(target.providerId), target.model),
        );
        await this.options.logCall({
          providerId: target.providerId,
          model: target.model,
          purpose: "embedding",
          status: "ok",
          usage: output.usage,
          costCents,
          latencyMs,
          agentId: request.agentId,
          taskId: request.taskId,
        });
        return {
          embedding: output.embedding,
          dimension: output.embedding.length,
          usage: output.usage,
          providerId: target.providerId,
          model: target.model,
          latencyMs,
          costCents,
        };
      } catch (err) {
        const latencyMs = (this.options.now ?? Date.now)() - startedAt;
        const llmError =
          err instanceof LlmError
            ? err
            : new LlmError("provider_unavailable", String(err), target.providerId);
        await this.options.logCall({
          providerId: target.providerId,
          model: target.model,
          purpose: "embedding",
          status: "error",
          errorKind: llmError.kind,
          usage: ZERO_USAGE,
          costCents: 0,
          latencyMs,
          agentId: request.agentId,
          taskId: request.taskId,
        });
        if (!FALLBACK_ELIGIBLE.has(llmError.kind)) throw llmError;
        lastError = llmError;
      }
    }
    throw lastError ?? new LlmError("provider_unavailable", "all providers failed");
  }

  /** min(request, profile cap, router default) — never unbounded when any cap exists. */
  private effectiveMaxTokens(
    requested: number | undefined,
    target: ResolvedTarget,
  ): number | undefined {
    const caps = [requested, target.maxTokensPerCall ?? undefined, this.options.defaultMaxTokens]
      .filter((v): v is number => typeof v === "number" && v > 0);
    if (caps.length === 0) return undefined;
    return Math.min(...caps);
  }
}
