-- LIFECYCLE TASK 5: Branch Overlay Index — canonical (overlay_ref NULL,
-- default branch HEAD) + task overlay ('task:<taskId>', worktree değişimleri).
-- Context sorgusu ikisini birlikte okur; merge sonrası overlay silinir.
ALTER TABLE "code_files" ADD COLUMN "overlay_ref" text;
DROP INDEX "code_files_project_path_uq";
CREATE UNIQUE INDEX "code_files_project_path_overlay_uq"
  ON "code_files" ("company_id", "project_id", "path", COALESCE("overlay_ref", ''));
CREATE INDEX "code_files_overlay_pidx"
  ON "code_files" ("company_id", "project_id", "overlay_ref")
  WHERE "overlay_ref" IS NOT NULL;
