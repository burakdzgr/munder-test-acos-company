// A1 (26 §3.1): read the platform price list from `model_providers.pricing`.
//
// The column stores the document shape (snake_case, model-keyed):
//   { "models": { "<model>": { in_per_mtok_cents, out_per_mtok_cents,
//                              cached_in_per_mtok_cents } },
//     "updated_at": "...", "source": "seed" | "manual" }
// The router consumes the port shape (camelCase, `ProviderPricingTable`), so
// this is the one place that translates between them. An empty `{}` — the
// column default — yields no entry, letting the caller fall back to
// `pricingDefaultsFor(kind)` so rows written before 0014 behave as before.
import { eq } from "drizzle-orm";
import { modelProviders } from "./schema/index.js";
import type { GuardedDb } from "./tenant.js";

// Structural mirrors of the @acos/llm port shapes. `packages/db` may not depend
// on `packages/llm` (28 §1 dependency matrix), and structural typing makes the
// result assignable to `RouterOptions.pricing` without the import.
export interface ProviderRate {
  inputPerMTokCents: number;
  outputPerMTokCents: number;
  cachedInputPerMTokCents: number;
}

export interface ProviderPricingTable {
  models: Readonly<Record<string, ProviderRate>>;
  default?: ProviderRate | undefined;
}

/** 26 §3.1 JSONB rate: cents per million tokens. */
interface StoredRate {
  in_per_mtok_cents?: unknown;
  out_per_mtok_cents?: unknown;
  cached_in_per_mtok_cents?: unknown;
}

interface StoredPricing {
  models?: Record<string, StoredRate> | undefined;
  default?: StoredRate | undefined;
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** A rate needs at least one usable field; anything else is ignored (never guessed). */
function toRate(stored: StoredRate | undefined): ProviderRate | null {
  if (!stored || typeof stored !== "object") return null;
  const input = num(stored.in_per_mtok_cents);
  const output = num(stored.out_per_mtok_cents);
  const cached = num(stored.cached_in_per_mtok_cents);
  if (input === null && output === null && cached === null) return null;
  return {
    inputPerMTokCents: input ?? 0,
    outputPerMTokCents: output ?? 0,
    cachedInputPerMTokCents: cached ?? 0,
  };
}

export function parseStoredPricing(raw: unknown): ProviderPricingTable | null {
  if (!raw || typeof raw !== "object") return null;
  const stored = raw as StoredPricing;
  const models: Record<string, ProviderRate> = {};
  for (const [model, rate] of Object.entries(stored.models ?? {})) {
    const parsed = toRate(rate);
    if (parsed) models[model] = parsed;
  }
  const fallback = toRate(stored.default);
  if (Object.keys(models).length === 0 && !fallback) return null;
  return fallback ? { models, default: fallback } : { models };
}

/**
 * providerId → price table, for every enabled provider row that carries one.
 * Rows with an empty/unparseable `pricing` are omitted so the caller can apply
 * its compile-time defaults instead.
 */
export async function loadProviderPricing(
  db: GuardedDb,
): Promise<Map<string, ProviderPricingTable>> {
  const rows = await db
    .select({ id: modelProviders.id, pricing: modelProviders.pricing })
    .from(modelProviders)
    .where(eq(modelProviders.enabled, true));
  const table = new Map<string, ProviderPricingTable>();
  for (const row of rows) {
    const parsed = parseStoredPricing(row.pricing);
    if (parsed) table.set(row.id, parsed);
  }
  return table;
}
