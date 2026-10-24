# gs-bridge-v1: how GSAM signs a call to the website's admin API

GRE-2323. This folder is at the same path in `greatstone-website` and `gs-agentic-manager`. If you change
`vectors.json` in one repo, change it in the other repo's pull request too. Both test suites check against it.

## Keys

- Each capability has its own Ed25519 key pair, and staging and live use different keys. GSAM makes the pair and keeps the private key as a company secret.
- The site holds only the public keys, in `GSAM_BRIDGE_KEYS`. This is a JSON list of `{ "kid", "capability", "publicKey", "notAfter"? }`, where `publicKey` is the raw 32-byte key in base64url. A `kid` is lower case, 3 to 64 characters, for example `stg-read-2026-10`.
- `capability` is `read`, `write` or `refund_request`. Only `read` is accepted in this phase, and only for `GET`.
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
