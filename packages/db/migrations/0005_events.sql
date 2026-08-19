CREATE TABLE "dead_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"consumer" text NOT NULL,
	"deliveries" integer DEFAULT 0 NOT NULL,
	"error" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'dead' NOT NULL,
	"first_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "dead_events_status_check" CHECK ("dead_events"."status" IN ('dead','replayed','discarded'))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid,
	"company_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"version" smallint DEFAULT 1 NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" jsonb NOT NULL,
	"task_id" uuid,
	"project_id" uuid,
	"agent_id" uuid,
	"correlation_id" uuid,
	"causation_id" uuid,
	"payload" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "events_id_occurred_at_pk" PRIMARY KEY("id","occurred_at")
) PARTITION BY RANGE ("occurred_at");
--> statement-breakpoint
ALTER TABLE "dead_events" ADD CONSTRAINT "dead_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dead_events_event_consumer_uq" ON "dead_events" USING btree ("event_id","consumer");--> statement-breakpoint
CREATE INDEX "dead_events_dead_pidx" ON "dead_events" USING btree ("company_id") WHERE "dead_events"."status" = 'dead';--> statement-breakpoint
CREATE UNIQUE INDEX "events_company_seq_occurred_uq" ON "events" USING btree ("company_id","seq","occurred_at");--> statement-breakpoint
CREATE INDEX "events_company_seq_idx" ON "events" USING btree ("company_id","seq");--> statement-breakpoint
CREATE INDEX "events_company_type_occurred_idx" ON "events" USING btree ("company_id","type","occurred_at");--> statement-breakpoint
CREATE INDEX "events_outbox_pidx" ON "events" USING btree ("occurred_at") WHERE "events"."published_at" IS NULL;--> statement-breakpoint
CREATE INDEX "events_task_occurred_pidx" ON "events" USING btree ("task_id","occurred_at") WHERE "events"."task_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "events_agent_occurred_pidx" ON "events" USING btree ("agent_id","occurred_at") WHERE "events"."agent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "events_payload_gin" ON "events" USING gin ("payload" jsonb_path_ops);
--> statement-breakpoint
-- Hand-audited (20 §9.1, §17): monthly partitions + DEFAULT safety net.
DO $$
DECLARE m date := date_trunc('month', now())::date;
BEGIN
  FOR i IN 0..2 LOOP
    EXECUTE format('CREATE TABLE IF NOT EXISTS events_%s PARTITION OF events FOR VALUES FROM (%L) TO (%L)',
      to_char(m + (i || ' month')::interval, 'YYYYMM'),
      m + (i || ' month')::interval, m + ((i + 1) || ' month')::interval);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS events_default PARTITION OF events DEFAULT;
