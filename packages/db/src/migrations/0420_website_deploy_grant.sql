-- The lean Deploy (John, 11 Nov 2026): website:deploy puts staging on greatstoneint.com and rolls it back. No role
-- holds it by default and agents never can. It starts with John only, and only where he is an active owner, so a
-- fresh database or another company gets nothing. An owner can grant it to someone else later.
INSERT INTO "principal_permission_grants" ("company_id", "principal_type", "principal_id", "permission_key", "scope", "granted_by_user_id")
SELECT "company_id", 'user', "principal_id", 'website:deploy', NULL, "principal_id"
FROM "company_memberships"
WHERE "principal_type" = 'user'
  AND "principal_id" = 'UGJwnXKO0P0yBvVh4krv4LH3EThDwrRP'
  AND "membership_role" = 'owner'
  AND "status" = 'active'
ON CONFLICT ("company_id", "principal_type", "principal_id", "permission_key") DO NOTHING;
