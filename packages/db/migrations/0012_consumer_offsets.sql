CREATE TABLE "consumer_offsets" (
	"consumer" text NOT NULL,
	"company_id" uuid NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consumer_offsets_consumer_company_id_pk" PRIMARY KEY("consumer","company_id")
);
--> statement-breakpoint
ALTER TABLE "consumer_offsets" ADD CONSTRAINT "consumer_offsets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;