-- Website features (GRE-2325, plan of 24 Oct 2026): the feature registry of a site.
-- Additive: one new table. Owner, lead agent and project are optional. Each
-- site lists its own features; the last statement seeds Greatstone's six as
-- data on Greatstone's own site only, so any other instance starts empty.
-- Rollback: DROP TABLE "website_feature";
CREATE TABLE "website_feature" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"purpose" text DEFAULT '' NOT NULL,
	"icon" text DEFAULT 'blocks' NOT NULL,
	"owner_user_id" text,
	"suggested_owner" text,
	"lead_agent_id" uuid,
	"project_id" uuid,
	"admin_screens" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"route_prefixes" text[] DEFAULT '{}'::text[] NOT NULL,
	"collections" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "website_feature_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
ALTER TABLE "website_feature" ADD CONSTRAINT "website_feature_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_feature" ADD CONSTRAINT "website_feature_lead_agent_id_agents_id_fk" FOREIGN KEY ("lead_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_feature" ADD CONSTRAINT "website_feature_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_feature" ADD CONSTRAINT "website_feature_company_site_fk" FOREIGN KEY ("company_id","site_id") REFERENCES "public"."website_site"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "website_feature_site_idx" ON "website_feature" USING btree ("company_id","site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "website_feature_site_key_uq" ON "website_feature" USING btree ("site_id","key") WHERE "website_feature"."archived_at" is null;--> statement-breakpoint
-- Greatstone's six features (John, 24 Oct 2026), on Greatstone's site only.
-- Route prefixes come from the accepted sitemap (GRE-2081 plan revision 10):
-- the shop lives under /dev-tools and /org became /account/organisation.
INSERT INTO "website_feature" ("company_id", "site_id", "key", "name", "purpose", "icon", "suggested_owner", "route_prefixes", "collections", "admin_screens", "sort_order")
SELECT s."company_id", s."id", f."key", f."name", f."purpose", f."icon", f."suggested_owner", f."route_prefixes", f."collections", f."admin_screens", f."sort_order"
FROM "website_site" s
CROSS JOIN (VALUES
	('public-site', 'Public site', 'The home page and the content pages a visitor reads: consultancy, proof, insights, about, support and legal.', 'globe', NULL,
		ARRAY['/', '/consultancy', '/proof', '/insights', '/about', '/support', '/search', '/privacy', '/cookies', '/terms', '/refunds']::text[],
		ARRAY['public-person', 'redirect']::text[],
		'[{"name":"Pages and editor","issue":"GRE-2321"},{"name":"Team and redirects","issue":"GRE-2321"}]'::jsonb, 0),
	('shop', 'Shop and licences', 'Developer tools: brands, products, trials, basket and checkout, and a customer''s orders, quotes and licences.', 'shopping-bag', NULL,
		ARRAY['/dev-tools', '/account/orders', '/account/quotes', '/account/licences']::text[],
		ARRAY['product', 'category', 'vendor']::text[],
		'[{"name":"Catalogue","issue":"GRE-2326"},{"name":"Vendors and pricing rules","issue":"GRE-2326"},{"name":"Orders, quotes and invoices","issue":"GRE-2326"},{"name":"Licences","issue":"GRE-2326"}]'::jsonb, 1),
	('client-portal', 'Client portal', 'Client sign-in, My account and the organisation hub, and each client''s private portal.', 'key-round', NULL,
		ARRAY['/account', '/portal']::text[],
		ARRAY[]::text[],
		'[{"name":"Accounts and organisations","issue":"GRE-2323"},{"name":"Portal documents and acceptances","issue":"GRE-2327"}]'::jsonb, 2),
	('deep-dive', 'Deep Dive portal', 'The paid Deep Dive: its public page, and the client''s discovery, progress and blueprint in the portal.', 'telescope', 'Ben',
		ARRAY['/consultancy/deep-dive', '/portal/:client/deep-dive', '/portal/:client/discovery', '/portal/:client/blueprint']::text[],
		ARRAY[]::text[],
		'[{"name":"Deep Dive workspace","issue":"GRE-2327"},{"name":"Portal publishing","issue":"GRE-2327"}]'::jsonb, 3),
	('front-door', 'Front door and enquiries', 'How a visitor starts a conversation: Begin the Conversation, Executive Discovery and the newsletter.', 'door-open', NULL,
		ARRAY['/contact', '/consultancy/executive-discovery', '/newsletter']::text[],
		ARRAY['form']::text[],
		'[{"name":"Enquiries","issue":"GRE-2324"},{"name":"Forms","issue":"GRE-2324"}]'::jsonb, 4),
	('intelligence-hub', 'Intelligence hub', 'AI Market Intelligence: the briefings and market signals Greatstone offers leaders.', 'radar', NULL,
		ARRAY['/consultancy/ai-market-intelligence']::text[],
		ARRAY[]::text[],
		'[{"name":"Briefings","issue":"GRE-2321"}]'::jsonb, 5)
) AS f("key", "name", "purpose", "icon", "suggested_owner", "route_prefixes", "collections", "admin_screens", "sort_order")
WHERE s."company_id" = '34dad57e-b5ad-4a72-9400-9eba645c99f6'
	AND s."archived_at" IS NULL
	AND (s."domain" ILIKE '%greatstone%' OR s."repo_url" ILIKE '%greatstone-website%')
	AND NOT EXISTS (
		SELECT 1 FROM "website_feature" e WHERE e."site_id" = s."id" AND e."key" = f."key" AND e."archived_at" IS NULL
	);
