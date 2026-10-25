CREATE TABLE "website_activity_cursors" (
	"company_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "website_activity_cursors_company_id_site_id_pk" PRIMARY KEY("company_id","site_id"),
	CONSTRAINT "website_activity_cursor_positive" CHECK ("website_activity_cursors"."sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "website_activity_events" (
	"company_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"label" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "website_activity_events_company_id_site_id_sequence_pk" PRIMARY KEY("company_id","site_id","sequence"),
	CONSTRAINT "website_activity_source_id_uq" UNIQUE("company_id","site_id","id"),
	CONSTRAINT "website_activity_sequence_positive" CHECK ("website_activity_events"."sequence" > 0)
);
--> statement-breakpoint
ALTER TABLE "website_activity_cursors" ADD CONSTRAINT "website_activity_cursors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_activity_cursors" ADD CONSTRAINT "website_activity_cursors_company_id_site_id_website_site_company_id_id_fk" FOREIGN KEY ("company_id","site_id") REFERENCES "public"."website_site"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_activity_events" ADD CONSTRAINT "website_activity_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_activity_events" ADD CONSTRAINT "website_activity_events_company_id_site_id_website_site_company_id_id_fk" FOREIGN KEY ("company_id","site_id") REFERENCES "public"."website_site"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "website_activity_client_idx" ON "website_activity_events" USING btree ("company_id","organisation_id","occurred_at","sequence");