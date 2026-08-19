CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"number" integer NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"request_md" text NOT NULL,
	"requested_by_agent_id" uuid NOT NULL,
	"chain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"risk" text NOT NULL,
	"cost_cents" bigint,
	"urgency" text DEFAULT 'normal' NOT NULL,
	"deadline" timestamp with time zone,
	"task_id" uuid,
	"workflow_id" text,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	CONSTRAINT "approvals_kind_check" CHECK ("approvals"."kind" IN ('tool_execution','budget_increase','hire','promotion','deployment','vendor','legal_financial','other')),
	CONSTRAINT "approvals_status_check" CHECK ("approvals"."status" IN ('pending','approved','rejected','needs_review','expired')),
	CONSTRAINT "approvals_risk_check" CHECK ("approvals"."risk" IN ('low','medium','high','critical')),
	CONSTRAINT "approvals_urgency_check" CHECK ("approvals"."urgency" IN ('low','normal','high','critical'))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_kind" text,
	"target_id" uuid,
	"ip" "inet",
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "audit_log_actor_kind_check" CHECK ("audit_log"."actor_kind" IN ('user','agent','system'))
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"effect" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"rule" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policies_kind_check" CHECK ("policies"."kind" IN ('tool','budget','escalation','standing_approval','memory_promotion','approval_routing')),
	CONSTRAINT "policies_effect_check" CHECK ("policies"."effect" IN ('allow','deny','require_approval'))
);
--> statement-breakpoint
CREATE TABLE "tool_invocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_id" uuid NOT NULL,
	"task_id" uuid,
	"agent_session_id" uuid,
	"tool_name" text NOT NULL,
	"risk_class" text NOT NULL,
	"input" jsonb NOT NULL,
	"decision" text NOT NULL,
	"decision_reason" text NOT NULL,
	"approval_id" uuid,
	"status" text NOT NULL,
	"workspace_id" uuid,
	"result_summary" text,
	"error" text,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"finished_at" timestamp with time zone,
	CONSTRAINT "tool_invocations_risk_class_check" CHECK ("tool_invocations"."risk_class" IN ('R0','R1','R2','R3')),
	CONSTRAINT "tool_invocations_decision_check" CHECK ("tool_invocations"."decision" IN ('allow','deny','require_approval')),
	CONSTRAINT "tool_invocations_status_check" CHECK ("tool_invocations"."status" IN ('denied','awaiting_approval','dispatched','succeeded','failed'))
);
--> statement-breakpoint
CREATE TABLE "tool_permissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tool_name" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"constraints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"granted_by_user_id" uuid,
	"granted_by_agent_id" uuid,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "tool_permissions_subject_kind_check" CHECK ("tool_permissions"."subject_kind" IN ('agent','position','org_unit'))
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"description" text NOT NULL,
	"risk_class" text NOT NULL,
	"scopes" text[] NOT NULL,
	"input_schema" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tools_risk_class_check" CHECK ("tools"."risk_class" IN ('R0','R1','R2','R3'))
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_permissions" ADD CONSTRAINT "tool_permissions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_permissions" ADD CONSTRAINT "tool_permissions_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_permissions" ADD CONSTRAINT "tool_permissions_granted_by_agent_id_agents_id_fk" FOREIGN KEY ("granted_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_company_number_uq" ON "approvals" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "approvals_pending_pidx" ON "approvals" USING btree ("company_id","urgency") WHERE "approvals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "approvals_requester_created_idx" ON "approvals" USING btree ("requested_by_agent_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "audit_log_company_created_idx" ON "audit_log" USING btree ("company_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "audit_log_action_created_idx" ON "audit_log" USING btree ("action","created_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "policies_company_name_uq" ON "policies" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "policies_company_kind_enabled_pidx" ON "policies" USING btree ("company_id","kind") WHERE "policies"."enabled";--> statement-breakpoint
CREATE INDEX "tool_invocations_company_created_idx" ON "tool_invocations" USING btree ("company_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "tool_invocations_agent_created_idx" ON "tool_invocations" USING btree ("agent_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "tool_invocations_awaiting_pidx" ON "tool_invocations" USING btree ("company_id") WHERE "tool_invocations"."status" = 'awaiting_approval';--> statement-breakpoint
CREATE INDEX "tool_invocations_tool_created_idx" ON "tool_invocations" USING btree ("tool_name","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_permissions_active_uq" ON "tool_permissions" USING btree ("company_id","tool_name","subject_kind","subject_id") WHERE "tool_permissions"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tool_permissions_subject_idx" ON "tool_permissions" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tools_name_version_uq" ON "tools" USING btree ("name","version");--> statement-breakpoint
CREATE UNIQUE INDEX "tools_name_enabled_uq" ON "tools" USING btree ("name") WHERE "tools"."enabled";
--> statement-breakpoint
-- Hand-audited late FKs (20 §19).
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_approval_policy_id_fk" FOREIGN KEY ("approval_policy_id") REFERENCES "policies"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "memory_promotions" ADD CONSTRAINT "memory_promotions_rule_policy_id_fk" FOREIGN KEY ("rule_policy_id") REFERENCES "policies"("id") ON DELETE restrict;
