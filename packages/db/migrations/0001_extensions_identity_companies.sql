-- Hand-audited (20 §1, §19): extensions land first; rate_limits is UNLOGGED.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gin;--> statement-breakpoint
CREATE TABLE "model_providers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text,
	"api_key_enc" "bytea",
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "model_providers_kind_check" CHECK ("model_providers"."kind" IN ('anthropic','openai','openrouter','ollama','vllm'))
);
--> statement-breakpoint
CREATE TABLE "personal_access_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNLOGGED TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"tokens" real NOT NULL,
	"refilled_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"totp_secret_enc" "bytea",
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"platform_role" text DEFAULT 'owner' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_platform_role_check" CHECK ("users"."platform_role" IN ('owner','admin','member')),
	CONSTRAINT "users_status_check" CHECK ("users"."status" IN ('active','disabled'))
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	CONSTRAINT "companies_currency_check" CHECK (char_length("companies"."currency") = 3),
	CONSTRAINT "companies_status_check" CHECK ("companies"."status" IN ('active','archived'))
);
--> statement-breakpoint
CREATE TABLE "company_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'founder' NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "company_members_role_check" CHECK ("company_members"."role" IN ('founder','admin','viewer'))
);
--> statement-breakpoint
CREATE TABLE "company_sequences" (
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "company_sequences_company_id_name_pk" PRIMARY KEY("company_id","name"),
	CONSTRAINT "company_sequences_name_check" CHECK ("company_sequences"."name" IN ('event_seq','task_number','employee_number','decision_number','incident_number','approval_number'))
);
--> statement-breakpoint
CREATE TABLE "company_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"output_language" text DEFAULT 'en' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"default_autonomy_level" smallint DEFAULT 2 NOT NULL,
	"daily_spend_limit_cents" bigint,
	"consolidation_event_threshold" integer DEFAULT 25 NOT NULL,
	"memory_token_budget_agent" integer DEFAULT 1500 NOT NULL,
	"memory_token_budget_project" integer DEFAULT 2500 NOT NULL,
	"memory_token_budget_company" integer DEFAULT 1000 NOT NULL,
	"embedding_purpose_override" text,
	"terminal_log_retention_days" smallint DEFAULT 7 NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "company_settings_autonomy_check" CHECK ("company_settings"."default_autonomy_level" BETWEEN 0 AND 5)
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key" text NOT NULL,
	"endpoint" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" smallint,
	"response_body" jsonb,
	"locked_at" timestamp with time zone,
	"expires_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL,
	CONSTRAINT "idempotency_keys_company_key_endpoint_uq" UNIQUE NULLS NOT DISTINCT("company_id","key","endpoint")
);
--> statement-breakpoint
CREATE TABLE "model_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purpose" text NOT NULL,
	"provider_id" uuid NOT NULL,
	"model" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"max_tokens_per_call" integer,
	"cost_cap_cents_per_call" integer,
	"priority" smallint DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "model_profiles_purpose_check" CHECK ("model_profiles"."purpose" IN ('reasoning','coding','fast','embedding','vision'))
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"scope" text DEFAULT 'company' NOT NULL,
	"project_id" uuid,
	"ciphertext" "bytea" NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"rotated_at" timestamp with time zone,
	CONSTRAINT "secrets_scope_check" CHECK ("secrets"."scope" IN ('company','project','integration'))
);
--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_sequences" ADD CONSTRAINT "company_sequences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_profiles" ADD CONSTRAINT "model_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_profiles" ADD CONSTRAINT "model_profiles_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_providers_name_uq" ON "model_providers" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_access_tokens_token_hash_uq" ON "personal_access_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_access_tokens_user_id_name_uq" ON "personal_access_tokens" USING btree ("user_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_active_pidx" ON "sessions" USING btree ("expires_at") WHERE "sessions"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "companies_slug_uq" ON "companies" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "company_members_company_user_active_uq" ON "company_members" USING btree ("company_id","user_id") WHERE "company_members"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "model_profiles_company_purpose_priority_uq" ON "model_profiles" USING btree ("company_id","purpose","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_scope_name_uq" ON "secrets" USING btree ("company_id","scope",coalesce("project_id", '00000000-0000-0000-0000-000000000000'::uuid),"name");