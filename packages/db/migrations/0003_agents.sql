CREATE TABLE "agent_model_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"provider_id" uuid NOT NULL,
	"model" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "agent_model_bindings_purpose_check" CHECK ("agent_model_bindings"."purpose" IN ('primary','fast','embedding'))
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_id" uuid NOT NULL,
	"task_id" uuid,
	"workflow_id" text NOT NULL,
	"run_id" text NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"current_activity" text DEFAULT 'IDLE' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"steps_count" integer DEFAULT 0 NOT NULL,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"cost_cents" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "agent_sessions_status_check" CHECK ("agent_sessions"."status" IN ('starting','running','waiting','completed','failed','cancelled')),
	CONSTRAINT "agent_sessions_activity_check" CHECK ("agent_sessions"."current_activity" IN ('IDLE','THINKING','WORKING','WAITING','COMMUNICATING','REVIEWING','TESTING','LEARNING','BLOCKED','ESCALATING','OFFLINE'))
);
--> statement-breakpoint
CREATE TABLE "agent_steps" (
	"id" uuid,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_session_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"task_id" uuid,
	"step_no" integer NOT NULL,
	"action_kind" text NOT NULL,
	"action" jsonb NOT NULL,
	"observation" jsonb,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	CONSTRAINT "agent_steps_id_created_at_pk" PRIMARY KEY("id","created_at"),
	CONSTRAINT "agent_steps_action_kind_check" CHECK ("agent_steps"."action_kind" IN ('use_tool','send_message','create_task','delegate_task','request_review','request_help','escalate','update_task_status','record_decision','complete_task','wait_for','abandon'))

) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_number" integer NOT NULL,
	"name" text NOT NULL,
	"avatar_url" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"position_id" uuid NOT NULL,
	"org_unit_id" uuid NOT NULL,
	"seniority" text DEFAULT 'junior' NOT NULL,
	"autonomy_level" smallint DEFAULT 2 NOT NULL,
	"persona" text NOT NULL,
	"employment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "agents_status_check" CHECK ("agents"."status" IN ('draft','active','paused','offboarded')),
	CONSTRAINT "agents_seniority_check" CHECK ("agents"."seniority" IN ('junior','mid','senior','staff','lead','expert')),
	CONSTRAINT "agents_autonomy_level_check" CHECK ("agents"."autonomy_level" BETWEEN 0 AND 5)
);
--> statement-breakpoint
CREATE TABLE "org_edges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_agent_id" uuid NOT NULL,
	"to_agent_id" uuid,
	"to_unit_id" uuid,
	"kind" text NOT NULL,
	"strength" real,
	"ended_at" timestamp with time zone,
	CONSTRAINT "org_edges_kind_check" CHECK ("org_edges"."kind" IN ('reports_to','manages','member_of','leads','mentors','collaborates_with')),
	CONSTRAINT "org_edges_exactly_one_target_check" CHECK (("org_edges"."to_agent_id" IS NULL) <> ("org_edges"."to_unit_id" IS NULL)),
	CONSTRAINT "org_edges_unit_kind_target_check" CHECK (("org_edges"."kind" IN ('member_of','leads')) = ("org_edges"."to_unit_id" IS NOT NULL)),
	CONSTRAINT "org_edges_strength_check" CHECK ("org_edges"."strength" BETWEEN 0 AND 1)
);
--> statement-breakpoint
ALTER TABLE "agent_model_bindings" ADD CONSTRAINT "agent_model_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_model_bindings" ADD CONSTRAINT "agent_model_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_model_bindings" ADD CONSTRAINT "agent_model_bindings_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_unit_id_org_units_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."org_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_edges" ADD CONSTRAINT "org_edges_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_edges" ADD CONSTRAINT "org_edges_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_edges" ADD CONSTRAINT "org_edges_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_edges" ADD CONSTRAINT "org_edges_to_unit_id_org_units_id_fk" FOREIGN KEY ("to_unit_id") REFERENCES "public"."org_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_model_bindings_agent_purpose_priority_uq" ON "agent_model_bindings" USING btree ("agent_id","purpose","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_workflow_run_uq" ON "agent_sessions" USING btree ("workflow_id","run_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_live_pidx" ON "agent_sessions" USING btree ("company_id","agent_id") WHERE "agent_sessions"."status" IN ('starting','running','waiting');--> statement-breakpoint
CREATE INDEX "agent_sessions_agent_started_idx" ON "agent_sessions" USING btree ("agent_id","started_at" DESC);--> statement-breakpoint
CREATE INDEX "agent_steps_session_step_idx" ON "agent_steps" USING btree ("agent_session_id","step_no");--> statement-breakpoint
CREATE INDEX "agent_steps_company_created_idx" ON "agent_steps" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_steps_task_created_idx" ON "agent_steps" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_company_employee_number_uq" ON "agents" USING btree ("company_id","employee_number");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_company_name_active_uq" ON "agents" USING btree ("company_id",lower("name")) WHERE "agents"."status" <> 'offboarded';--> statement-breakpoint
CREATE INDEX "agents_company_status_idx" ON "agents" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "agents_company_org_unit_idx" ON "agents" USING btree ("company_id","org_unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_edges_reports_to_single_manager_uq" ON "org_edges" USING btree ("from_agent_id") WHERE "org_edges"."kind" = 'reports_to' AND "org_edges"."ended_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "org_edges_agent_edge_active_uq" ON "org_edges" USING btree ("from_agent_id","to_agent_id","kind") WHERE "org_edges"."ended_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "org_edges_unit_edge_active_uq" ON "org_edges" USING btree ("from_agent_id","to_unit_id","kind") WHERE "org_edges"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "org_edges_company_kind_idx" ON "org_edges" USING btree ("company_id","kind");--> statement-breakpoint
CREATE INDEX "org_edges_to_agent_idx" ON "org_edges" USING btree ("to_agent_id");--> statement-breakpoint
CREATE INDEX "org_edges_to_unit_idx" ON "org_edges" USING btree ("to_unit_id");
--> statement-breakpoint
-- Hand-audited (20 §4.6, §17): monthly partitions — current month + next two.
DO $$
DECLARE
  m date := date_trunc('month', now())::date;
BEGIN
  FOR i IN 0..2 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS agent_steps_%s PARTITION OF agent_steps FOR VALUES FROM (%L) TO (%L)',
      to_char(m + (i || ' month')::interval, 'YYYYMM'),
      m + (i || ' month')::interval,
      m + ((i + 1) || ' month')::interval
    );
  END LOOP;
END $$;
