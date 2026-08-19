CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"context_md" text NOT NULL,
	"decision_md" text NOT NULL,
	"consequences_md" text,
	"decided_by_agent_id" uuid,
	"task_id" uuid,
	"supersedes_decision_id" uuid,
	"decided_at" timestamp with time zone,
	CONSTRAINT "decisions_status_check" CHECK ("decisions"."status" IN ('proposed','accepted','superseded','deprecated','rejected'))
);
--> statement-breakpoint
CREATE TABLE "experiment_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"experiment_id" uuid NOT NULL,
	"arm" text NOT NULL,
	"metric_key" text NOT NULL,
	"value" numeric NOT NULL,
	"sample" integer,
	"confidence" real,
	"measured_at" timestamp with time zone NOT NULL,
	CONSTRAINT "experiment_results_arm_check" CHECK ("experiment_results"."arm" IN ('baseline','variant')),
	CONSTRAINT "experiment_results_confidence_check" CHECK ("experiment_results"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid,
	"owner_agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"hypothesis_md" text NOT NULL,
	"baseline_md" text,
	"variant_md" text,
	"metric_defs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sample_size" integer,
	"status" text DEFAULT 'designed' NOT NULL,
	"decision_md" text,
	"learning_memory_id" uuid,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "experiments_status_check" CHECK ("experiments"."status" IN ('designed','baseline','running','analyzing','adopted','rejected','inconclusive'))
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"number" integer NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"summary_md" text NOT NULL,
	"project_id" uuid,
	"task_id" uuid,
	"detected_by_agent_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mitigated_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"postmortem_md" text,
	"postmortem_status" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "incidents_severity_check" CHECK ("incidents"."severity" IN ('sev1','sev2','sev3','sev4')),
	CONSTRAINT "incidents_status_check" CHECK ("incidents"."status" IN ('open','mitigated','resolved','closed')),
	CONSTRAINT "incidents_postmortem_status_check" CHECK ("incidents"."postmortem_status" IN ('pending','drafted','reviewed','published'))
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scope" text NOT NULL,
	"scope_ref" uuid,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"summary" text NOT NULL,
	"entities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"importance" real NOT NULL,
	"confidence" real NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"source_event_id" uuid,
	"created_by_agent_id" uuid,
	"last_verified_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"retrieval_count" integer DEFAULT 0 NOT NULL,
	"embedding" vector,
	"embedding_model" text,
	"embedding_dim" smallint,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memories_scope_check" CHECK ("memories"."scope" IN ('company','project','agent')),
	CONSTRAINT "memories_scope_ref_check" CHECK (("memories"."scope" = 'company') = ("memories"."scope_ref" IS NULL)),
	CONSTRAINT "memories_type_check" CHECK ("memories"."type" IN ('semantic','episodic','procedural','decision','failure','experiment','relationship','artifact')),
	CONSTRAINT "memories_importance_check" CHECK ("memories"."importance" BETWEEN 0 AND 1),
	CONSTRAINT "memories_confidence_check" CHECK ("memories"."confidence" BETWEEN 0 AND 1),
	CONSTRAINT "memories_status_check" CHECK ("memories"."status" IN ('candidate','active','superseded','archived','rejected'))
);
--> statement-breakpoint
CREATE TABLE "memory_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"memory_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	CONSTRAINT "memory_evidence_kind_check" CHECK ("memory_evidence"."kind" IN ('event','artifact','review','metric','statement','incident')),
	CONSTRAINT "memory_evidence_weight_check" CHECK ("memory_evidence"."weight" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "memory_promotions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_memory_id" uuid NOT NULL,
	"target_scope" text NOT NULL,
	"target_ref" uuid,
	"target_memory_id" uuid,
	"evidence_count" integer DEFAULT 0 NOT NULL,
	"distinct_task_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"approver_agent_id" uuid,
	"rule_policy_id" uuid,
	"decided_at" timestamp with time zone,
	CONSTRAINT "memory_promotions_target_scope_check" CHECK ("memory_promotions"."target_scope" IN ('project','company')),
	CONSTRAINT "memory_promotions_status_check" CHECK ("memory_promotions"."status" IN ('proposed','approved','rejected'))
);
--> statement-breakpoint
CREATE TABLE "memory_relations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_memory_id" uuid NOT NULL,
	"to_memory_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "memory_relations_kind_check" CHECK ("memory_relations"."kind" IN ('supports','contradicts','supersedes','derived_from','related_to')),
	CONSTRAINT "memory_relations_created_by_check" CHECK ("memory_relations"."created_by" IN ('system','agent','founder')),
	CONSTRAINT "memory_relations_no_self_check" CHECK ("memory_relations"."from_memory_id" <> "memory_relations"."to_memory_id")
);
--> statement-breakpoint
CREATE TABLE "memory_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"memory_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"summary" text NOT NULL,
	"importance" real NOT NULL,
	"confidence" real NOT NULL,
	"status" text NOT NULL,
	"changed_by" text NOT NULL,
	"changed_by_ref" uuid,
	"change_reason" text,
	CONSTRAINT "memory_versions_changed_by_check" CHECK ("memory_versions"."changed_by" IN ('system','agent','founder'))
);
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_decided_by_agent_id_agents_id_fk" FOREIGN KEY ("decided_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_supersedes_decision_id_decisions_id_fk" FOREIGN KEY ("supersedes_decision_id") REFERENCES "public"."decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_results" ADD CONSTRAINT "experiment_results_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_results" ADD CONSTRAINT "experiment_results_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_learning_memory_id_memories_id_fk" FOREIGN KEY ("learning_memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_detected_by_agent_id_agents_id_fk" FOREIGN KEY ("detected_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_evidence" ADD CONSTRAINT "memory_evidence_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_evidence" ADD CONSTRAINT "memory_evidence_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_promotions" ADD CONSTRAINT "memory_promotions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_promotions" ADD CONSTRAINT "memory_promotions_source_memory_id_memories_id_fk" FOREIGN KEY ("source_memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_promotions" ADD CONSTRAINT "memory_promotions_target_memory_id_memories_id_fk" FOREIGN KEY ("target_memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_promotions" ADD CONSTRAINT "memory_promotions_approver_agent_id_agents_id_fk" FOREIGN KEY ("approver_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_from_memory_id_memories_id_fk" FOREIGN KEY ("from_memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_to_memory_id_memories_id_fk" FOREIGN KEY ("to_memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_versions" ADD CONSTRAINT "memory_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_versions" ADD CONSTRAINT "memory_versions_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_company_number_uq" ON "decisions" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "decisions_project_status_idx" ON "decisions" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "experiment_results_series_idx" ON "experiment_results" USING btree ("experiment_id","metric_key","measured_at");--> statement-breakpoint
CREATE INDEX "experiments_company_status_idx" ON "experiments" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_company_number_uq" ON "incidents" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "incidents_live_pidx" ON "incidents" USING btree ("company_id","severity") WHERE "incidents"."status" IN ('open','mitigated');--> statement-breakpoint
CREATE INDEX "memories_scope_window_idx" ON "memories" USING btree ("company_id","scope","scope_ref","status");--> statement-breakpoint
CREATE INDEX "memories_company_type_status_idx" ON "memories" USING btree ("company_id","type","status");--> statement-breakpoint
CREATE INDEX "memories_candidate_pidx" ON "memories" USING btree ("company_id","created_at") WHERE "memories"."status" = 'candidate';--> statement-breakpoint
CREATE INDEX "memories_entities_gin" ON "memories" USING gin ("entities" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "memories_title_trgm_gin" ON "memories" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "memory_evidence_memory_idx" ON "memory_evidence" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX "memory_evidence_company_ref_idx" ON "memory_evidence" USING btree ("company_id","ref");--> statement-breakpoint
CREATE INDEX "memory_promotions_proposed_pidx" ON "memory_promotions" USING btree ("company_id") WHERE "memory_promotions"."status" = 'proposed';--> statement-breakpoint
CREATE UNIQUE INDEX "memory_relations_triple_uq" ON "memory_relations" USING btree ("from_memory_id","to_memory_id","kind");--> statement-breakpoint
CREATE INDEX "memory_relations_to_idx" ON "memory_relations" USING btree ("to_memory_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_versions_memory_version_uq" ON "memory_versions" USING btree ("memory_id","version");
--> statement-breakpoint
-- Hand-audited (20 §10.1, ADR-020): HNSW per active embedding dimension.
CREATE INDEX "memories_emb_1536_hnsw" ON "memories" USING hnsw ((embedding::vector(1536)) vector_cosine_ops) WHERE embedding_dim = 1536;
--> statement-breakpoint
CREATE INDEX "memories_emb_768_hnsw" ON "memories" USING hnsw ((embedding::vector(768)) vector_cosine_ops) WHERE embedding_dim = 768;
