# Read-only staging bridge check

The GSAM Website registry uses a separate site row and read key for each Netlify site. Keep the public `greatstoneint.com` row separate. The staging target verified on 26 October 2026 is Netlify site `8c1135a6-6f8e-43f4-b9b2-3c4d5b6a36cb`, named `gre1795-website-db-staging`, at `https://gre1795-website-db-staging.netlify.app`.

## One-time setup by a person with Website Publish rights

Each step is a button in the app (GRE-3992, GRE-3993). Paths are relative to the GSAM address, for example `http://localhost:3100`.

1. **Add the staging website and connect its Netlify site.**
   - Open **Website** (`/website`). Click **Add a website** (next to the website chips at the top). Site name: the staging name. Site address: `https://gre1795-website-db-staging.netlify.app/`. Click **Add website**.
   - The new website opens on its **Releases** tab (`/website?tab=releases`). Use the website chips at the top of the page to switch between the public site and the staging copy. In **Site connection**, click **Connect a site**. Live address: `gre1795-website-db-staging.netlify.app`. Netlify site ID: the ID above. A Netlify publish token is not required for these bridge reads. Click **Connect site**.
   - Do not change the public site's row or key. The new site appears in `GET /api/companies/{companyId}/website/sites`; its `siteId` is the staging `siteId` used below.
2. **Make the staging read key, on that staging site only.**
   - On the staging website's **Releases** tab, in **Site connection**, find **Website data**. On the **Read key** line click **Make key**, set **Site** to **Staging**, then click **Make read key**. This calls `POST /api/companies/{companyId}/website/sites/{stagingSiteId}/data-bridge/key` with `{"environment":"stg","capability":"read"}`.
   - GSAM stores the private key in its vault and shows only the public entry. Click **Copy**. A person adds that entry to the staging Netlify site's `GSAM_BRIDGE_KEYS` and deploys it through the normal website release path. Never put the private key, a database credential, or a write key in Flint's agent settings or an issue comment.
3. **Give Flint `website:view` on the staging site only.**
   - Open **Agents**, then Flint, then the **Permissions / Trust** tab (`/agents/{flint}/permissions`). On the **Website access** line, set the site picker to the staging site first, then set the level to **View**. The hint reads "Sees the website pages and drafts on {staging name}."
   - To remove it, set the level back to **None**. This grant is separate from any access to the public site. Only a board user who may manage permissions can change it; an agent, even the CEO, gets 403. The existing QA login is not a substitute for an agent grant unless Flint has a working sign-in path.

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
