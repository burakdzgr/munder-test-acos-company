-- 12 §4.5 / §7.4–7.5 (T45): UNLOGGED retrieval observability. Hand-audited:
-- UNLOGGED added to the generated shape (drizzle has no flag for it); FK to
-- companies kept (UNLOGGED → logged FKs are permitted). Retention 14 days,
-- swept by the per-minute retrieval-count batch job.
CREATE UNLOGGED TABLE "memory_retrievals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_id" uuid,
	"task_id" uuid,
	"lane" text DEFAULT 'working_set' NOT NULL,
	"query_ref" text,
	"returned_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"scores" real[] DEFAULT '{}'::real[] NOT NULL,
	"budget_tokens_used" integer DEFAULT 0 NOT NULL,
	"empty" boolean DEFAULT false NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"semantic_skipped" boolean DEFAULT false NOT NULL,
	"slow" boolean DEFAULT false NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"counted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_retrievals" ADD CONSTRAINT "memory_retrievals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "memory_retrievals_uncounted_pidx" ON "memory_retrievals" USING btree ("company_id","created_at") WHERE "memory_retrievals"."counted" = false;
--> statement-breakpoint
CREATE INDEX "memory_retrievals_company_created_idx" ON "memory_retrievals" USING btree ("company_id","created_at");
