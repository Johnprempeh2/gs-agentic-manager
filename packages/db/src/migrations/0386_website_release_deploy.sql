-- Website publish (GRE-2108): the Netlify production deploy that serves each release, so Retry knows whether
-- the build passed (verify only) and rollback can restore that deploy for 0 credits. Additive, nullable.
-- Rollback: ALTER TABLE "website_release" DROP COLUMN "deploy";
ALTER TABLE "website_release" ADD COLUMN "deploy" jsonb;
