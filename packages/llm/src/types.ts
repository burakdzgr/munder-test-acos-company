// The ModelRouter port types (ADR-015): OUR shapes, vendor-neutral. No AI SDK
// type crosses this boundary — adapters translate into these and nothing else.
import { z } from "zod";

export const LLM_PURPOSES = ["reasoning", "coding", "fast", "embedding", "vision"] as const;
export type LlmPurpose = (typeof LLM_PURPOSES)[number];

export const BINDING_PURPOSES = ["primary", "fast", "embedding"] as const;
export type BindingPurpose =
  | "primary"
  | "default"
  | "coding"
  | "planning"
  | "review"
  | "fast"
  | "embedding";

/** Profile purposes collapse onto binding purposes (_DECISIONS §17, T19). */
/**
 * TASK 11: çağrı amacı → binding tercihi SIRALI listesi. Ajan "planning"
 * bağı tanımladıysa reasoning çağrıları önce onu, yoksa default/primary'yi
 * kullanır — kimlik ⊥ model korunur, seçim registry'den yapılır.
 */
export const PURPOSE_TO_BINDING: Record<LlmPurpose, readonly BindingPurpose[]> = {
  reasoning: ["planning", "default", "primary"],
  coding: ["coding", "default", "primary"],
  vision: ["default", "primary"],
  fast: ["review", "fast", "default"],
  embedding: ["embedding"],
};

export const LlmMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
  /**
   * B3 (26 §3) — prompt cache breakpoint. The agent loop re-sends the same
   * identity + persona + action catalog on EVERY step; marking that prefix
   * lets the provider bill it at the cached rate (already priced separately
   * as `cachedInputPerMTokCents`). Adapters that do not support caching
   * ignore the flag, so it can never change what the model is asked.
   *
   * Only mark a genuinely STABLE prefix: a marker that changes per step
   * invalidates the cache for everything after it and costs more than it
   * saves.
   */
  cacheable: z.boolean().optional(),
});
export type LlmMessage = z.infer<typeof LlmMessageSchema>;

export interface CompleteRequest {
  purpose: LlmPurpose;
  messages: LlmMessage[];
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  /** accounting refs — flow into the llm_calls log entry verbatim */
  agentId?: string | undefined;
  taskId?: string | undefined;
  sessionId?: string | undefined;
}

export const LlmUsageSchema = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cachedInputTokens: z.number().int().min(0).default(0),
});
export type LlmUsage = z.infer<typeof LlmUsageSchema>;

export interface CompleteResult {
  text: string;
  usage: LlmUsage;
  providerId: string;
  model: string;
  latencyMs: number;
  costCents: number;
  finishReason: "stop" | "length" | "content_filter" | "other";
}

export interface EmbedRequest {
  purpose?: "embedding" | undefined;
  text: string;
  agentId?: string | undefined;
  taskId?: string | undefined;
}

export interface EmbedResult {
  embedding: number[];
  dimension: number;
  usage: LlmUsage;
  providerId: string;
  model: string;
  latencyMs: number;
  costCents: number;
}

export const LLM_ERROR_KINDS = [
  "rate_limited", // 429 — fallback-eligible
  "provider_unavailable", // 5xx / network — fallback-eligible
  "auth", // 401/403 — configuration problem, no fallback masking
  "bad_request", // 4xx — our fault, never fall back
  "no_target", // resolution produced no usable provider+model
  // Y7 (2026-08-15): HTTP 200 with empty content — a safety refusal. Not
  // retryable and not a fallback case; the caller must handle it explicitly
  // instead of parsing "" as malformed JSON and burning its repair budget.
  "refused",
] as const;
export type LlmErrorKind = (typeof LLM_ERROR_KINDS)[number];

export class LlmError extends Error {
  constructor(
    public readonly kind: LlmErrorKind,
    message: string,
    public readonly providerId?: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export const FALLBACK_ELIGIBLE: ReadonlySet<LlmErrorKind> = new Set([
  "rate_limited",
  "provider_unavailable",
]);

// ---------- resolution inputs (data rows, repository-free) ----------

export interface AgentBindingInput {
  purpose: BindingPurpose;
  providerId: string;
  model: string;
  params?: Record<string, unknown> | undefined;
  priority?: number | undefined;
}

export interface ModelProfileInput {
  purpose: LlmPurpose;
  providerId: string;
  model: string;
  params?: Record<string, unknown> | undefined;
  priority?: number | undefined;
  enabled?: boolean | undefined;
  maxTokensPerCall?: number | null | undefined;
  costCapCentsPerCall?: number | null | undefined;
}

export interface ResolvedTarget {
  providerId: string;
  model: string;
  params: Record<string, unknown>;
  maxTokensPerCall: number | null;
  costCapCentsPerCall: number | null;
  source: "binding" | "profile";
}

// ---------- pricing (model_providers.pricing JSONB, 26 §3.1) ----------

export const ProviderPricingSchema = z.object({
  inputPerMTokCents: z.number().min(0).default(0),
  outputPerMTokCents: z.number().min(0).default(0),
  cachedInputPerMTokCents: z.number().min(0).default(0),
});
export type ProviderPricing = z.infer<typeof ProviderPricingSchema>;

/**
 * Model-keyed pricing for ONE provider row (26 §3.1 — the shape
 * `model_providers.pricing` stores). A provider row serves many models at very
 * different rates (opus 500 vs haiku 100 per Mtok input), so a single flat rate
 * per provider misprices by up to 5x — see `default` below.
 *
 * B1 (2026-08-15 code review): the router used to key pricing by providerId
 * alone, which could not express 26 §3.1 at all.
 */
export interface ProviderPricingTable {
  models: Readonly<Record<string, ProviderPricing>>;
  /**
   * Provider-wide rate for models with no entry. Absent ⇒ the model is
   * unpriced and costs 0 — deliberately, so an unknown model shows up as a
   * visible zero rather than a silently invented price.
   */
  default?: ProviderPricing | undefined;
}

/** A pricing map value: model-keyed table (26 §3.1) or a legacy flat rate. */
export type ProviderPricingEntry = ProviderPricing | ProviderPricingTable;

function isPricingTable(entry: ProviderPricingEntry): entry is ProviderPricingTable {
  return "models" in entry;
}

/**
 * (providerId, model) → rate. Model entry first, then the provider-wide
 * `default`; a flat entry stays provider-wide (backward compatible).
 * Returns null when nothing prices this model ⇒ cost 0.
 */
export function resolveProviderPricing(
  entry: ProviderPricingEntry | undefined,
  model: string,
): ProviderPricing | null {
  if (!entry) return null;
  if (!isPricingTable(entry)) return entry;
  return entry.models[model] ?? entry.default ?? null;
}

export function computeCostCents(usage: LlmUsage, pricing: ProviderPricing | null): number {
  if (!pricing) return 0;
  const freshInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const cents =
    (freshInput * pricing.inputPerMTokCents +
      usage.cachedInputTokens * pricing.cachedInputPerMTokCents +
      usage.outputTokens * pricing.outputPerMTokCents) /
    1_000_000;
  return Math.ceil(cents);
}

// ---------- llm_calls accounting hook (written by the app, ADR-015) ----------

export interface LlmCallLogEntry {
  providerId: string;
  model: string;
  purpose: LlmPurpose;
  status: "ok" | "error";
  errorKind?: LlmErrorKind | undefined;
  usage: LlmUsage;
  costCents: number;
  latencyMs: number;
  agentId?: string | undefined;
  taskId?: string | undefined;
  sessionId?: string | undefined;
}

export type LlmCallLogger = (entry: LlmCallLogEntry) => void | Promise<void>;
