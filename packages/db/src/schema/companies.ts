// Companies & Tenancy (20 §3) + company-scoped platform config (20 §2.5, §2.7).
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea, createdAt, id } from "./common.js";
import { modelProviders, users } from "./identity.js";

/** 3.1 companies — tenant root. */
export const companies = pgTable(
  "companies",
  {
    id: id(),
    createdAt: createdAt(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    currency: text("currency").notNull().default("USD"),
    status: text("status").notNull().default("active"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    uniqueIndex("companies_slug_uq").on(t.slug),
    check("companies_currency_check", sql`char_length(${t.currency}) = 3`),
    check("companies_status_check", sql`${t.status} IN ('active','archived')`),
  ],
);

export const companyId = () =>
  uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "restrict" });

/** 3.2 company_members */
export const companyMembers = pgTable(
  "company_members",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    role: text("role").notNull().default("founder"),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("company_members_company_user_active_uq")
      .on(t.companyId, t.userId)
      .where(sql`${t.removedAt} IS NULL`),
    check("company_members_role_check", sql`${t.role} IN ('founder','admin','viewer')`),
  ],
);

/** 3.3 company_settings — one typed row per company; PK = company_id. */
export const companySettings = pgTable(
  "company_settings",
  {
    companyId: uuid("company_id")
      .primaryKey()
      .references(() => companies.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // _DECISIONS A5: iç dil İngilizce, ŞİRKETE DÖNÜK çıktı dili ayardır.
    // Varsayılan "tr" (Founder kararı 2026-08-16): bu kurulumda Founder
    // Türkçe çalışıyor ve her yeni şirkette ayarı elle çevirmek zorunda
    // kalıyordu. Değer şirket başına değiştirilebilir olmaya devam ediyor.
    outputLanguage: text("output_language").notNull().default("tr"),
    timezone: text("timezone").notNull().default("UTC"),
    defaultAutonomyLevel: smallint("default_autonomy_level").notNull().default(2),
    dailySpendLimitCents: bigint("daily_spend_limit_cents", { mode: "number" }),
    consolidationEventThreshold: integer("consolidation_event_threshold").notNull().default(25),
    memoryTokenBudgetAgent: integer("memory_token_budget_agent").notNull().default(1500),
    memoryTokenBudgetProject: integer("memory_token_budget_project").notNull().default(2500),
    memoryTokenBudgetCompany: integer("memory_token_budget_company").notNull().default(1000),
    embeddingPurposeOverride: text("embedding_purpose_override"),
    terminalLogRetentionDays: smallint("terminal_log_retention_days").notNull().default(7),
    extra: jsonb("extra").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    check(
      "company_settings_autonomy_check",
      sql`${t.defaultAutonomyLevel} BETWEEN 0 AND 5`,
    ),
  ],
);

/** 3.4 company_sequences — the gap-free per-company counters. */
export const companySequences = pgTable(
  "company_sequences",
  {
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    value: bigint("value", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.name] }),
    check(
      "company_sequences_name_check",
      sql`${t.name} IN ('event_seq','task_number','employee_number','decision_number','incident_number','approval_number')`,
    ),
  ],
);

/** 3.5 secrets — sealed boxes; agents never read this table (S2). */
export const secrets = pgTable(
  "secrets",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    name: text("name").notNull(),
    scope: text("scope").notNull().default("company"),
    // FK to projects is appended in migration 0004 (projects lands there).
    projectId: uuid("project_id"),
    ciphertext: bytea("ciphertext").notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("secrets_scope_name_uq").on(
      t.companyId,
      t.scope,
      sql`coalesce(${t.projectId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.name,
    ),
    check("secrets_scope_check", sql`${t.scope} IN ('company','project','integration')`),
  ],
);

/** 2.5 model_profiles — company-level purpose→model routing. */
export const modelProfiles = pgTable(
  "model_profiles",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    purpose: text("purpose").notNull(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => modelProviders.id, { onDelete: "restrict" }),
    model: text("model").notNull(),
    params: jsonb("params").notNull().default(sql`'{}'::jsonb`),
    maxTokensPerCall: integer("max_tokens_per_call"),
    costCapCentsPerCall: integer("cost_cap_cents_per_call"),
    priority: smallint("priority").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
  },
  (t) => [
    uniqueIndex("model_profiles_company_purpose_priority_uq").on(
      t.companyId,
      t.purpose,
      t.priority,
    ),
    check(
      "model_profiles_purpose_check",
      sql`${t.purpose} IN ('reasoning','coding','fast','embedding','vision')`,
    ),
  ],
);

/** 2.7 idempotency_keys — the one tenant table where company_id is nullable. */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: id(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    key: text("key").notNull(),
    endpoint: text("endpoint").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: smallint("response_status"),
    responseBody: jsonb("response_body"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '24 hours'`),
  },
  (t) => [
    unique("idempotency_keys_company_key_endpoint_uq")
      .on(t.companyId, t.key, t.endpoint)
      .nullsNotDistinct(),
    index("idempotency_keys_expires_at_idx").on(t.expiresAt),
  ],
);
