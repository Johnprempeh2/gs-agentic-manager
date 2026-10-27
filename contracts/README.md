# The GSAM and website contract (GRE-2633)

This folder is the one contract between GSAM and the website. It holds the JSON schemas, the shared test
fixtures and the version numbers of every message and endpoint between the two:

| Surface | Schema | Version |
|---|---|---|
| Bridge health (`GET /api/admin/v1/health`) | `site-contract/schemas/bridge-health.schema.json` | `gs-bridge-v1` |
| Bridge errors, both ways | `site-contract/schemas/bridge-error.schema.json` | |
| Bridge signing | `gs-bridge-v1/README.md`, `gs-bridge-v1/vectors.json` | `gs-bridge-v1`, `gs-bridge-v2` |
| Editor frame `hello-ack` | `site-contract/schemas/editor-hello-ack.schema.json` | frame protocol 1, editor contract 1 and 2 |
| `GET /_release` | `site-contract/schemas/release-answer.schema.json` | release schema 1, engine 0.1.0 or later |
| `GET /_contract.json` (static, unsigned) | `site-contract/schemas/contract-file.schema.json` | `siteContract`, `contractsCommit` |
| Deep Dive push and its answer | `site-contract/schemas/deep-dive-sync*.schema.json` | `gs-deep-dive-sync-v1` |
| Document request call back | `site-contract/schemas/document-request-answer.schema.json` | |
| Interviews | `gs-interview-v1/README.md` | `gs-interview-v1` |

`manifest.json` has the contract `version`, the `minSiteVersion` GSAM works with, and a sha256 of every file.

## One place, never two hand-edited copies

- The canonical copy is here, in `gs-agentic-manager`. Change the contract only here, in a GSAM pull request.
- The website keeps a vendored copy at the same path, with `VENDORED.json` naming the GSAM commit it came
  from. To update it, from a GSAM checkout on `main`:
  `node contracts/check.mjs --vendor <website-checkout>`, then open a website pull request with the result.
- `node contracts/check.mjs` fails when any file does not match its hash. A hand edit in either repo fails CI.
- No secrets and no client data go in this folder: the check refuses private keys, tokens and real email
  addresses. The signing key in `gs-bridge-v1/vectors.json` is a public test key. Flint checks each change.

## Versions

- The site reports the contract it speaks as `siteContract` (a whole number) in three answers: the bridge
  health, the editor `hello-ack`, and `/_release`.
- A change that only adds (a new optional field, a new message) raises `version`. GSAM still works with older
  sites down to `minSiteVersion`.
- A change that an older site cannot follow raises `minSiteVersion` too. Then the website deploys first.

## Checks

1. **CI, both repos.** `node contracts/check.mjs` (hashes, no secrets). Each side also tests its own code
   against `site-contract/fixtures/`: GSAM parses every fixture with its own schemas, and the website must
   make answers that pass `site-contract/schemas/`.
2. **Every connection.** GSAM reads `siteContract` from the bridge health, the editor `hello-ack` and
   `/_release`. When it is missing or below `minSiteVersion`, GSAM shows "Out of date: update the website."
   instead of failing silently.
3. **Every release.** GSAM's release queue asks each connected site's `/_release` (on its domain and its editor
   host). When `/_release` is not JSON or has no `siteContract`, it reads the static `/_contract.json`. It
   refuses when neither reports a `siteContract` at or above the new GSAM's `minSiteVersion`. The website deploy guard runs
   `node contracts/check.mjs --site-speaks <the site's version>` and refuses when it differs from the
   vendored `version`.
