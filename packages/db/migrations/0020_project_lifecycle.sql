-- PROJECT-LIFECYCLE TASK 2/3: proje yaşam döngüsü durumları + indeks bağı.
-- Yeni akış: draft → repository_setup → indexing → ready → planning →
-- staffing_review → waiting_for_founder → executing. Miras durumlar kalır.
ALTER TABLE "projects" DROP CONSTRAINT "projects_status_check";
ALTER TABLE "projects" ADD CONSTRAINT "projects_status_check" CHECK ("status" IN (
  'draft','repository_setup','indexing','ready','planning','staffing_review',
  'waiting_for_founder','executing','failed',
  'proposed','intake','active','paused','completed','archived','cancelled'
));

-- TASK 3: READY indeksin commit SHA'sına bağlıdır (INVARIANT 3);
-- index_state agent'a bayatlığı söyler (TASK 5).
ALTER TABLE "projects" ADD COLUMN "head_sha" text;
ALTER TABLE "projects" ADD COLUMN "index_state" text DEFAULT 'none' NOT NULL;
ALTER TABLE "projects" ADD COLUMN "index_commit_sha" text;
ALTER TABLE "projects" ADD CONSTRAINT "projects_index_state_check"
  CHECK ("index_state" IN ('none','running','ready','stale','failed'));
