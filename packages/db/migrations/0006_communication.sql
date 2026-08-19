CREATE TABLE "channel_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"channel_id" uuid NOT NULL,
	"agent_id" uuid,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"last_read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"org_unit_id" uuid,
	"project_id" uuid,
	"task_id" uuid,
	"review_id" uuid,
	"dm_key" text,
	"archived_at" timestamp with time zone,
	CONSTRAINT "channels_kind_check" CHECK ("channels"."kind" IN ('dm','team','department','project','task_thread','review','escalation')),
	CONSTRAINT "channels_kind_ref_check" CHECK (("channels"."kind" <> 'task_thread' OR "channels"."task_id" IS NOT NULL) AND ("channels"."kind" <> 'review' OR "channels"."review_id" IS NOT NULL) AND ("channels"."kind" <> 'dm' OR "channels"."dm_key" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"channel_id" uuid NOT NULL,
	"sender_agent_id" uuid,
	"kind" text DEFAULT 'text' NOT NULL,
	"body" text NOT NULL,
	"refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reply_to_message_id" uuid,
	CONSTRAINT "messages_kind_check" CHECK ("messages"."kind" IN ('text','help_request','review_request','escalation','status','system'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body_md" text,
	"refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_org_unit_id_org_units_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."org_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_agent_id_agents_id_fk" FOREIGN KEY ("sender_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_message_id_messages_id_fk" FOREIGN KEY ("reply_to_message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_members_active_uq" ON "channel_members" USING btree ("channel_id",coalesce("agent_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "channel_members"."left_at" IS NULL;--> statement-breakpoint
CREATE INDEX "channel_members_agent_idx" ON "channel_members" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_dm_key_uq" ON "channels" USING btree ("company_id","dm_key") WHERE "channels"."kind" = 'dm';--> statement-breakpoint
CREATE UNIQUE INDEX "channels_task_thread_uq" ON "channels" USING btree ("task_id") WHERE "channels"."kind" = 'task_thread';--> statement-breakpoint
CREATE UNIQUE INDEX "channels_review_uq" ON "channels" USING btree ("review_id") WHERE "channels"."kind" = 'review';--> statement-breakpoint
CREATE INDEX "messages_channel_created_idx" ON "messages" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_company_created_idx" ON "messages" USING btree ("company_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "messages_body_trgm_gin" ON "messages" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "messages_refs_gin" ON "messages" USING gin ("refs" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "notifications_unread_pidx" ON "notifications" USING btree ("user_id","created_at" DESC) WHERE "notifications"."read_at" IS NULL;