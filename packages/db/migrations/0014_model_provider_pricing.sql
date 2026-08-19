-- A1 (26 §3.1): platform-level, model-keyed price list on model_providers.
-- Additive: `not null default '{}'::jsonb` leaves every existing row intact,
-- and an empty object falls back to `pricingDefaultsFor(kind)` in code, so
-- behaviour is unchanged until an operator edits it in Settings → Providers.
--
-- Note: the generated diff also proposed re-creating `memory_retrievals`
-- because migration 0013 was hand-written without refreshing the drizzle
-- snapshot. That table already exists, so only the pricing column ships here;
-- the refreshed snapshot (0014_snapshot.json) now records both.
ALTER TABLE "model_providers" ADD COLUMN "pricing" jsonb DEFAULT '{}'::jsonb NOT NULL;
