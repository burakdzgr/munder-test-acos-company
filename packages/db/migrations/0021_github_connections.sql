-- LIFECYCLE TASK 7: GitHubConnection — credential kullanımı açık model altında.
-- Token yalnız secrets'ta (MASTER_KEY mühürlü) yaşar; bu tablo referans taşır.
CREATE TABLE "github_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "owner" text NOT NULL,
  "credential_ref" text NOT NULL,
  "scopes" text[] DEFAULT '{}' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "last_validated_at" timestamptz,
  CONSTRAINT "github_connections_status_check" CHECK ("status" IN ('active','invalid','revoked'))
);
CREATE UNIQUE INDEX "github_connections_company_owner_uq" ON "github_connections" ("company_id", "owner");

-- Proje yalnız connection referansı taşır (TASK 7).
ALTER TABLE "projects" ADD COLUMN "github_connection_id" uuid REFERENCES "github_connections"("id") ON DELETE set null;
