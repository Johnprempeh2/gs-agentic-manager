CREATE TABLE "intelligence_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"section_titles" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "intelligence_settings" ADD CONSTRAINT "intelligence_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- GRE-6095: a company that already has intelligence data keeps its AI boards as
-- its settings (INTELLIGENCE_AI_PRESET in packages/shared). A company with none
-- starts unset, and the page asks its owner to choose topics.
INSERT INTO "intelligence_settings" ("company_id", "topics", "section_titles")
SELECT c."id", '[{"key":"ai_systems","label":"AI Systems","covers":"The AI assistants and platforms people and businesses use, ranked on capability, reach and momentum.","sources":["OpenAI","Anthropic","Google and DeepMind","Microsoft AI","Meta AI","xAI","Mistral","Perplexity","TechCrunch","The Verge"],"keywords":["AI assistant","launch","pricing"],"leaderboard":true,"scoreLabel":"Score"},{"key":"frontier_models","label":"Frontier Models","covers":"Each lab''s current flagship model, ranked on the Artificial Analysis Intelligence Index, with price, context and benchmark specs.","sources":["Artificial Analysis","OpenAI","Anthropic","Google and DeepMind","Alibaba Qwen","DeepSeek","xAI"],"keywords":["frontier model","benchmark","Intelligence Index"],"leaderboard":true,"scoreLabel":"Index"},{"key":"tools_agents","label":"Tools and Agents","covers":"AI coding tools, agent builders and automation tools worth using or recommending to clients.","sources":["Hacker News","VentureBeat","Matt Wolfe (FutureTools)","Jack Roberts","Wes Roth"],"keywords":["AI agent","coding tool","automation"],"leaderboard":true,"scoreLabel":"Score"}]'::jsonb, '{"trends":"AI industry trends","opportunities":"Greatstone opportunities"}'::jsonb
FROM "companies" c
WHERE EXISTS (SELECT 1 FROM "intelligence_board_snapshots" s WHERE s."company_id" = c."id")
   OR EXISTS (SELECT 1 FROM "intelligence_reports" r WHERE r."company_id" = c."id")
ON CONFLICT ("company_id") DO NOTHING;
