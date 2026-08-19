// Provider adapters (ADR-015): Vercel AI SDK v5 lives STRICTLY inside this
// file (plus the eslint boundary that enforces it). Adapters translate the
// port shapes; they never choose models, never retry, and never let an AI SDK
// type or error escape — everything surfaces as port types / LlmError.
import { APICallError, embed as aiEmbed, generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ProviderAdapter } from "../router.js";
import { LlmError, type LlmUsage } from "../types.js";

function toLlmError(err: unknown, providerId: string): LlmError {
  if (APICallError.isInstance(err)) {
    const status = err.statusCode ?? 0;
    if (status === 429) return new LlmError("rate_limited", err.message, providerId);
    // 2026-08-18 canlı bulgu: Anthropic "credit balance is too low" hatasını
    // HTTP 400 ile döndürüyor → bad_request sayılıyor ve router YEDEĞE
    // DÜŞMÜYORDU — tüm şirket tek kalemde durdu (9 workflow Failed). Kota/
    // bakiye tükenmesi istek hatası değil sağlayıcı kullanılamazlığıdır;
    // rate_limited gibi fallback'e uygundur (ollama devralır).
    if (status === 402 || /credit balance|billing|quota|insufficient/i.test(err.message)) {
      return new LlmError("rate_limited", err.message, providerId);
    }
    if (status === 401 || status === 403) return new LlmError("auth", err.message, providerId);
    if (status >= 500 || status === 0)
      return new LlmError("provider_unavailable", err.message, providerId);
    return new LlmError("bad_request", err.message, providerId);
  }
  return new LlmError("provider_unavailable", String(err), providerId);
}

function toUsage(usage: {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
}): LlmUsage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
  };
}

type LanguageModelFactory = (modelId: string) => Parameters<typeof generateText>[0]["model"];
type EmbeddingModelFactory = (modelId: string) => Parameters<typeof aiEmbed>[0]["model"];

/**
 * Y7: models that still accept a non-default `temperature`. Newer generations
 * (Opus 5 / Sonnet 5 / Opus 4.7+) reject it with HTTP 400, so the parameter is
 * dropped for them rather than failing a data-driven model swap.
 */
function acceptsTemperature(model: string): boolean {
  const m = model.toLowerCase();
  if (/(opus|sonnet)-5/.test(m)) return false;
  if (/opus-4-(7|8|9)/.test(m)) return false;
  return true;
}

/**
 * B3 (26 §3) — prompt caching. The agent loop re-sends an identical prefix
 * (identity + persona + rules + action catalog) on every step of every task;
 * without a breakpoint the provider re-reads and re-bills all of it each
 * time. `cachedInputPerMTokCents` has always been in the pricing table and
 * `cachedInputTokens` has always been read back from usage — the only missing
 * piece was telling the provider where the stable prefix ends.
 *
 * Anthropic-only for now: it is the provider ACOS runs on, and its cache is
 * explicit (an ephemeral breakpoint on a message). OpenAI caches long prefixes
 * automatically with no marker, so the flag is simply not translated there —
 * the same messages go out either way.
 */
function withCacheBreakpoints(
  providerId: string,
  messages: ReadonlyArray<{ role: string; content: string; cacheable?: boolean | undefined }>,
): NonNullable<Parameters<typeof generateText>[0]["messages"]> {
  const plain = messages.map(({ role, content }) => ({ role, content }));
  if (providerId !== "anthropic") {
    return plain as NonNullable<Parameters<typeof generateText>[0]["messages"]>;
  }
  return messages.map(({ role, content, cacheable }) =>
    cacheable === true
      ? {
          role,
          content,
          // 1h TTL: an agent's step loop spans minutes, and the same prefix
          // recurs across the company's tasks all day.
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
        }
      : { role, content },
  ) as NonNullable<Parameters<typeof generateText>[0]["messages"]>;
}

function buildAdapter(
  providerId: string,
  languageModel: LanguageModelFactory,
  embeddingModel: EmbeddingModelFactory,
): ProviderAdapter {
  return {
    providerId,
    async complete(input) {
      try {
        const result = await generateText({
          model: languageModel(input.model),
          messages: withCacheBreakpoints(providerId, input.messages),
          ...(input.maxTokens !== undefined && { maxOutputTokens: input.maxTokens }),
          // Y7 (2026-08-15 code review): newer model generations REJECT a
          // non-default temperature with HTTP 400. The value is data-driven
          // (model_profiles/agent_model_bindings params), so a model swap in
          // the DB would break every call and no test would catch it. Drop it
          // for models that do not accept it instead of failing the call.
          ...(input.temperature !== undefined &&
            acceptsTemperature(input.model) && { temperature: input.temperature }),
        });
        const finishReason =
          result.finishReason === "stop"
            ? ("stop" as const)
            : result.finishReason === "length"
              ? ("length" as const)
              : result.finishReason === "content-filter"
                ? ("content_filter" as const)
                : ("other" as const);
        // Y7: a refusal arrives as HTTP 200 with empty text — surface it as a
        // typed error instead of letting the caller burn its JSON repairs.
        if (result.text.trim() === "" && finishReason === "other") {
          throw new LlmError(
            "refused",
            `${providerId}: model returned no content (refusal)`,
            providerId,
          );
        }
        return { text: result.text, usage: toUsage(result.usage), finishReason };
      } catch (err) {
        if (err instanceof LlmError) throw err;
        throw toLlmError(err, providerId);
      }
    },
    async embed(input) {
      try {
        const result = await aiEmbed({ model: embeddingModel(input.model), value: input.text });
        return {
          embedding: result.embedding,
          usage: toUsage({ inputTokens: result.usage?.tokens ?? 0, outputTokens: 0 }),
        };
      } catch (err) {
        throw toLlmError(err, providerId);
      }
    },
  };
}

export function createAnthropicAdapter(options: {
  providerId?: string;
  apiKey: string;
  baseUrl?: string;
}): ProviderAdapter {
  const provider = createAnthropic({
    apiKey: options.apiKey,
    ...(options.baseUrl && { baseURL: options.baseUrl }),
  });
  return buildAdapter(
    options.providerId ?? "anthropic",
    (m) => provider(m),
    (m) => provider.textEmbeddingModel(m),
  );
}

export function createOpenAiAdapter(options: {
  providerId?: string;
  apiKey: string;
  baseUrl?: string;
}): ProviderAdapter {
  const provider = createOpenAI({
    apiKey: options.apiKey,
    ...(options.baseUrl && { baseURL: options.baseUrl }),
  });
  return buildAdapter(
    options.providerId ?? "openai",
    (m) => provider(m),
    (m) => provider.textEmbeddingModel(m),
  );
}

/** OpenRouter, Ollama and vLLM all speak the OpenAI-compatible dialect. */
export function createOpenAiCompatAdapter(options: {
  providerId: string;
  baseUrl: string;
  apiKey?: string;
}): ProviderAdapter {
  const provider = createOpenAICompatible({
    name: options.providerId,
    baseURL: options.baseUrl,
    ...(options.apiKey && { apiKey: options.apiKey }),
  });
  return buildAdapter(
    options.providerId,
    (m) => provider(m),
    (m) => provider.textEmbeddingModel(m),
  );
}

export function createOpenRouterAdapter(options: { apiKey: string }): ProviderAdapter {
  return createOpenAiCompatAdapter({
    providerId: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: options.apiKey,
  });
}

/** Gemini (2026-08-19, Founder kararı): Google'ın OpenAI-uyumlu endpoint'i —
 *  ücretsiz AI Studio anahtarıyla çalışır; zincire kredi gerektirmeyen bir
 *  bulut katmanı ekler (Anthropic/OpenAI kredisi bitince şirket yerel modele
 *  düşmek zorunda kalmasın). */
export function createGeminiAdapter(options: { providerId?: string; apiKey: string }): ProviderAdapter {
  return createOpenAiCompatAdapter({
    providerId: options.providerId ?? "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: options.apiKey,
  });
}

export function createOllamaAdapter(options: { baseUrl: string }): ProviderAdapter {
  return createOpenAiCompatAdapter({
    providerId: "ollama",
    baseUrl: options.baseUrl.replace(/\/$/, "") + "/v1",
  });
}
