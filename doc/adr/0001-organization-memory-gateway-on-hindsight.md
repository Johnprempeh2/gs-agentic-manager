# ADR-0001: Organization memory through a GSAM gateway on Hindsight

**Date**: 2026-10-04
**Status**: proposed (decided at gate G1 on GRE-646)
**Deciders**: John Prempeh (G1), Everest (coordinator), Mason (author, GRE-647)
**Inputs**: [build brief and plan on GRE-646](/GRE/issues/GRE-646); sibling phase 0 issues GRE-648 (pin and licences), GRE-649 (hosting and provider auth), GRE-650 (storage and limits), GRE-651 (threat model and test data).

Engine facts below were read from `vectorize-io/hindsight` at commit `f7dd3f4f` (release `v0.10.2`, 2 Oct 2026). Delta pins the reviewed version on GRE-648; recheck these facts against that pin.

## Context

Greatstone wants shared memory across agents: continuity, controlled sharing, traceable decisions, contradiction review, and later a permission-aware graph. Hindsight (MIT, Python, PostgreSQL + pgvector) is the preferred engine. It stores documents, chunks, extracted facts ("memory units"), entities, typed links and consolidated "observations", and it has tag-scoped recall.

Hindsight's own API and MCP endpoints are **open by default**. Its built-in auth is one shared API key. It has no record status, sensitivity, approval or supersession model of the kind the brief asks for. GSAM already has the governance pieces (agent identity, company scoping, grants, approvals, audit, secrets, routines). It has no governed memory layer.

## Decision

1. **All memory traffic goes through a GSAM memory gateway inside the GSAM server.** Path: agent → GSAM gateway (identity, grant check, audit) → Hindsight API (private, key-protected) → dedicated PostgreSQL. Agents never get the Hindsight address, key, MCP endpoint or the database URL.
2. **GSAM owns the governance record, Hindsight owns content and retrieval.** A GSAM table (`memory_records`) holds identity, scope, contributor, source, dates, status, sensitivity and version links. Each record maps 1:1 to a Hindsight document (`document_id` = GSAM record id). The gateway filters every result against the GSAM record before it returns anything.
3. **Hard boundaries are separate Hindsight banks; soft scopes are strict tags.** Each client and each restricted project gets its own bank. Organization, team/project and agent scopes are tags inside the company bank, always queried with `_strict` tag matching.
4. **Structured agent findings skip model extraction.** Use Hindsight's `chunks` retain mode, which makes no model call. Consolidation (observations), `reflect`, mental models and knowledge pages are **off in the MVP**.
5. **Approval stays in GSAM.** Status changes such as approve, dispute, supersede and delete happen only through GSAM routes. They use the existing approvals and grants, and they are never inferred by the engine.

## 1. How it fits GSAM today

| Need | Exists today (reuse) | Does not exist yet |
|---|---|---|
| Agent identity | `server/src/middleware/auth.ts` builds `req.actor`. Per-run agent JWT in `server/src/agent-auth-jwt.ts` carries agent, company, run and responsible user, with an `X-Paperclip-Run-Id` match check. `server/src/services/run-identity.ts` adds the identity context. | Nothing. Reuse as is. |
| Company scoping | `assertCompanyAccess`, `getAccessibleResource` (404 on other companies), `getActorInfo` in `server/src/routes/authz.ts` | Scope below company: client, restricted project, agent working memory. |
| Grants | `principal_permission_grants` (`packages/db/src/schema/principal_permission_grants.ts`) with a `scope` jsonb. Keys in `PERMISSION_KEYS` (`packages/shared/src/constants.ts`). Services `server/src/services/access.ts` and `authorization.ts`. | `memory:*` permission keys. A memory scope model. |
| Tool exposure to agents | Tool gateway `server/src/services/tool-gateway.ts` and `routes/tool-gateway.ts`. Profiles and policies in `tool-access.ts` and `tool-access-policy.ts` (`doc/MCP-ACCESS-GOVERNANCE.md`). Per-agent MCP in `native-runtime/assigned-mcp-tools.ts`. | First-party memory tools (`memory_recall`, `memory_contribute`, `memory_get`). |
| Experimental memory connectors | `packages/shared/src/memory-connectors.ts` (mem0, zep, supermemory, cognee, honcho) behind the `enableMemoryConnectors` flag. `server/src/services/cognee-connection.ts`. `doc/connections/MEMORY.md` | These are plain tool connections. They have no record model, no GSAM-enforced scope and no approval. **They are not the governed memory layer.** No Hindsight connector exists. |
| Approvals | `approvals` table and `server/src/services/approvals.ts` (`APPROVAL_TYPES`). `issue_thread_interactions` (`request_confirmation`). Argument-pinned `tool_action_requests`. | A memory approval type and a review queue. |
| Audit | `activity_log` via `logActivity` (`server/src/services/activity-log.ts`). Append-only `tool_call_events` / `tool_access_audit_events`. `cost_events`. | A `memory_operations` ledger. It was proposed in `doc/plans/2026-03-17-memory-service-surface-api.md` and never built. |
| Secrets | `company_secrets` and providers in `server/src/secrets/`. Credentials resolve server-side; `heartbeat.ts` refuses injected `GSAM_API_KEY`. | A Hindsight API key and signing key stored as company or instance secrets. |
| Steward schedule | `routines` with cron triggers and catch-up policy (`server/src/services/routines.ts`). Cursor precedent: `paperclip_distillation_cursors` in `packages/plugins/plugin-llm-wiki/`. | A memory review cursor and a steward routine. |
| Provenance targets | `documents` / `document_revisions`, `issue_comments`, `heartbeat_runs`, `external_objects` | Nothing. Reference these by id. |
| Client entity | Hierarchy is `companies` → `projects` → `issues`. Each paying customer gets a separate instance (`doc/CLIENT-INSTANCES.md`). | **No "client" entity in a company.** Greatstone's own clients need a new scope kind (below). |

Nothing in this design needs a change to the existing connectors. The governed gateway is new code next to them.

## 2. Gateway design

```
agent (run JWT) ──► GSAM server: /api/companies/:id/memory/*  and  tool gateway memory_* tools
                     │  1 authenticate actor (existing middleware)
                     │  2 resolve permitted scopes from grants (deny by default)
                     │  3 map scopes → bank ids + strict tag filter
                     │  4 sign a short-lived gateway assertion
                     │  5 log memory_operations + activity_log
                     ▼
                  Hindsight API (private address, API key + assertion check, MCP off, UI off)
                     ▼
                  dedicated PostgreSQL (own instance, own role; never the GSAM database)
```

**Protecting the direct engine paths.** On a local install the agent processes run on the same host as Hindsight, so a loopback-only port is not enough on its own. The design uses several layers:

- **Network:** Hindsight and its PostgreSQL run on a private container network or loopback with no published host port where the platform allows it (Bedrock confirms on GRE-649). The control-plane UI (port 9999) is not deployed. Prometheus `/metrics` is not exposed outside that network.
- **Key:** `ApiKeyTenantExtension`, or a small Greatstone tenant extension, requires a key. Only the GSAM server holds it, as a secret that is never projected into run environments.
- **Assertion:** a Greatstone `TenantExtension` and `OperationValidatorExtension` (about 100 lines of Python, loaded via `HINDSIGHT_API_*_EXTENSION`) verify an HMAC-signed, 60-second assertion forwarded through `HINDSIGHT_API_EXTENSION_PASSTHROUGH_HEADERS`. The assertion names the bank, the allowed read tags and the allowed write tags. `resolve_tag_scope` and `resolve_write_tag_scope` then enforce them inside the engine. A leaked key alone cannot read across scopes, and **knowing a bank id grants nothing**.
- **MCP:** Hindsight's built-in MCP server is disabled (it is on by default, `DEFAULT_MCP_ENABLED = True` in `config.py`; phase 1 confirms the exact setting name). It exposes `delete_bank`, `clear_memories` and `create_bank`. Agents get memory tools only from the GSAM tool gateway, which already has profiles, policies, rate limits and audit.
- **Database:** only the Hindsight process holds the database credentials. Agents get no SQL access and no database URL. GSAM's own database stays separate.
- **Destructive engine calls:** bank delete, clear and export are callable only by the gateway's admin path, not by any agent-facing route.

**Untrusted content.** Recall results go back to agents wrapped as evidence. Each result carries its status, scope, contributor and source, and the note that memory text is not an instruction or a permission. Existing GSAM action approvals stay authoritative.

**Disabled or down engine.** Memory tools return a clear "memory unavailable" result and agent runs continue. Contributions are queued in GSAM (`memory_records.sync_state = pending`) and retried. There is never a paid fallback.

## 3. Record model

GSAM `memory_records` is the authority for governance fields. Hindsight carries content plus mirrored tags, so the engine can filter.

| Field | GSAM (authoritative) | Hindsight mapping | Greatstone addition? |
|---|---|---|---|
| Stable identity | `memory_records.id` (uuid) | `document_id` = record id; derived `memory_units` link back via `document_id` | Partly; the engine has document ids |
| Company | `company_id` | One bank set per company: `gs-{companyId}-…` | Addition (bank naming) |
| Scope (org / client / project / agent) | `scope_id` → `memory_scopes` (kind, parent, project_id, agent_id) | Bank for hard boundaries (client, restricted project). Tags `scope:org`, `scope:project:{id}`, `scope:agent:{id}` | Addition. The engine only has banks and tags. |
| Contributor | `contributor_agent_id` / `contributor_user_id`, `run_id` | Tag `by:{agentId}` plus metadata | Addition (GSAM identity) |
| Originating task/document | `source_kind` + `source_id` (issue, comment, document revision, run, external object) | Metadata `source_ref` | Addition |
| Source / evidence | `evidence` jsonb (quotes, URLs, revision ids) | `context` field on retain | Addition |
| Dates | `created_at`, `effective_from`, `effective_to` | `timestamp` → `occurred_start`; `mentioned_at` | Engine has event dates. Validity window is an addition. |
| Status | `proposal`, `observation`, `approved`, `disputed`, `superseded`, `deleted` | Tag `status:{value}`, rewritten on change | Addition. The engine has no status. |
| Sensitivity | `internal`, `confidential`, `restricted` | Tag `sens:{value}` | Addition |
| Version links | `supersedes_id`, `superseded_by_id`, `version` | Engine `invalidate` on superseded units (soft retire) | Mostly an addition. Engine curation history is per fact only. |
| Source vs inferred | `kind`: `source_statement` or `inferred_summary` (with `derived_from` ids) | `chunks` mode = verbatim; extracted `world`/`experience` units and `observation`s = inferred | Labelling is an addition |

Status words: **proposal** is an agent claim that should become shared knowledge. **Observation** is something seen in work, useful as evidence. **Approved** is a decision from an approver. **Disputed** has an open conflict. **Superseded** has been replaced by a newer record and is linked to it. **Deleted** is a tombstone: the GSAM row stays with no content, and the Hindsight document is deleted. Hindsight "observations" (engine consolidation) are a different thing from the GSAM status "observation". The gateway never exposes the engine term.

Precedence at recall: approved records rank and display first. A newer proposal never overwrites an approved record. If an unreviewed record conflicts with an approved one, both are returned and marked. Newest is not treated as correct.

## 4. Does Hindsight still run model extraction?

Yes, by default. The default `concise` retain mode calls a model to extract facts, and causal-link extraction is on by default. `verbatim` mode still calls a model for entities and dates. Consolidation, `reflect`, mental-model refresh and knowledge pages also call models.

**Exception:** retain mode `chunks` stores text as-is with **no model call**. Callers can still pass `entities` (with `resolve_entities=false`), `tags`, `metadata` and `timestamp`. Entity resolution uses trigram matching, not a model. Recall uses local embeddings and a local cross-encoder reranker by default. From the source, recall makes no model call; phase 1 verifies this.

MVP rule:

- Structured agent findings use `chunks` mode, with entities supplied by the agent.
- Free-text document ingestion (for example an issue document) is out of the MVP. When it is added, it uses `concise` mode under a budget.
- Observations (`ENABLE_OBSERVATIONS=false`), reflect, mental models and causal links are off.

With these settings the MVP should make **no model calls for memory**, apart from local embeddings and reranking, which cost CPU and RAM (Ridge measures them on GRE-650). This is a design target, not a promise. Phase 1 verifies it from Hindsight's `llm_requests` table on synthetic data. There is no paid provider fallback; Bedrock's provider matrix (GRE-649) decides any later extraction route.

## 5. Proposed scope hierarchy and defaults (for John at G1)

```
company (instance)
├── organization       approved org knowledge + unreviewed org contributions
├── team / project     one per GSAM project (tags in the company bank)
│   └── restricted project   own bank, opt-in
├── client             one per Greatstone client (own bank, never shared)
└── agent working      one per agent (tags in the company bank)
```

| Scope | Read (default) | Contribute (default) | Approve | Correct / supersede | Delete |
|---|---|---|---|---|---|
| Organization | All agents in the company | Agents with `memory:contribute` on org (default: none; John grants) | John for pricing, policy, legal and client commitments; Everest for operational facts | Approver of that record class | John |
| Team / project | Agents on the project (project lead + assigned agents) | Same agents, as unreviewed | Project lead agent or John; never the contributor | Approver | John or Everest |
| Restricted project | Explicit grant only | Explicit grant only | John | John | John |
| Client | Explicit grant only. Never visible from org scope. | Explicit grant only | John | John | John |
| Agent working | That agent only | That agent | Not applicable (never "approved") | That agent | That agent, John |
| Steward (Cairn, phase 2) | Read on scopes granted per scope, audited | No | **No** | No; proposes resolutions only | No |

Rules: deny by default. No one approves their own contribution. No agent can grant itself or another agent a memory permission; `permission_grant` approvals stay with John (G3). Sensitivity `restricted` is not ingested in the MVP. Org visibility never overrides client or restricted-project boundaries.

**Proposed retention and deletion:**

| Record | Kept | Then |
|---|---|---|
| Agent working memory | 90 days after last recall or update | Deleted (tombstone) |
| Unreviewed proposal or observation | 180 days unless approved, disputed or cited by an approved record | Deleted (tombstone); the steward lists them 14 days before |
| Approved | Until superseded | — |
| Superseded | 1 year after supersession (audit trail) | Content deleted; tombstone and links kept |
| Disputed | Until resolved | Follows the resolution |
| Client scope | Until the client is off-boarded, then deleted with the bank | Bank deleted; tombstones kept for audit |
| Deleted | Content removed from Hindsight at once (document delete) | GSAM tombstone with no content |
| Backups | Ridge's backup retention (GRE-650) | **A deleted record survives in backups until they expire.** We say this plainly to users. |

Open questions for G1: the exact day counts above; whether any client data is allowed in the MVP (proposal: no, synthetic only until G4); and who besides John approves organization knowledge.

## 6. Bounded MVP (phases 1–2)

**Phase 1: gateway and engine foundation (synthetic data, sandbox only)**

- Data: `memory_scopes`, `memory_records`, `memory_operations`. Additive migration; rollback drops the three new tables.
- Shared types and validators in `packages/shared`. New permission keys `memory:read`, `memory:contribute`, `memory:approve`, `memory:correct`, `memory:delete` and `memory:admin` on `principal_permission_grants` with `scope: { memoryScopeId }`.
- `server/src/services/memory-gateway/`, with a small engine adapter (`HindsightAdapter`) behind an interface so the engine can be swapped.
- Routes under `/api/companies/:companyId/memory/` (`records`, `recall`, `records/:id`), plus three tool-gateway tools: `memory_recall`, `memory_contribute`, `memory_get`.
- Greatstone Hindsight extension for the key, the assertion and the tag scope, with MCP off.
- Instance setting `enableOrgMemory`, off by default, which respects hidden settings.
- Tests (exit gate): authorized read/write; cross-company, cross-client, cross-project and forged-identity calls fail; direct calls to the Hindsight port without a valid assertion fail; the engine down returns "unavailable" and queues writes; backup and restore are shown (Ridge).

**Phase 2: shared contributions and daily audit**

- Status transitions approve, dispute, supersede and delete, through a new approval type `memory_record_approval` in `approvals`. No self-approval.
- Contribution checks: scope and identity; secret and sensitive-content detection (reuse `run-secret-redaction.ts` patterns), labelled as fallible; conflict flag from a recall against approved records with the same entities or tags.
- Conflict queue: grouped conflicts sent as a `request_confirmation` on a steward issue, with sources, scope, current approved position and a proposed resolution. Important classes go to John.
- Steward routine (cron, catch-up policy) with a durable `memory_review_cursor` and idempotent items.
- Deletion across the GSAM row, the Hindsight document and its derived units, and the indexes. Phase 2 tests whether Hindsight document delete removes every derived row; observations are off, so there are none to chase.
- Tests (exit gate): price conflict, dated decision change, different-client facts, malicious source text, self-approval attempt, an interrupted audit that resumes without loss or repeated escalation.

**Out of scope for the MVP:** the management screen and graph (phase 3, Mica); conversational or delegated access changes (G3); automatic capture from runs, comments or documents; free-text extraction; Hindsight observations, reflect, mental models and knowledge pages; multimodal content; external sources (email, drives); Cognee, Graphiti or Mem0; client-instance packaging (phase 5); any install or change on John's PC (G2); any paid model use.

## 7. Cognee, Graphiti, Mem0: is there a concrete gap?

**Not for phases 1–2.** The MVP needs are met by Hindsight plus the GSAM record:

- **Dated decision changes:** Graphiti's bi-temporal edges and automatic invalidation look relevant. We meet this need with GSAM `effective_from`/`effective_to` plus explicit supersession. Automatic invalidation by a model is the "newest wins" behaviour the brief rejects.
- **Metadata filters** (Mem0): covered by strict tags and the GSAM post-filter.
- **Ontology / schema graphs** (Cognee): not needed for the MVP.

**One candidate gap for phase 3, for Delta to evaluate only if the graph design needs it:** typed entity-to-entity relations (subject–predicate–object, for example "Client X — contract — Price list v3") and point-in-time graph queries. Hindsight has typed memory-to-memory links and entity co-occurrence counts, but no typed entity relations. The test: can the phase 3 graph be built from Hindsight links plus GSAM version links? If yes, no extra component. If Graphiti is added later, Hindsight stays the record of content and Graphiti only a derived index, so there is no second source of truth.

## Alternatives Considered

### Register Hindsight as an ordinary MCP connection through the existing tool gateway
- **Pros**: almost no code; the experimental connector path already exists.
- **Cons**: scope rests on the agent choosing the right bank or tag; no status, approval or supersession; a bank id is enough to reach data.
- **Why not**: it fails the brief's "a bank address must not bypass authorization" and the record model.

### Build the gateway as a plugin (like `plugin-llm-wiki`)
- **Pros**: isolated code and schema; there is a precedent for cursors and routines.
- **Cons**: the plugin SDK has no hook into grants, approvals or actor scoping; governance would be copied, not reused.
- **Why not**: permission checks must sit in core, next to `authz.ts` and the tool gateway.

### Use Hindsight tenants (schema per tenant) instead of banks for every scope
- **Pros**: strongest separation in the engine.
- **Cons**: one schema per project or agent multiplies migrations and indexes; recall across scopes needs many calls.
- **Why not**: use banks for hard boundaries (client, restricted) and strict tags for the rest. Revisit per-client schemas at phase 5.

### Mem0 or our own pgvector store as the engine
- **Pros**: Mem0 has metadata filters and a simpler API. Our own store gives full control.
- **Cons**: Mem0 rewrites memories with a model at write time (more model calls, harder audit). Our own store means building retrieval, ranking and graph links ourselves.
- **Why not**: Hindsight gives better retrieval and graph links with a zero-model ingest mode, and our audit needs append-and-supersede, not rewrite.

## Consequences

### Positive
- One place for identity, scope, audit and approval; the engine can be swapped behind `HindsightAdapter`.
- The MVP aims at no model calls for memory, which keeps subscription use and spend at zero by default.
- It reuses existing grants, approvals, routines, secrets and the tool gateway; no new auth system.

### Negative
- Two stores must stay in step (the GSAM row and the Hindsight document). It needs a `sync_state`, retries and a reconcile check.
- Every governance field is a Greatstone addition we maintain, plus a small Python extension in the engine.
- The `chunks` mode gives weaker fact-level retrieval than model extraction; quality is measured in phase 4.

### Risks
- **Hindsight is pre-1.0 and changes fast** (the opinion type was removed in a migration; re-processing resets curation). Mitigation: pin the version (GRE-648), keep the adapter thin, and run an upgrade test before each bump.
- **Engine port reachable from agent processes on the same host.** Mitigation: key plus signed assertion plus no published port; Summit's bypass test at the phase 1 exit (GRE-651).
- **Deletion completeness** (derived rows, indexes, backups). Mitigation: a phase 2 deletion test, and backup expiry stated plainly.
- **Detection is fallible.** Sensitive-content and conflict checks are labelled as hints, never as proof.
