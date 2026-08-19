// GitHubConnection (LIFECYCLE TASK 7) — migration 0021. Credential'ın kendisi
// secrets tablosunda mühürlü durur; bu tablo yalnız referans + durum taşır.
import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, id } from "./common.js";
import { companyId } from "./companies.js";

export const githubConnections = pgTable(
  "github_connections",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    /** GitHub hesabı (login) — push/create bu hesapta yapılır. */
    owner: text("owner").notNull(),
    /** secrets.name referansı — token asla bu tabloda durmaz. */
    credentialRef: text("credential_ref").notNull(),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    status: text("status").notNull().default("active"),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("github_connections_company_owner_uq").on(t.companyId, t.owner),
    check(
      "github_connections_status_check",
      sql`${t.status} IN ('active','invalid','revoked')`,
    ),
  ],
);
