-- Deliverable comments (GRE-982, 6 Oct 2026): notes a board user pins to a
-- passage of one deliverable version, drafted then sent as one task comment.
-- New table only; no existing table or row changes.
-- Rollback: DROP TABLE "deliverable_comments";
CREATE TABLE "deliverable_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"work_product_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"quote" text NOT NULL,
	"prefix" text,
	"suffix" text,
	"text_start" integer,
	"body" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"author_user_id" text NOT NULL,
	"sent_comment_id" uuid,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deliverable_comments" ADD CONSTRAINT "deliverable_comments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_comments" ADD CONSTRAINT "deliverable_comments_work_product_id_issue_work_products_id_fk" FOREIGN KEY ("work_product_id") REFERENCES "public"."issue_work_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_comments" ADD CONSTRAINT "deliverable_comments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_comments" ADD CONSTRAINT "deliverable_comments_sent_comment_id_issue_comments_id_fk" FOREIGN KEY ("sent_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deliverable_comments_company_work_product_idx" ON "deliverable_comments" USING btree ("company_id","work_product_id","created_at");