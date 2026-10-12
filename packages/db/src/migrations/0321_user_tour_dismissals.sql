-- Guided tour dismissals (10 Oct 2026): the tours a person has finished or
-- skipped, so a tour stays dismissed on every device. Additive: one new empty table.
-- Rollback: DROP TABLE "user_tour_dismissals";
CREATE TABLE "user_tour_dismissals" (
	"user_id" text NOT NULL,
	"tour_key" text NOT NULL,
	"tour_version" integer NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_tour_dismissals_user_id_tour_key_tour_version_pk" PRIMARY KEY("user_id","tour_key","tour_version")
);
