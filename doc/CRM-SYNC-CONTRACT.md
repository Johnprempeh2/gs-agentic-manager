# CRM sync: shared types and API contract

Status: tables, routes, the Pipedrive read adapter (GRE-1100) and the review queue with
write-back to Pipedrive (GRE-1076) built. Source: GRE-1069 discovery deck v7, slides 6-9. The
tables are migrations `0305_crm_sync_tables` and `0307_crm_sync_review_queue`. Only the sync
runner writes to a CRM; agents never do with direct tool calls.

Code:

- `packages/shared/src/crm-sync.ts` — constants and the three-value rule (`decideCrmSyncField`).
- `packages/shared/src/validators/crm-sync.ts` — request and record validators.
- `packages/shared/src/types/crm-sync.ts` — API response shapes.
- `packages/db/src/schema/crm_sync.ts` — tables: `crm_sync_bindings`, `crm_sync_field_maps`,
  `crm_sync_record_links`, `crm_sync_conflicts`, `crm_sync_events`.
- `server/src/services/crm-sync.ts`, `server/src/routes/crm-sync.ts` — the routes below.
- `server/src/services/crm-sync-pipedrive.ts` — Pipedrive client: reads deals, updates one deal (429 back-off).
- `server/src/services/crm-sync-runner.ts` — one sync pass and the poll scheduler.
- `ui/src/components/PipelineCaseCrmSync.tsx` — the "CRM sync" section on the client case page.
- `ui/src/components/CrmSyncConflictQueue.tsx` — the "Sync conflicts" queue (Review queue page and
  case page) and "Suggest a change to a CRM field".

## The model

```
connection ─► binding ─► field map (one owner per field) ─► sync in / out ─► conflict queue
                                                                  └────────► sync log
```

- **Connection** — an existing company connection (`connectionId`). Credentials stay there; sync never stores them.
- **Binding** — links one external container to one GSAM pipeline. The container is a CRM
  pipeline (`containerKind: "crm_pipeline"`) or a Notion database (`"notion_database"`).
  A binding has a `direction` (`both` by default, `inbound_only`, `outbound_only`), a
  `status` (`active`, `paused`, `error`; only the server sets `error`) and a stage map
  (external stage id → GSAM stage key, each external stage once).
- **Field map** — rows of `externalField ↔ gsamField` with an `owner`. The GSAM side is
  `title`, `summary`, `fields.<key>` or `contact.<name|role|phone|email>`. Each field appears
  once on each side, so each field has exactly one owner. Stage is mapped by the stage map, not here.
- **Field owner** — `crm` (CRM wins), `gsam` (GSAM wins) or `shared` (either side may edit).
- **Record link** — the external id a GSAM case or contact holds. One per source
  (connection), so one contact can hold a HubSpot id and a Notion page id at the same time.
- **Sync event** — one line of the sync log per record per pass: direction, action
  (`created`, `updated`, `unchanged`, `conflict`, `failed`), changed fields with from/to values.
  `failed` needs an error message; `conflict` points to its conflict.
- **Conflict** — a shared field that changed on both sides. Holds all three values, who changed
  the GSAM side and when the CRM record changed, until a person resolves or dismisses it.
- **Suggestion** — a requested change to a CRM-owned field, made by a person or an agent with
  Work cases, with a reason. It sits in the same queue (`kind: "suggestion"`) and is written to
  the CRM only after a person accepts it.

## The three-value rule

For every mapped field on every pass the sync compares three values: the **last synced**
value (what both sides held after the last good sync), the **CRM value** and the **GSAM value**.
`decideCrmSyncField` returns the action.

| Situation | crm-owned | gsam-owned | shared |
| --- | --- | --- | --- |
| CRM = GSAM | none | none | none |
| Only CRM changed | pull CRM value | push GSAM value | pull CRM value |
| Only GSAM changed | pull CRM value | push GSAM value | push GSAM value |
| Both changed, different | pull CRM value | push GSAM value | **conflict** |
| Never synced, one side empty | pull CRM value | push GSAM value | fill the empty side |
| Never synced, both filled, different | pull CRM value | push GSAM value | **conflict** |

- Values are compared after trimming. `null`, missing, blank text and an empty list are all "empty".
- On `none`, the caller stores the agreed value as the new last-synced value.
- A conflict writes nothing to either side. The field keeps its last-synced value until it is resolved;
  other fields on the same record still sync.
- Binding `direction` limits what may be written: an `inbound_only` binding never pushes, an
  `outbound_only` binding never pulls. A blocked write is logged as `unchanged`.

## Endpoints

All routes are company-scoped like the pipeline routes: the binding, case or conflict is
loaded, its `companyId` is checked against the caller (`assertCompanyAccess`), and every query
filters by `companyId`. Writes to bindings, field maps and conflicts need a board user of the
company; agents may read. Every write is recorded in the activity log.

| Method and path | Body / query | Returns |
| --- | --- | --- |
| `GET /api/companies/:companyId/crm-sync/bindings` | — | `CrmSyncBinding[]` |
| `POST /api/companies/:companyId/crm-sync/bindings` | `createCrmSyncBindingSchema` | `CrmSyncBinding` (201) |
| `GET /api/crm-sync/bindings/:bindingId` | — | `CrmSyncBinding` |
| `PATCH /api/crm-sync/bindings/:bindingId` | `updateCrmSyncBindingSchema` (label, direction, pause/resume, stage map) | `CrmSyncBinding` |
| `DELETE /api/crm-sync/bindings/:bindingId` | — | 204. Stops sync. Keeps the log, record links and resolved conflicts; open conflicts are dismissed. |
| `GET /api/crm-sync/bindings/:bindingId/field-map` | — | `CrmSyncFieldMap` |
| `PUT /api/crm-sync/bindings/:bindingId/field-map` | `replaceCrmSyncFieldMapSchema` (whole map) | `CrmSyncFieldMap` |
| `POST /api/crm-sync/bindings/:bindingId/sync` | `runCrmSyncBindingSchema` | 202 `CrmSyncRunQueued`. Queues one inbound pass; the scheduler runs it within a minute. |
| `GET /api/crm-sync/bindings/:bindingId/events` | `listCrmSyncEventsQuerySchema` | `CrmSyncPage<CrmSyncEvent>`, newest first |
| `GET /api/companies/:companyId/crm-sync/conflicts` | `listCrmSyncConflictsQuerySchema` (open by default) | `CrmSyncPage<CrmSyncConflict>` |
| `POST /api/crm-sync/conflicts/:conflictId/resolve` | `resolveCrmSyncConflictSchema` (optional `reason`) | `CrmSyncConflict`. Person with Administer. |
| `POST /api/crm-sync/conflicts/:conflictId/propose` | `proposeCrmSyncConflictResolutionSchema` (`reason` required) | `CrmSyncConflict`. Agent or person with Work cases. Changes nothing. |
| `POST /api/crm-sync/conflicts/:conflictId/accept-proposal` | `{}` | `CrmSyncConflict`. Person with Administer. |
| `POST /api/crm-sync/conflicts/:conflictId/dismiss` | `dismissCrmSyncConflictSchema` | `CrmSyncConflict`. Person with Administer, or the suggester withdrawing. |
| `POST /api/cases/:caseId/crm-sync/suggestions` | `createCrmSyncSuggestionSchema` | 201 `CrmSyncConflict` (`kind: "suggestion"`). Agent or person with Work cases. |
| `GET /api/cases/:caseId/crm-sync/links` | — | `CrmSyncRecordLink[]` for the case and its contacts |
| `GET /api/cases/:caseId/crm-sync/status` | — | `CrmSyncCaseStatus`: per source, the binding state, rate-limit wait and newest log line |

Notes:

- `POST .../bindings` checks that the connection and pipeline belong to the company and that
  every `stageKey` exists on the pipeline. One external container may be bound once per company.
- Resolving with `keep_crm`, `keep_gsam` or `custom` writes the chosen value to both sides on the
  next pass and stores it as the last-synced value. A resolved conflict is never reopened; a new
  change makes a new conflict.
- Record links are written by the sync only. There is no route to edit them by hand in this phase.
- Sync events and conflicts are written by the server only (`crmSyncEventSchema`,
  `crmSyncConflictSchema` validate what the sync writes).
- `POST .../sync` answers 422 `direction_not_allowed` for `direction: "outbound"` on an
  `inbound_only` binding (or `"inbound"` on an `outbound_only` one), 422 `provider_not_supported`
  for a CRM other than Pipedrive, and 409 `binding_not_active` for a paused or errored binding. While the CRM is rate limiting, the pass
  waits for `rateLimitedUntil`.
- The routes are off while `enablePipelines` is off (403 `not_entitled`), because every binding
  targets a pipeline.
- `fields.<key>` in a field map must name a typed field (GRE-1075) on the bound pipeline that is
  not archived (422 `unknown_pipeline_field`).
- DELETE is a soft delete (`deleted_at`). The same container can be bound again afterwards.
- Another company's binding, conflict or case answers 404, so ids do not leak.

## Pipedrive read sync (part 2)

- **Credential:** read from the company vault through the connection's own secret binding
  (`credentials.api_token`, else the first credential on the connection). Never stored on the
  binding. API tokens go in the `x-api-token` header, OAuth tokens as `Bearer`.
- **Poll:** the scheduler checks once a minute for active, non-deleted Pipedrive bindings whose
  `nextSyncAt` is due, claims each one, and runs a pass. After a good pass the next one is 5
  minutes later. Nothing runs while `enablePipelines` is off.
- **One pass:** `GET /api/v1/dealFields` (for choice labels), then `GET /api/v2/deals` for the
  bound Pipedrive pipeline, changed since the last pass (`updated_since`), oldest first, page by
  page. Progress (`syncState.updatedSince`) is saved after every page.
- **New deal:** a case is made through the pipeline service (case key `pipedrive-<dealId>`, stage
  from the stage map, else the first stage), then linked. Imported cases follow the stage's
  automation like any new case.
- **Linked deal:** each mapped field goes through the three-value rule. Pulls are written to the
  case; pushes are not sent; conflicts are queued. The stage moves only when the deal's stage
  changed since the last sync, so a move made in GSAM is not undone by an unrelated deal edit.
  A resolved conflict writes its chosen value into the case on the next pass.
- **Sync log:** one line per deal that changed something: `created`, `updated`, `conflict`,
  `unchanged` (only a push was due, which this slice does not send) or `failed` with the reason.
  A deal that changed nothing writes no line. A failed import is tried again when the deal
  changes in Pipedrive.
- **429:** each request is retried 3 times after the wait Pipedrive asks for (`retry-after`,
  else 1s, 2s, 4s; max 30s). If it still fails, the binding stays `active`, `rateLimitedUntil`
  and `nextSyncAt` move out (5 min, doubling per pass in a row, max 30 min), and
  `lastErrorMessage` says when it retries. The case page shows the wait.
- **401/403 or no credential:** the binding goes to `error` and stops polling. A person
  reconnects Pipedrive and sets the binding back to `active`.
- **Other errors:** the binding stays `active` and retries later (5 min, doubling, max 1 hour).
- `contact.*` field map rows are kept but not imported or written back yet.

## Review queue and write-back (GRE-1076)

- **Hold:** an open conflict or suggestion holds that field for that case. The pass neither pulls
  nor pushes it; other fields on the record keep syncing both ways.
- **Write-back:** after the inbound pages, a pass finds linked cases changed in GSAM since they
  last synced (or with a decision since then), reads each deal (`GET /api/v2/deals/:id`) and runs
  the three-value rule. Pushes go out in one `PATCH /api/v2/deals/:id` per deal: top-level fields
  by name, custom fields (40-character keys) under `custom_fields`, choice labels turned back
  into option ids. Pipedrive's own fields (`id`, `update_time`, `add_time`, ...) are never sent.
  A field that has never synced is not blanked in the CRM.
- **Direction:** `inbound_only` never pushes (it still applies queue decisions to GSAM);
  `outbound_only` never pulls and skips the inbound pages.
- **Decisions:** keep CRM, keep GSAM or a typed value (stored as the field's type; a non-number
  for a number field is 422 `invalid_value`). The chosen value goes to GSAM and the CRM on the
  next pass, which a decision brings forward. For a suggestion, keep GSAM accepts it and keep CRM
  rejects it; a rejected suggestion writes nothing.
- **Who decides:** a person with Administer (`pipelines:write`) on the bound pipeline. Agents
  never decide. An agent or person with Work cases may propose a resolution with a reason; a
  person accepts it with `accept-proposal` (409 `proposal_changed` if it was replaced meanwhile).
- **Own change:** nobody resolves, accepts or dismisses a conflict whose GSAM side was changed by
  them alone (403 `own_change`). The GSAM authors are the people and agents with content edits on
  the case since the last sync; the sync's own edits do not count. The CRM side is not counted,
  because CRM users are not matched to GSAM users yet. A suggester may withdraw their own
  suggestion.
- **Record:** each pass writes inbound and outbound log lines with from/to values; an outbound
  line that applies a decision points to its conflict. Proposals, suggestions and decisions go to
  the activity log with before (last synced, CRM, GSAM), after, who and why.
- **Failed write-back:** logged as an outbound `failed` line with the reason. A passing error
  (network, 5xx) keeps the link's last sync time, so the next pass retries; a value Pipedrive
  cannot take (an unknown choice label, a read-only field) is not retried until the value
  changes. A 429 or refused credential stops the pass as for reads.

## Not in this slice

- Stage write-back. A stage moved in Pipedrive still moves the case; a stage moved in GSAM is not
  sent to Pipedrive yet.
- Matching CRM users to GSAM users, so the own-change rule can count the CRM side.
- A named reviewer per pipeline (deck slide 8); Administer decides for now.
- Inbound webhooks. Polling covers Pipedrive; webhooks need a public address and come later.
- Importing Pipedrive persons into case contacts (`contact.*` rows).
- Adapters for other CRMs and Notion.
- Which CRMs ship first, and anything marked Open on slide 38 of the deck.
