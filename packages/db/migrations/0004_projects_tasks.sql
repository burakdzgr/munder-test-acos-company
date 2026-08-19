CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"task_id" uuid,
	"git_ref" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"logs_uri" text,
	CONSTRAINT "deployments_status_check" CHECK ("deployments"."status" IN ('pending','running','succeeded','failed','rolled_back'))
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"base_url" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "environments_name_check" CHECK ("environments"."name" IN ('local','staging','production'))
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"role" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "project_members_role_check" CHECK ("project_members"."role" IN ('owner','architect','lead','engineer','qa','devops','marketer','stakeholder'))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"objective_md" text NOT NULL,
	"constraints_md" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"lead_agent_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"intake_report_artifact_id" uuid,
	"archived_at" timestamp with time zone,
	CONSTRAINT "projects_status_check" CHECK ("projects"."status" IN ('proposed','intake','active','paused','completed','archived','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"bare_path" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"origin_url" text,
	"github_remote" text,
	"imported_at" timestamp with time zone,
	"languages" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"task_id" uuid,
	"project_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"content_md" text,
	"uri" text,
	"git_ref" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_agent_id" uuid,
	CONSTRAINT "artifacts_kind_check" CHECK ("artifacts"."kind" IN ('code_diff','document','report','intake_report','executive_report','design','test_report','promotion_review','media','other')),
	CONSTRAINT "artifacts_content_check" CHECK ("artifacts"."content_md" IS NOT NULL OR "artifacts"."uri" IS NOT NULL OR "artifacts"."git_ref" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"task_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"workspace_id" uuid,
	"branch" text NOT NULL,
	"kind" text DEFAULT 'code' NOT NULL,
	"author_agent_id" uuid NOT NULL,
	"reviewer_agent_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"verdict_md" text,
	"diff_stat" jsonb,
	"merged_commit" text,
	"decided_at" timestamp with time zone,
	CONSTRAINT "reviews_kind_check" CHECK ("reviews"."kind" IN ('code','architecture','qa','security')),
	CONSTRAINT "reviews_status_check" CHECK ("reviews"."status" IN ('pending','in_review','changes_requested','approved','merged','abandoned')),
	CONSTRAINT "reviews_reviewer_not_author_check" CHECK ("reviews"."reviewer_agent_id" IS NULL OR "reviews"."reviewer_agent_id" <> "reviews"."author_agent_id")
);
--> statement-breakpoint
CREATE TABLE "task_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"role" text DEFAULT 'owner' NOT NULL,
	"assigned_by_agent_id" uuid,
	"reason" text,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unassigned_at" timestamp with time zone,
	CONSTRAINT "task_assignments_role_check" CHECK ("task_assignments"."role" IN ('owner','reviewer','qa','collaborator'))
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"task_id" uuid NOT NULL,
	"depends_on_task_id" uuid NOT NULL,
	"kind" text DEFAULT 'blocks' NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "task_dependencies_kind_check" CHECK ("task_dependencies"."kind" IN ('blocks')),
	CONSTRAINT "task_dependencies_no_self_check" CHECK ("task_dependencies"."task_id" <> "task_dependencies"."depends_on_task_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid,
	"parent_id" uuid,
	"number" integer NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"objective" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"creator_agent_id" uuid,
	"owner_agent_id" uuid,
	"org_unit_id" uuid,
	"priority" text DEFAULT 'P2' NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"success_criteria" text[] DEFAULT '{}'::text[] NOT NULL,
	"risk" text DEFAULT 'low' NOT NULL,
	"budget_cents" bigint,
	"spent_cents" bigint DEFAULT 0 NOT NULL,
	"deadline" timestamp with time zone,
	"approval_policy_id" uuid,
	"delegation_depth" smallint DEFAULT 0 NOT NULL,
	"reassignment_count" smallint DEFAULT 0 NOT NULL,
	"result" jsonb,
	"closed_at" timestamp with time zone,
	CONSTRAINT "tasks_no_self_parent_check" CHECK ("tasks"."parent_id" <> "tasks"."id"),
	CONSTRAINT "tasks_kind_check" CHECK ("tasks"."kind" IN ('goal','initiative','epic','task','subtask')),
	CONSTRAINT "tasks_priority_check" CHECK ("tasks"."priority" IN ('P0','P1','P2','P3')),
	CONSTRAINT "tasks_status_check" CHECK ("tasks"."status" IN ('DRAFT','BACKLOG','PLANNED','ASSIGNED','IN_PROGRESS','WAITING','BLOCKED','REVIEW','CHANGES_REQUESTED','QA','QA_FAILED','APPROVAL','REJECTED','DONE','FAILED','CANCELLED')),
	CONSTRAINT "tasks_risk_check" CHECK ("tasks"."risk" IN ('low','medium','high','critical')),
	CONSTRAINT "tasks_delegation_depth_check" CHECK ("tasks"."delegation_depth" <= 5),
	CONSTRAINT "tasks_reassignment_count_check" CHECK ("tasks"."reassignment_count" <= 3)
);
--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_lead_agent_id_agents_id_fk" FOREIGN KEY ("lead_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignments" ADD CONSTRAINT "task_assignments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignments" ADD CONSTRAINT "task_assignments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignments" ADD CONSTRAINT "task_assignments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignments" ADD CONSTRAINT "task_assignments_assigned_by_agent_id_agents_id_fk" FOREIGN KEY ("assigned_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_task_id_tasks_id_fk" FOREIGN KEY ("depends_on_task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_id_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_creator_agent_id_agents_id_fk" FOREIGN KEY ("creator_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_org_unit_id_org_units_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."org_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deployments_project_created_idx" ON "deployments" USING btree ("project_id","created_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "environments_project_name_uq" ON "environments" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "project_members_active_uq" ON "project_members" USING btree ("project_id","agent_id","role") WHERE "project_members"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "project_members_agent_idx" ON "project_members" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_company_slug_uq" ON "projects" USING btree ("company_id","slug");--> statement-breakpoint
CREATE INDEX "projects_company_status_idx" ON "projects" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_project_name_uq" ON "repositories" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_bare_path_uq" ON "repositories" USING btree ("bare_path");--> statement-breakpoint
CREATE INDEX "artifacts_task_idx" ON "artifacts" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "artifacts_project_kind_idx" ON "artifacts" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "artifacts_company_kind_created_idx" ON "artifacts" USING btree ("company_id","kind","created_at" DESC);--> statement-breakpoint
CREATE INDEX "reviews_task_idx" ON "reviews" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "reviews_reviewer_inbox_pidx" ON "reviews" USING btree ("company_id","reviewer_agent_id") WHERE "reviews"."status" IN ('pending','in_review');--> statement-breakpoint
CREATE INDEX "reviews_project_created_idx" ON "reviews" USING btree ("project_id","created_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "task_assignments_single_owner_uq" ON "task_assignments" USING btree ("task_id","role") WHERE "task_assignments"."role" = 'owner' AND "task_assignments"."unassigned_at" IS NULL;--> statement-breakpoint
CREATE INDEX "task_assignments_task_assigned_idx" ON "task_assignments" USING btree ("task_id","assigned_at");--> statement-breakpoint
CREATE INDEX "task_assignments_agent_active_pidx" ON "task_assignments" USING btree ("agent_id") WHERE "task_assignments"."unassigned_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "task_dependencies_pair_uq" ON "task_dependencies" USING btree ("task_id","depends_on_task_id");--> statement-breakpoint
CREATE INDEX "task_dependencies_unresolved_pidx" ON "task_dependencies" USING btree ("depends_on_task_id") WHERE "task_dependencies"."resolved_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_company_number_uq" ON "tasks" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "tasks_company_status_idx" ON "tasks" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "tasks_company_project_status_idx" ON "tasks" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE INDEX "tasks_owner_open_pidx" ON "tasks" USING btree ("owner_agent_id") WHERE "tasks"."status" IN ('ASSIGNED','IN_PROGRESS','WAITING','BLOCKED','REVIEW','CHANGES_REQUESTED','QA','QA_FAILED','APPROVAL');--> statement-breakpoint
CREATE INDEX "tasks_parent_idx" ON "tasks" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "tasks_company_deadline_pidx" ON "tasks" USING btree ("company_id","deadline") WHERE "tasks"."deadline" IS NOT NULL AND "tasks"."closed_at" IS NULL;
--> statement-breakpoint
-- Hand-audited late FKs (20 §19): targets created in/after this migration.
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_intake_report_artifact_id_fk" FOREIGN KEY ("intake_report_artifact_id") REFERENCES "artifacts"("id") ON DELETE restrict;
