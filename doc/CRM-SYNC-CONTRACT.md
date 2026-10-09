# CRM sync: shared types and API contract

Status: tables and routes built (GRE-1100 part 1). Source: GRE-1069 discovery deck v7, slides 6-9.
The tables (migration `0305_crm_sync_tables`) and every route below except `POST .../sync`
exist. No sync job, adapter or external call exists yet; the Pipedrive read adapter is
GRE-1100 part 2.

Code:

- `packages/shared/src/crm-sync.ts` — constants and the three-value rule (`decideCrmSyncField`).
- `packages/shared/src/validators/crm-sync.ts` — request and record validators.
- `packages/shared/src/types/crm-sync.ts` — API response shapes.
- `packages/db/src/schema/crm_sync.ts` — tables: `crm_sync_bindings`, `crm_sync_field_maps`,
  `crm_sync_record_links`, `crm_sync_conflicts`, `crm_sync_events`.
- `server/src/services/crm-sync.ts`, `server/src/routes/crm-sync.ts` — the routes below.

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
- **Conflict** — a shared field that changed on both sides. Holds all three values until a
  person resolves or dismisses it.

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
| `POST /api/crm-sync/bindings/:bindingId/sync` | `runCrmSyncBindingSchema` | 202, queues one pass (comes with the sync job, part 2) |
| `GET /api/crm-sync/bindings/:bindingId/events` | `listCrmSyncEventsQuerySchema` | `CrmSyncPage<CrmSyncEvent>`, newest first |
| `GET /api/companies/:companyId/crm-sync/conflicts` | `listCrmSyncConflictsQuerySchema` (open by default) | `CrmSyncPage<CrmSyncConflict>` |
| `POST /api/crm-sync/conflicts/:conflictId/resolve` | `resolveCrmSyncConflictSchema` | `CrmSyncConflict` |
| `POST /api/crm-sync/conflicts/:conflictId/dismiss` | `dismissCrmSyncConflictSchema` | `CrmSyncConflict` |
| `GET /api/cases/:caseId/crm-sync/links` | — | `CrmSyncRecordLink[]` for the case and its contacts |

Notes:

- `POST .../bindings` checks that the connection and pipeline belong to the company and that
  every `stageKey` exists on the pipeline. One external container may be bound once per company.
- Resolving with `keep_crm`, `keep_gsam` or `custom` writes the chosen value to both sides on the
  next pass and stores it as the last-synced value. A resolved conflict is never reopened; a new
  change makes a new conflict.
- Record links are written by the sync only. There is no route to edit them by hand in this phase.
- Sync events and conflicts are written by the server only (`crmSyncEventSchema`,
  `crmSyncConflictSchema` validate what the sync writes).
- Inbound webhooks from CRMs are out of scope here; they come with the first adapter.
- The routes are off while `enablePipelines` is off (403 `not_entitled`), because every binding
  targets a pipeline.
- `fields.<key>` in a field map must name a typed field (GRE-1075) on the bound pipeline that is
  not archived (422 `unknown_pipeline_field`).
- DELETE is a soft delete (`deleted_at`). The same container can be bound again afterwards.
- Another company's binding, conflict or case answers 404, so ids do not leak.

## Not in this slice

- Sync job, scheduler, adapter or external call (GRE-1100 part 2).
- Which CRMs ship first, and anything marked Open on slide 38 of the deck.
