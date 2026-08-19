CREATE TABLE "org_units" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parent_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "org_units_kind_check" CHECK ("org_units"."kind" IN ('department','team','office','division')),
	CONSTRAINT "org_units_no_self_parent_check" CHECK ("org_units"."parent_id" <> "org_units"."id")
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"seniority_track" text[] NOT NULL,
	"default_role" text NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_parent_id_org_units_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."org_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_units_company_slug_uq" ON "org_units" USING btree ("company_id","slug");--> statement-breakpoint
CREATE INDEX "org_units_company_parent_idx" ON "org_units" USING btree ("company_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "positions_company_title_uq" ON "positions" USING btree ("company_id","title");