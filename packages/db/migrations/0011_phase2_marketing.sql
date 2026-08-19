CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"uri" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" bigint,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"embedding" vector,
	"embedding_model" text,
	"embedding_dim" smallint,
	"created_by_agent_id" uuid,
	"archived_at" timestamp with time zone,
	CONSTRAINT "assets_kind_check" CHECK ("assets"."kind" IN ('image','video','audio','copy','template','brand'))
);
--> statement-breakpoint
CREATE TABLE "content_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid,
	"platform" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'idea' NOT NULL,
	"title" text NOT NULL,
	"brief_md" text,
	"script_md" text,
	"asset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"owner_agent_id" uuid,
	"experiment_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_items_platform_check" CHECK ("content_items"."platform" IN ('instagram','tiktok','youtube','x','linkedin','blog','other')),
	CONSTRAINT "content_items_kind_check" CHECK ("content_items"."kind" IN ('reel','post','story','article','ad','carousel')),
	CONSTRAINT "content_items_status_check" CHECK ("content_items"."status" IN ('idea','concept','script','production','qa','scheduled','published','archived'))
);
--> statement-breakpoint
CREATE TABLE "metric_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_item_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"views" bigint,
	"likes" integer,
	"comments" integer,
	"shares" integer,
	"saves" integer,
	"ctr" real,
	"watch_time_s" bigint,
	"followers_delta" integer,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publish_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_item_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"external_id" text,
	"error" text,
	"published_at" timestamp with time zone,
	CONSTRAINT "publish_jobs_status_check" CHECK ("publish_jobs"."status" IN ('scheduled','publishing','published','failed','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_snapshots" ADD CONSTRAINT "metric_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_snapshots" ADD CONSTRAINT "metric_snapshots_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_tags_gin" ON "assets" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "assets_company_kind_idx" ON "assets" USING btree ("company_id","kind");--> statement-breakpoint
CREATE INDEX "content_items_company_platform_status_idx" ON "content_items" USING btree ("company_id","platform","status");--> statement-breakpoint
CREATE INDEX "content_items_asset_ids_gin" ON "content_items" USING gin ("asset_ids");--> statement-breakpoint
CREATE UNIQUE INDEX "metric_snapshots_content_platform_captured_uq" ON "metric_snapshots" USING btree ("content_item_id","platform","captured_at");--> statement-breakpoint
CREATE INDEX "metric_snapshots_company_captured_idx" ON "metric_snapshots" USING btree ("company_id","captured_at");--> statement-breakpoint
CREATE INDEX "publish_jobs_dispatcher_pidx" ON "publish_jobs" USING btree ("scheduled_at") WHERE "publish_jobs"."status" = 'scheduled';
--> statement-breakpoint
-- Hand-audited (20 §15.2): HNSW per active embedding dimension.
CREATE INDEX "assets_emb_1536_hnsw" ON "assets" USING hnsw ((embedding::vector(1536)) vector_cosine_ops) WHERE embedding_dim = 1536;
--> statement-breakpoint
CREATE INDEX "assets_emb_768_hnsw" ON "assets" USING hnsw ((embedding::vector(768)) vector_cosine_ops) WHERE embedding_dim = 768;
