-- E2/W3 (T19): kadro önerisi artık DURABLE ve DÜZENLENEBİLİR bir varlık.
--
-- Önce: plan `tasks.context.staffingPlan` içinde donuyordu ve Founder'ın tek
-- seçeneği İKİLİ onaydı (onayla/reddet) — "takım ekle", "kişi sayısını değiştir"
-- diye bir şey yoktu. Sihirbazın çekirdeği bu tablo: CEO önerir, insan düzenler,
-- onaylayınca Agent Factory TAM OLARAK bu satırları kurar.
CREATE TABLE "staffing_proposals" (
  "id" uuid PRIMARY KEY NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "goal_task_id" uuid,
  "approval_id" uuid,
  -- W5: öneriyi bekleyen iş akışı — onay ucu SİNYALİ buraya yollar
  "workflow_id" text,
  "status" text NOT NULL DEFAULT 'draft',
  "version" integer NOT NULL DEFAULT 1,
  "source" text NOT NULL DEFAULT 'deterministic',
  "rationale_md" text NOT NULL DEFAULT '',
  "teams" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "estimated_cost_cents" integer NOT NULL DEFAULT 0,
  CONSTRAINT "staffing_proposals_status_check"
    CHECK ("status" IN ('draft','awaiting_human','confirmed','applied','cancelled')),
  CONSTRAINT "staffing_proposals_source_check"
    CHECK ("source" IN ('llm','deterministic','human')),
  CONSTRAINT "staffing_proposals_version_check" CHECK ("version" >= 1)
);

-- Proje başına AYNI ANDA tek açık öneri: sihirbaz iki kez açılırsa ikinci
-- giriş mevcut öneriyi bulur, yenisini üretmez (idempotent replay).
CREATE UNIQUE INDEX "staffing_proposals_open_uq"
  ON "staffing_proposals" ("project_id")
  WHERE "status" IN ('draft','awaiting_human','confirmed');
CREATE INDEX "staffing_proposals_company_idx"
  ON "staffing_proposals" ("company_id", "project_id");
