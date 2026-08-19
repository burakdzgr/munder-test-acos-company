// Identity & Platform (20 §2). [platform] tables carry no company_id.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  inet,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea, createdAt, id } from "./common.js";

/** 2.1 users [platform] */
export const users = pgTable(
  "users",
  {
    id: id(),
    createdAt: createdAt(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    totpSecretEnc: bytea("totp_secret_enc"),
    totpEnabled: boolean("totp_enabled").notNull().default(false),
    platformRole: text("platform_role").notNull().default("owner"),
    status: text("status").notNull().default("active"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`),
    check("users_platform_role_check", sql`${t.platformRole} IN ('owner','admin','member')`),
    check("users_status_check", sql`${t.status} IN ('active','disabled')`),
  ],
);

/** 2.2 sessions [platform] */
export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    createdAt: createdAt(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_uq").on(t.tokenHash),
    index("sessions_user_id_idx").on(t.userId),
    index("sessions_expires_at_active_pidx")
      .on(t.expiresAt)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);

/** 2.3 personal_access_tokens [platform] */
export const personalAccessTokens = pgTable(
  "personal_access_tokens",
  {
    id: id(),
    createdAt: createdAt(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("personal_access_tokens_token_hash_uq").on(t.tokenHash),
    uniqueIndex("personal_access_tokens_user_id_name_uq").on(t.userId, t.name),
  ],
);

/** 2.4 model_providers [platform] */
export const modelProviders = pgTable(
  "model_providers",
  {
    id: id(),
    createdAt: createdAt(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    baseUrl: text("base_url"),
    apiKeyEnc: bytea("api_key_enc"),
    enabled: boolean("enabled").notNull().default(true),
    /**
     * A1 (26 §3.1): platform-level, model-keyed price list, editable in
     * Settings → Providers. Shape:
     *   { "models": { "<model>": { in_per_mtok_cents, out_per_mtok_cents,
     *                              cached_in_per_mtok_cents } },
     *     "updated_at": "...", "source": "seed" | "manual" }
     * Empty `{}` falls back to `pricingDefaultsFor(kind)` so existing rows
     * keep today's behaviour. Historical `llm_calls.cost_cents` is never
     * re-priced (26 §3.1).
     */
    pricing: jsonb("pricing").notNull().default({}),
  },
  (t) => [
    uniqueIndex("model_providers_name_uq").on(t.name),
    check(
      "model_providers_kind_check",
      sql`${t.kind} IN ('anthropic','openai','openrouter','ollama','vllm')`,
    ),
  ],
);

/** 2.6 rate_limits [platform, UNLOGGED via hand-audited SQL] */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  tokens: real("tokens").notNull(),
  refilledAt: timestamp("refilled_at", { withTimezone: true }).notNull(),
});
