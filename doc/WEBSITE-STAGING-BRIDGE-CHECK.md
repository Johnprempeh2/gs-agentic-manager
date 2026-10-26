# Read-only staging bridge check

The GSAM Website registry uses a separate site row and read key for each Netlify site. Keep the public `greatstoneint.com` row separate. The staging target verified on 26 October 2026 is Netlify site `8c1135a6-6f8e-43f4-b9b2-3c4d5b6a36cb`, named `gre1795-website-db-staging`, at `https://gre1795-website-db-staging.netlify.app`.

## One-time setup by a person with Website Publish rights

1. In the Greatstone company, connect a new Website site. Use the staging name, the bare domain `gre1795-website-db-staging.netlify.app`, and the Netlify site ID above. A Netlify publish token is not required for these bridge reads. Do not change the public site's row or key. Record the new GSAM `siteId` from the response or `GET /api/companies/{companyId}/website/sites`.
2. On **that staging site only**, create a data bridge key with `POST /api/companies/{companyId}/website/sites/{stagingSiteId}/data-bridge/key` and body `{"environment":"stg","capability":"read"}`. GSAM stores the private key in its vault and returns only the public `keysEntry`. A person adds that entry to the staging Netlify site's `GSAM_BRIDGE_KEYS` and deploys it through the normal website release path. Never put the private key, a database credential, or a write key in Flint's agent settings or an issue comment.
3. Give Flint `website:view` scoped to the new staging `siteId`. This grant is separate from any access to the public site. Only a board user can change an agent's Website permissions. The existing QA login is not a substitute for an agent grant unless Flint has a working sign-in path.

## Flint's GET calls after both changes ship

Set `C=/api/companies/{companyId}/website/sites/{stagingSiteId}`. Read the staging `siteId` from the GSAM site list; do not use the public site's ID.

| Check | Read-only URL | Expected evidence |
|---|---|---|
| Binding | `GET /api/companies/{companyId}/website/sites/{stagingSiteId}` | Staging domain and Netlify site ID above. |
| Key and connection | `GET $C/data-bridge/status` | `state: connected` and a `stg-read-...` key ID. This status is cached for up to 60 seconds. |
| Deployed site contract | `GET $C/data-bridge/health` | Fresh signed body with `ok: true`, `capability: read`, and `siteContract: 1`. |
| Activity outbox | `GET $C/data-bridge/activity-events?cursor=0&limit=1` | `items` and `nextCursor`, even if `items` is empty. Continue with the returned cursor, up to 100 events per call. |
| Table presence | `GET $C/data-bridge/schema` | Exact `tables.billing_lines` and `tables.client_activity_outbox` booleans. No customer rows. Requires the website endpoint in GRE-2816. |

All five calls use `website:view`. GSAM signs the three bridge calls with the staging site's **read** key. The API accepts no caller-selected upstream URL or path. A missing key answers 409. A website failure answers 502; it is not evidence that a table is absent. Until GRE-2816 is deployed to staging, `/data-bridge/schema` cannot give a reliable absent/present result, because the website currently maps a missing table to a generic 503. A successful `GET $C/data/billing-lines?customer={knownCustomerId}` proves `billing_lines` exists even if the list is empty, but the release check should use `/schema` so no customer rows are returned.
