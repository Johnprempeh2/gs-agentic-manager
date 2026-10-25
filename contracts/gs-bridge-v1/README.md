# gs-bridge-v1: how GSAM signs a call to the website's admin API

GRE-2323. This folder is at the same path in `greatstone-website` and `gs-agentic-manager`. If you change
`vectors.json` in one repo, change it in the other repo's pull request too. Both test suites check against it.

## Keys

- Each capability has its own Ed25519 key pair, and staging and live use different keys. GSAM makes the pair and keeps the private key as a company secret.
- The site holds only the public keys, in `GSAM_BRIDGE_KEYS`. This is a JSON list of `{ "kid", "capability", "publicKey", "notAfter"? }`, where `publicKey` is the raw 32-byte key in base64url. A `kid` is lower case, 3 to 64 characters, for example `stg-read-2026-10`.
- `capability` is `read`, `write` or `refund_request`. `read` is accepted only for `GET`. `write` is accepted only for `PUT /api/admin/v1/deep-dive/tenants/:tenantId` (GRE-2439, below).
- To rotate a key: list both keys, move GSAM to the new one, then remove the old one. To revoke a key: remove it and redeploy.
- `GSAM_BRIDGE_ALLOWED_IPS` is optional: a comma-separated list of exact client IPs. It is off when empty.

## Request headers

| Header | Value |
|---|---|
| `X-GS-Bridge-Key` | the kid |
| `X-GS-Bridge-Time` | unix seconds; must be within 60 s of the site's clock and the database's clock |
| `X-GS-Bridge-Nonce` | 16 random bytes, base64url (22 characters); a nonce works once per kid |
| `X-GS-Bridge-Actor` | `agent:<id>`, `user:<id>`, or `system:<id>` for GSAM's own scheduled reads; the id is `[A-Za-z0-9_-]{1,64}` |
| `X-GS-Bridge-Run` | optional GSAM run id (uuid) |
| `X-GS-Bridge-Signature` | Ed25519 signature of the canonical string, base64url |

## Canonical string

These nine lines are joined by `\n`, with no trailing newline:

```
gs-bridge-v1
<METHOD, upper case>
<host, lower case, with the port if one is given>
<path>[?<canonical query>]
<time>
<nonce>
<actor>
<run, or ->
<sha256 hex of the body bytes; GET signs the hash of "">
```

To build the canonical query, decode the query as `URLSearchParams` does. Sort the pairs by name, then by value, comparing code units. Encode each name and value with `encodeURIComponent`, and also encode `!'()*`. Join the pairs with `&`. Leave out the `?` when there are no pairs.

## Answers

- A list returns `{ items, nextCursor }`. The cursor is opaque, and `null` ends the read. A get returns `{ item }`.
- An error returns `{ error: { code } }` only. The codes are `bad_key`, `expired`, `bad_signature` and `replay` (401), `capability_denied` and `ip_denied` (403), `not_found` (404), `bad_request` (400) and `unavailable` (503).

## Client activity outbox (GRE-2635)

The website records each client event in an append-only outbox **in the same database transaction as the action**. It never calls GSAM. Assign the outbox sequence under a transaction-held counter-row lock, so sequence order is commit order. A normal database `nextval()` is unsafe: transaction 2 can commit sequence 2 while transaction 1 still holds sequence 1, then GSAM can skip sequence 1. GSAM calls `GET /api/admin/v1/activity-events?cursor=<decimal>&limit=100` with its existing `read` key. The website returns `{ "items": [...], "nextCursor": "<decimal>" }` in ascending sequence order. A fresh reader sends `cursor=0`. The site returns only committed rows with sequence greater than the supplied cursor; it must not delete or hide a row before GSAM has read it. An empty page returns the supplied cursor. `nextCursor` always names the last returned row, even if the page is shorter than the limit.

The shared schema is `packages/shared/src/website-activity.ts` in GSAM; copy/publish the exact schema for the website build. Each item has `sequence` (positive decimal string), `id` (stable UUID), `organisationId` (website UUID), `kind`, `subjectId` (short opaque record ID), `label` (short display label), and `occurredAt` (ISO timestamp with offset). The 15 permitted kinds are in that schema. Labels must describe the action only, for example `Interview started`; never put interview answers, document content, enquiry messages, personal details, invoice amounts, or other payloads in events.

The outbox sequence is global per site, including all organisations. GSAM keeps one cursor per site and stores rows keyed by company, site and source sequence. It commits the page and cursor together; an interrupted pull retries the same page. The source event ID is also unique per site, so conflicting duplicates fail without advancing the cursor. A site must not advance `nextCursor` beyond its last returned event or return rows out of order.

## Deep Dive sync (GRE-2439)

The public site never queries GSAM. GSAM pushes one client's Deep Dive snapshot, and the site calls back when a
client answers a document request. Staging only until John's release card says otherwise; test data only.

### Tenant

- The tenant is one GSAM client engagement. `tenantId` is GSAM's client id (a uuid). The site maps its own
  customer accounts to a `tenantId`; a signed-in customer sees only the snapshot of their tenant.
- One site key and one write key belong to one site, so to one GSAM company. A tenant of another company is never
  sent and never accepted.

### Push: GSAM to the site

`PUT /api/admin/v1/deep-dive/tenants/:tenantId`, signed as above with a `write` key (`stg-write-...`). The body is
JSON; the canonical string signs the sha256 of its exact bytes. The site checks that `body.tenantId` equals the path.

The body is the whole snapshot of that tenant. The site replaces everything it held for the tenant with it: an item
that is missing from a later push was unshared (or a deliverable withdrawn) and must be removed. A retry sends the
same snapshot, so a PUT twice is the same as once.

```
{
  "schema": "gs-deep-dive-sync-v1",
  "tenantId": "<uuid>", "tenantName": "...", "generatedAt": "<iso>",
  "items": [{ "id", "type", "key", "title", "summary", "status", "fields", "parentId", "updatedAt" }],
  "files": [{ "id", "itemId", "title", "kind", "status": "held" | "missing", "heldAt" }],
  "documentRequests": [{ "id", "title", "note", "itemIds", "status": "open" | "received", "receivedAt", "createdAt" }],
  "deliverables": [{ "id", "title", "version", "status": "published" | "accepted", "publishedAt", "acceptedAt" }]
}
```

- Only Shared items are sent. A Shared item whose parent is Internal is sent with `parentId: null`.
- Only files and document requests linked Shared to a Shared item are sent.
- Only deliverables that are published or accepted are sent; metadata only, no file content in this step.
- The site answers `{ "ok": true, "tenantId": "<uuid>" }`, or an error as below.

### Call back: the site to GSAM

`POST <gsam>/api/website-bridge/v1/tenants/:tenantId/document-requests/:requestId/answer`

- Signed with the site's own Ed25519 key, the same headers and canonical string as above. The site keeps the
  private key; a person with Publish rights registers the public key and its id in GSAM with
  `PUT /api/companies/:companyId/website/sites/:siteId/data-bridge/site-key` `{ "keyId", "publicKey" }`. GSAM's
  write key is made with `POST .../data-bridge/key` `{ "environment": "stg", "capability": "write" }`; its public
  key goes in the site's `GSAM_BRIDGE_KEYS` with `capability: "write"`. The host in the canonical
  string is the Host header GSAM receives (or GSAM's public address).
- `X-GS-Bridge-Actor` is `client:<customerId>`: the website customer who answered. It must equal
  `answeredBy.customerId` in the body.
- Body:

```
{ "answerId": "<site's id, [A-Za-z0-9_-]{1,80}>",
  "answeredBy": { "customerId": "<[A-Za-z0-9_-]{1,64}>", "name": "..." | null, "email": "..." | null },
  "note": "..." | null, "fileName": "..." | null }
```

- GSAM marks the request received with its own time and the answering client, and shows it on the Deep Dive
  "Evidence and files" screen. The same `answerId` again changes nothing. The file stays on the site in this step.
- Answer: `{ "ok": true, "requestId", "receivedAt" }`. Errors are `{ "error": { "code" } }` only: `bad_key`,
  `expired` (outside 60 s), `bad_signature`, `replay` (401); `bad_request` (400); `not_found` (404: the tenant is
  not a client of the site's company, or the request was never sent to that tenant).
