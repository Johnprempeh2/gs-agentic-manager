-- Country owner as a GSAM member (Ben, 12 Oct). Additive: one nullable column;
-- country_owner keeps the name.
ALTER TABLE "organisations" ADD COLUMN "country_owner_user_id" text;