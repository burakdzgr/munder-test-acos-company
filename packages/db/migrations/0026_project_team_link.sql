-- E2/W1 (T17) KEYSTONE: Company > Project > Team artık GERÇEK bir ilişki.
--
-- Bugüne kadar proje ile takım arasındaki bağ yalnız İŞTEN türüyordu
-- (tasks.project_id × tasks.org_unit_id, apps/web useProjectTeams). Bu, iş
-- almamış bir projenin takımının OLMAMASI demekti — sihirbazın kurduğu ekip
-- ilk görev dağıtılana kadar görünmezdi.
--
-- Ajanlar TAŞINMAZ: agents.org_unit_id şirket kapsamında kalır (ajan kalıcı
-- şirket varlığıdır, 09 §2 "bir takım aynı anda birden çok projede
-- çalışabilir"), proje↔ajan bağı project_members'ta durur. Yeni tablo yalnız
-- proje↔BİRİM bağını taşır ve çoka-çok kalır.
CREATE TABLE "project_team_memberships" (
  "id" uuid PRIMARY KEY NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "org_unit_id" uuid NOT NULL REFERENCES "org_units"("id") ON DELETE CASCADE,
  "added_by" text NOT NULL DEFAULT 'system',
  "added_at" timestamptz NOT NULL DEFAULT now(),
  "removed_at" timestamptz,
  CONSTRAINT "project_team_memberships_added_by_check"
    CHECK ("added_by" IN ('system','founder','agent','backfill'))
);

CREATE UNIQUE INDEX "project_team_memberships_active_uq"
  ON "project_team_memberships" ("project_id", "org_unit_id")
  WHERE "removed_at" IS NULL;
CREATE INDEX "project_team_memberships_company_project_idx"
  ON "project_team_memberships" ("company_id", "project_id");
CREATE INDEX "project_team_memberships_unit_idx"
  ON "project_team_memberships" ("company_id", "org_unit_id");

-- Backfill: bugüne kadarki TÜREVİ kalıcılaştır. Türetim kaynağı ile birebir
-- aynı sorgu (proje başına distinct org birimi), böylece göç anında hiçbir
-- projenin takım listesi DEĞİŞMEZ — yalnız kaynağı türevden gerçek bağa döner.
INSERT INTO "project_team_memberships" ("id", "company_id", "project_id", "org_unit_id", "added_by")
SELECT gen_random_uuid(), t.company_id, t.project_id, t.org_unit_id, 'backfill'
  FROM (
    SELECT DISTINCT company_id, project_id, org_unit_id
      FROM "tasks"
     WHERE project_id IS NOT NULL AND org_unit_id IS NOT NULL
  ) t
  JOIN "projects" p ON p.id = t.project_id AND p.company_id = t.company_id
  JOIN "org_units" u ON u.id = t.org_unit_id AND u.company_id = t.company_id
ON CONFLICT DO NOTHING;
