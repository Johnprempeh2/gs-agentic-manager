-- Website sites can use an existing company secret as their Netlify token (for example the one agents use).
-- netlify_token_secret_owned is true when the site created the secret (a pasted token) and may rotate it;
-- false for a shared secret, which the site never rotates or deletes. Every existing token was pasted, so true.
-- Additive. Rollback: ALTER TABLE "website_site" DROP COLUMN "netlify_token_secret_owned";
ALTER TABLE "website_site" ADD COLUMN "netlify_token_secret_owned" boolean DEFAULT true NOT NULL;
