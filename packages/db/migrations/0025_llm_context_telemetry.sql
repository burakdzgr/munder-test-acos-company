-- LIVE-CONSOLE TASK 7: her model çağrısında working-set bölüm telemetrisi
-- (systemTokens/taskTokens/memoryTokens/... tahminleri + budget bayrağı).
-- Sonraki context optimizasyonlarının ölçüm kaynağı.
ALTER TABLE "llm_calls" ADD COLUMN IF NOT EXISTS "context_telemetry" jsonb;
