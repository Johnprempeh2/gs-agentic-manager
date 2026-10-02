CREATE TABLE "agent_team_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"description" text,
	"lead_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_team_members" ADD CONSTRAINT "agent_team_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_team_members" ADD CONSTRAINT "agent_team_members_team_id_agent_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."agent_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_team_members" ADD CONSTRAINT "agent_team_members_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_teams" ADD CONSTRAINT "agent_teams_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_teams" ADD CONSTRAINT "agent_teams_lead_agent_id_agents_id_fk" FOREIGN KEY ("lead_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_team_members_team_agent_uq" ON "agent_team_members" USING btree ("team_id","agent_id");--> statement-breakpoint
CREATE INDEX "agent_team_members_company_idx" ON "agent_team_members" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "agent_team_members_agent_idx" ON "agent_team_members" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_teams_company_idx" ON "agent_teams" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_teams_company_name_uq" ON "agent_teams" USING btree ("company_id","name");