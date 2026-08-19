CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_ref" uuid,
	"period" text NOT NULL,
	"limit_cents" bigint NOT NULL,
	"kind" text DEFAULT 'soft' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_scope_kind_check" CHECK ("budgets"."scope_kind" IN ('company','org_unit','project','task','agent')),
	CONSTRAINT "budgets_scope_ref_check" CHECK (("budgets"."scope_kind" = 'company') = ("budgets"."scope_ref" IS NULL)),
	CONSTRAINT "budgets_period_check" CHECK ("budgets"."period" IN ('daily','weekly','monthly','total')),
	CONSTRAINT "budgets_limit_check" CHECK ("budgets"."limit_cents" > 0),
	CONSTRAINT "budgets_kind_check" CHECK ("budgets"."kind" IN ('hard','soft'))
);
--> statement-breakpoint
CREATE TABLE "cost_entries" (
	"id" uuid,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"agent_id" uuid,
	"task_id" uuid,
	"project_id" uuid,
	"org_unit_id" uuid,
	"amount_cents" bigint NOT NULL,
	"quantity" numeric,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_entries_id_occurred_at_pk" PRIMARY KEY("id","occurred_at"),
	CONSTRAINT "cost_entries_kind_check" CHECK ("cost_entries"."kind" IN ('llm','tool','compute','media','api')),
	CONSTRAINT "cost_entries_amount_check" CHECK ("cost_entries"."amount_cents" >= 0)
) PARTITION BY RANGE ("occurred_at");
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_id" uuid,
	"task_id" uuid,
	"agent_session_id" uuid,
	"purpose" text NOT NULL,
	"provider_id" uuid NOT NULL,
	"model" text NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"tokens_cached" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"status" text NOT NULL,
	"error" text,
	"fallback_rank" smallint DEFAULT 0 NOT NULL,
	"correlation_id" uuid,
	CONSTRAINT "llm_calls_purpose_check" CHECK ("llm_calls"."purpose" IN ('reasoning','coding','fast','embedding','vision')),
	CONSTRAINT "llm_calls_status_check" CHECK ("llm_calls"."status" IN ('ok','error','timeout','rate_limited'))
);
--> statement-breakpoint
CREATE TABLE "terminal_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid,
	"title" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"cols" smallint DEFAULT 120 NOT NULL,
	"rows" smallint DEFAULT 32 NOT NULL,
	"log_path" text NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "terminal_sessions_status_check" CHECK ("terminal_sessions"."status" IN ('active','closed'))
);
--> statement-breakpoint
CREATE TABLE "workspace_locks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"path_prefix" text NOT NULL,
	"task_id" uuid,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid,
	"repository_id" uuid,
	"agent_id" uuid,
	"isolation_level" text NOT NULL,
	"image" text NOT NULL,
	"container_id" text,
	"branch" text,
	"volume_path" text,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"destroyed_at" timestamp with time zone,
	CONSTRAINT "workspaces_isolation_level_check" CHECK ("workspaces"."isolation_level" IN ('analysis','coding','testing','deploy','browser','media')),
	CONSTRAINT "workspaces_status_check" CHECK ("workspaces"."status" IN ('provisioning','ready','in_use','idle','merged','discarded','failed','destroyed'))
);
--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_locks" ADD CONSTRAINT "workspace_locks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_locks" ADD CONSTRAINT "workspace_locks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_locks" ADD CONSTRAINT "workspace_locks_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_locks" ADD CONSTRAINT "workspace_locks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_scope_period_uq" ON "budgets" USING btree ("company_id","scope_kind",coalesce("scope_ref", '00000000-0000-0000-0000-000000000000'::uuid),"period");--> statement-breakpoint
CREATE INDEX "cost_entries_company_occurred_idx" ON "cost_entries" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE INDEX "cost_entries_task_occurred_idx" ON "cost_entries" USING btree ("task_id","occurred_at");--> statement-breakpoint
CREATE INDEX "cost_entries_agent_occurred_idx" ON "cost_entries" USING btree ("agent_id","occurred_at");--> statement-breakpoint
CREATE INDEX "cost_entries_project_occurred_idx" ON "cost_entries" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "llm_calls_company_created_idx" ON "llm_calls" USING btree ("company_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "llm_calls_agent_created_idx" ON "llm_calls" USING btree ("agent_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "llm_calls_provider_unhealthy_pidx" ON "llm_calls" USING btree ("provider_id","created_at") WHERE "llm_calls"."status" <> 'ok';--> statement-breakpoint
CREATE INDEX "terminal_sessions_active_pidx" ON "terminal_sessions" USING btree ("company_id") WHERE "terminal_sessions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "workspace_locks_overlap_pidx" ON "workspace_locks" USING btree ("repository_id","path_prefix") WHERE "workspace_locks"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "workspaces_live_pidx" ON "workspaces" USING btree ("company_id","status") WHERE "workspaces"."status" NOT IN ('destroyed');--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_task_level_live_uq" ON "workspaces" USING btree ("task_id","isolation_level") WHERE "workspaces"."status" NOT IN ('merged','discarded','failed','destroyed');--> statement-breakpoint
CREATE INDEX "workspaces_project_idx" ON "workspaces" USING btree ("project_id");
--> statement-breakpoint
-- Hand-audited (20 §13.2, §16, §19): partitions, late FKs, rollup matview.
DO $$
DECLARE m date := date_trunc('month', now())::date;
BEGIN
  FOR i IN 0..2 LOOP
    EXECUTE format('CREATE TABLE IF NOT EXISTS cost_entries_%s PARTITION OF cost_entries FOR VALUES FROM (%L) TO (%L)',
      to_char(m + (i || ' month')::interval, 'YYYYMM'),
      m + (i || ' month')::interval, m + ((i + 1) || ' month')::interval);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE MATERIALIZED VIEW "cost_rollup_daily" AS SELECT company_id, (occurred_at AT TIME ZONE 'UTC')::date AS day, kind, agent_id, task_id, project_id, org_unit_id, sum(amount_cents) AS amount_cents, sum(quantity) AS quantity FROM cost_entries GROUP BY 1,2,3,4,5,6,7;
--> statement-breakpoint
CREATE UNIQUE INDEX "cost_rollup_daily_uq" ON "cost_rollup_daily" (company_id, day, kind, coalesce(agent_id,'00000000-0000-0000-0000-000000000000'::uuid), coalesce(task_id,'00000000-0000-0000-0000-000000000000'::uuid), coalesce(project_id,'00000000-0000-0000-0000-000000000000'::uuid), coalesce(org_unit_id,'00000000-0000-0000-0000-000000000000'::uuid));
