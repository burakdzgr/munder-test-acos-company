CREATE TABLE "agent_skills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"level" smallint DEFAULT 1 NOT NULL,
	"confidence" real DEFAULT 0.3 NOT NULL,
	"evidence_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"level_updated_at" timestamp with time zone,
	CONSTRAINT "agent_skills_level_check" CHECK ("agent_skills"."level" BETWEEN 1 AND 5),
	CONSTRAINT "agent_skills_confidence_check" CHECK ("agent_skills"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "performance_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"tasks_completed" integer DEFAULT 0 NOT NULL,
	"tasks_failed" integer DEFAULT 0 NOT NULL,
	"reviews_given" integer DEFAULT 0 NOT NULL,
	"reviews_received_approved" integer DEFAULT 0 NOT NULL,
	"reviews_received_changes" integer DEFAULT 0 NOT NULL,
	"escalations" integer DEFAULT 0 NOT NULL,
	"messages_sent" integer DEFAULT 0 NOT NULL,
	"tokens_total" bigint DEFAULT 0 NOT NULL,
	"cost_cents" bigint DEFAULT 0 NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_skill_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"weight" real NOT NULL,
	"ref" text NOT NULL,
	"note" text,
	CONSTRAINT "skill_evidence_kind_check" CHECK ("skill_evidence"."kind" IN ('task_success','review_accepted','production_result','peer_eval','manager_eval','experiment','failure','failure_resolved')),
	CONSTRAINT "skill_evidence_weight_check" CHECK ("skill_evidence"."weight" >= -1 AND "skill_evidence"."weight" <= 1)
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_snapshots" ADD CONSTRAINT "performance_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_snapshots" ADD CONSTRAINT "performance_snapshots_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_evidence" ADD CONSTRAINT "skill_evidence_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_evidence" ADD CONSTRAINT "skill_evidence_agent_skill_id_agent_skills_id_fk" FOREIGN KEY ("agent_skill_id") REFERENCES "public"."agent_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_skills_agent_skill_uq" ON "agent_skills" USING btree ("agent_id","skill_id");--> statement-breakpoint
CREATE INDEX "agent_skills_who_can_idx" ON "agent_skills" USING btree ("company_id","skill_id","level" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "performance_snapshots_agent_period_uq" ON "performance_snapshots" USING btree ("agent_id","period_start");--> statement-breakpoint
CREATE INDEX "skill_evidence_agent_skill_created_idx" ON "skill_evidence" USING btree ("agent_skill_id","created_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "skills_company_name_uq" ON "skills" USING btree ("company_id","name");