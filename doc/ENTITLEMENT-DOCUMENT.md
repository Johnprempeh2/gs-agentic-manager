# Signed entitlement document (GRE-1078)

An instance reads one signed document that says which managed product
features the client has. The hub signs it; the instance checks the signature
and applies it without a restart. The hub admin screen and delivery come later
(after F1). Today the file is placed by hand.

## Turn it on

| Variable | Meaning |
|---|---|
| `GSAM_ENTITLEMENT_PUBLIC_KEY` | Hub Ed25519 public key: PEM (SPKI) or the raw 32 bytes in base64url. Unset = entitlements off, the instance behaves as before. Set but bad = the server refuses to start. |
| `GSAM_ENTITLEMENT_FILE` | Path to the signed file. Default `<instance root>/entitlements/entitlement.json`. |
| `GSAM_ENTITLEMENT_CLIENT` | Optional. A document for another client is refused. |

A GSAM for Mac install sets none of these. Its activation pins the hub key and
the client (the instance code) in `<instance root>/fleet/spoke.json`, and the
server uses them when `GSAM_ENTITLEMENT_PUBLIC_KEY` is unset.

## The hub signs (GSAM for Mac)

| Variable | Meaning |
|---|---|
| `GSAM_ENTITLEMENT_SIGN_PRIVATE_KEY` | Hub only. Ed25519 private key: PEM (PKCS#8) or the raw 32-byte seed in base64url. Unset: the hub makes no licences or documents (409, and activation answers 503). Keep it in the hub's environment file, never in the repository. |

Make one: `node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))'`.
The hub stores the current signed document per fleet instance and sends it
with every check-in answer (`doc/CLIENT-INSTANCES.md`, "GSAM for Mac: licence keys").
Changing the key means every install must be activated again, because each one
pinned the old public key.

The last good copy is saved as `last-good.json` next to the file.

## File format

```json
{ "v": 1, "document": "<base64url of the document JSON bytes>", "signature": "<base64url Ed25519 signature of those bytes>" }
```

The document:

```json
{
  "v": 1,
  "client": "acme",
  "version": 4,
  "issuedAt": "2026-10-09T00:00:00Z",
  "validUntil": "2026-11-09T00:00:00Z",
  "issuedBy": "jane@greatstone",
  "reason": "CRM bundle, monthly",
  "features": { "enablePipelines": true, "enableStrategy": true },
  "limits": { "maxAgents": 10 },
  "grace": 0
}
```

- `features` covers `ENTITLEMENT_FEATURE_KEYS` (managed product features). A governed key that is left out is not entitled. Other keys are ignored and listed as `ignoredFeatureKeys`.
- Graduated switches that keep a client gate are still governed (GRE-1633): `enableAgentChat`, `enableBuiltInAgents`, `enableIssuePlanDecompositions`, `enableSummaries`, `enableStatusCards`, `enableCases`, `enableExternalObjects`, `enableEnvironments`, `enableChatConnectors` and `enableMemoryConnectors`. Greatstone and self-hosted read them on (no document); a document that leaves one out turns it off. `enableBetaSkills` and `enableSimplifiedEnglishInteractions` are preference switches and never governed.
- `version` must go up. An older or equal version with different content is refused.
- `limits` are reported by `GET /api/instance/entitlements`; they are not enforced yet.

## Rules

- A feature works only when the document allows it **and** the switch is on. The document never turns a switch on by itself, and nothing stored is changed or deleted.
- A missing, unreadable, badly signed, malformed or older file keeps the last good copy. With no good copy the base floor applies (every governed feature off). Never "all on".
- The file is re-read every minute. `POST /api/instance/entitlements/sync` ("Sync now", instance admins) re-reads it at once.
- After `validUntil` the document still applies for `grace` days, then the base floor applies. `grace` is optional; a document without it gets 14 days. Customer (Mac) documents carry `grace: 0`: the service stops at the end of the paid period. On a Mac install the base floor also holds new agent runs and shows the "Your GSAM subscription has ended" page (P2, `doc/CLIENT-INSTANCES.md`).
- Switches in `RESTART_WIRED_ENTITLEMENT_KEYS` change only after a restart and show `pendingRestart` until then. The list is empty today.
- Every change and every refused file is written to the activity log of each company (`instance.entitlements.changed`, `instance.entitlements.rejected`) with who (`issuedBy`, `requestedBy`), what (state, versions, feature changes), when, and why (`reason`).

## Sign a document (for tests)

```js
import { generateKeyPairSync, sign } from "node:crypto";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const bytes = Buffer.from(JSON.stringify(doc));
const file = { v: 1, document: bytes.toString("base64url"), signature: sign(null, bytes, privateKey).toString("base64url") };
```
