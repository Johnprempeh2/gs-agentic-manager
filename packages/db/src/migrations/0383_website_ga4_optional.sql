-- Website setup without Google Analytics (23 Oct 2026): a website property may be set up before a GA4
-- property exists. Progress, sitemap, preview and Search Console do not need it.
-- Rollback (only once every row has a GA4 id): ALTER TABLE "website_properties" ALTER COLUMN "ga4_property_id" SET NOT NULL;
ALTER TABLE "website_properties" ALTER COLUMN "ga4_property_id" DROP NOT NULL;
