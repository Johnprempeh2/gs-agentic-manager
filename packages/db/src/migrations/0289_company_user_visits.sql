CREATE TABLE "company_user_visits" (
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"last_visited_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_user_visits_company_id_user_id_pk" PRIMARY KEY("company_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "company_user_visits" ADD CONSTRAINT "company_user_visits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;