# gs-bridge-v1: how GSAM signs a call to the website's admin API

GRE-2323. This folder is part of the GSAM and website contract (`contracts/README.md`, GRE-2633). Change it
only in `gs-agentic-manager`; the website vendors it with `contracts/check.mjs --vendor`. Both test suites check
against `vectors.json`.

## Keys

- Each capability has its own Ed25519 key pair, and staging and live use different keys. GSAM makes the pair and keeps the private key as a company secret.
- The site holds only the public keys, in `GSAM_BRIDGE_KEYS`. This is a JSON list of `{ "kid", "capability", "publicKey", "notAfter"? }`, where `publicKey` is the raw 32-byte key in base64url. A `kid` is lower case, 3 to 64 characters, for example `stg-read-2026-10`.
- `capability` is `read`, `write` or `refund_request`. `read` is accepted only for `GET`. `write` is accepted on typed write routes, including the Deep Dive sync below and the interview routes in `gs-interview-v1/README.md`; writes use `gs-bridge-v2` and `X-GS-Bridge-Idempotency-Key`.
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
  "deliverables": [{ "id", "title", "version", "status": "published" | "accepted", "publishedAt", "acceptedAt" }],
  "findings": [{ "id", "streamItemId": "<Shared stream id>" | null, "statement", "status": "proposed" | "validated" | "rejected" | "superseded", "evidenceCount", "supersedesId": "<finding id>" | null, "updatedAt" }],
  "opportunities": [{ "id", "ref", "title", "statement", "desiredOutcome", "status": "draft" | "refined" | "validated", "findingIds": ["<finding id>"], "streamItemIds": ["<Shared stream id>"], "updatedAt" }],
  "kpis": [{ "id", "title", "definition", "scope": "company" | "division" | "department" | "team" | "individual", "unit", "direction": "up" | "down" | "steady", "baseline", "baselinePeriod", "target", "opportunityIds": ["<opportunity id>"], "updatedAt" }]
}
```

- Only Shared items are sent. A Shared item whose parent is Internal is sent with `parentId: null`.
- Only files and document requests linked Shared to a Shared item are sent.
- Only deliverables that are published or accepted are sent; metadata only, no file content in this step.
- The three additive arrays contain Shared records only. Links name records in this same payload. KPI readings are not in v1; the site shows baseline and target only. Older snapshots may omit these arrays.
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
