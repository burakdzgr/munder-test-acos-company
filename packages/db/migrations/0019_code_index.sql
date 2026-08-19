-- REVISION TASK 4 — CodeIndex: AST/symbol tabanlı kod grafiği.
-- Intake'in regex tabanlı code_graph özetinin yerini alan kalıcı, sorgulanabilir
-- indeks: dosyalar, semboller (class/function/method/…), kenarlar
-- (import/reference/call/tests). called_by ayrı saklanmaz — call kenarının
-- ters sorgusudur. Git diff sonrası yalnız değişen dosyalar güncellenir
-- (code_files.sha değişmediyse dosya atlanır).

CREATE TABLE "code_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE restrict,
  "path" text NOT NULL,
  "language" text NOT NULL,
  "sha" text NOT NULL,
  "loc" integer DEFAULT 0 NOT NULL,
  "is_test" boolean DEFAULT false NOT NULL,
  "indexed_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "code_files_project_path_uq" ON "code_files" ("company_id", "project_id", "path");

CREATE TABLE "code_symbols" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "project_id" uuid NOT NULL,
  "file_id" uuid NOT NULL REFERENCES "code_files"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "start_line" integer DEFAULT 1 NOT NULL,
  "end_line" integer DEFAULT 1 NOT NULL,
  "exported" boolean DEFAULT false NOT NULL,
  CONSTRAINT "code_symbols_kind_check" CHECK ("kind" IN ('class','function','method','interface','type','enum','const'))
);
CREATE INDEX "code_symbols_project_name_idx" ON "code_symbols" ("company_id", "project_id", "name");
CREATE INDEX "code_symbols_file_idx" ON "code_symbols" ("file_id");

CREATE TABLE "code_edges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "project_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "from_file_id" uuid NOT NULL REFERENCES "code_files"("id") ON DELETE cascade,
  "to_file_id" uuid REFERENCES "code_files"("id") ON DELETE cascade,
  "to_symbol_id" uuid REFERENCES "code_symbols"("id") ON DELETE cascade,
  "symbol_name" text,
  "to_module" text,
  CONSTRAINT "code_edges_kind_check" CHECK ("kind" IN ('import','reference','call','tests'))
);
CREATE INDEX "code_edges_project_kind_idx" ON "code_edges" ("company_id", "project_id", "kind");
CREATE INDEX "code_edges_from_file_idx" ON "code_edges" ("from_file_id");
CREATE INDEX "code_edges_to_file_idx" ON "code_edges" ("to_file_id");
CREATE INDEX "code_edges_to_symbol_idx" ON "code_edges" ("to_symbol_id");
