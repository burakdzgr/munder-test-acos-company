-- Founder'ın panodan kaldırabilmesi için arşiv niteliği.
--
-- SİLME DEĞİL: görev satırı, olayları, adımları, artefaktları ve ondan doğan
-- anılar yerinde kalır (INV-11 append-only). Değişen tek şey varsayılan
-- görünümde çıkıp çıkmaması; alan NULL'a çekilerek geri alınır.
--
-- Durum makinesine dokunulmadı — 07 §5'teki 16 durum sabittir ve arşiv bir
-- durum değil, görünüm niteliğidir.
ALTER TABLE "tasks" ADD COLUMN "archived_at" timestamptz;

-- Panoyu varsayılan sorgu tarar: arşivlenmemiş + (açık VEYA yeni kapanmış).
CREATE INDEX "tasks_company_archived_pidx"
  ON "tasks" ("company_id", "closed_at")
  WHERE "archived_at" IS NULL;
