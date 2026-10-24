# CRM sync: shared types and API contract

Status: tables, routes, the Pipedrive read adapter (GRE-1100) and the review queue with
write-back to Pipedrive (GRE-1076) built. Source: GRE-1069 discovery deck v7, slides 6-9. The
tables are migrations `0305_crm_sync_tables` and `0307_crm_sync_review_queue`. Only the sync
runner and the website enquiry copy service write to a CRM; agents never do with direct tool calls.

Code:

- `packages/shared/src/crm-sync.ts` — constants and the three-value rule (`decideCrmSyncField`).
- `packages/shared/src/validators/crm-sync.ts` — request and record validators.
- `packages/shared/src/types/crm-sync.ts` — API response shapes.
- `packages/db/src/schema/crm_sync.ts` — tables: `crm_sync_bindings`, `crm_sync_field_maps`,
  `crm_sync_record_links`, `crm_sync_conflicts`, `crm_sync_events`.
- `server/src/services/crm-sync.ts`, `server/src/routes/crm-sync.ts` — the routes below.
- `server/src/services/crm-sync-pipedrive.ts` — Pipedrive client: reads deals, updates one deal (429 back-off).
- `server/src/services/crm-sync-runner.ts` — one sync pass and the poll scheduler.
- `server/src/services/website/enquiries.ts`, `enquiry-pipedrive.ts` — website lead import and its Pipedrive copy.
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
- Record links are written by the sync runner or the website enquiry copy service. There is no route to edit them by hand.

## Website enquiries (GRE-2324)

The website admin bridge is read-only from GSAM's side. A connected site can be checked by a person with website Edit access, and a scheduler checks connected sites every five minutes once a bridge reader is configured. The bridge reader returns pages of enquiries with opaque cursors. The real bridge connection and staging switch-over belong to GRE-2323; until then, tests provide a fake reader.

Each website enquiry becomes one case in the `website-enquiries` Pipeline. Its case key includes the site and enquiry ids. The case retains source, page, UTM, consent and submission time in fields, and links to an Organisation by email domain when a live company-scoped match exists. Personal mailbox domains do not group unrelated people. A linked GSAM task provides the inbox item, routed to the Front door module owner or the company's default responsible user when one is set. The site's Resend owner alert remains the website's responsibility.

The copy service uses an active Pipedrive sync connection. It creates or finds the contact person, sets a stable `origin_id` on the Pipedrive lead, and stores the external lead id in `crm_sync_record_links`. A repeat pass checks the link; after an interrupted write it searches Pipedrive by `origin_id` before creating another lead. The read importer skips leads with this GSAM origin so the copy does not become a second GSAM case. The staging proof must confirm the connected account returns `origin_id` in lead-list answers and has person and lead write access.
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
  automation like any new case. Every case needs an organisation (GRE-1538): the deal's
  Pipedrive organisation is matched by Pipedrive id, then by name, else created; a deal with no
  organisation uses its title as the name. A linked case with no organisation gets one the same
  way on its next content update.
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

## Full read-only import (Organisations > Import from Pipedrive)

Separate from sync: it never writes to Pipedrive and needs no binding. After organisations and
people it reads `/v1/pipelines`, `/v1/stages`, `/v1/users`, `/v1/dealFields` and every deal that
is not deleted (`/v1/deals?status=all_not_deleted`). Code: `server/src/services/pipedrive-deal-import.ts`.

- Each Pipedrive pipeline becomes a GSAM pipeline keyed `pipedrive-<id>` with Pipedrive's stages
  (`pd_<stageId>`, working) in Pipedrive's order, then `won` (done) and `lost` (cancelled).
- Each deal becomes a case keyed `pipedrive-<dealId>` in its pipeline: open deals in their stage,
  won deals in Won, lost deals in Lost. It links to the imported organisation.
- Pipedrive's own deal fields (status, value, currency, owner, contact, expected close, probability,
  lost reason, labels, source, the dates) and every custom deal field become typed pipeline fields.
  Custom fields are keyed `pd_<pipedrive key>` and labelled with the Pipedrive name. A choice
  Pipedrive no longer lists is added to the field rather than dropped.
- Organisations and people keep every Pipedrive field that has a value and no GSAM column, in
  `crm_fields` (`[{ key, label, value }]`, migration `0356_crm_record_fields`), driven by
  `/v1/organizationFields` and `/v1/personFields`, so custom fields, labels, the full address and
  every email and phone come across under Pipedrive's names. The organisation page shows them
  under "From Pipedrive". A Pipedrive website fills an empty website. Code:
  `server/src/services/pipedrive-record-fields.ts`.
- Activities (`/v1/activities?user_id=0`, every user), notes (`/v1/notes`) and call logs
  (`/v1/callLogs`) land in `crm_timeline_entries` (migration `0357_crm_timeline_entries`), keyed
  on source, kind and Pipedrive id, linked to the GSAM organisation, contact and deal case. The
  organisation page lists them under "Activities and notes", newest first, with the ones linked
  to its people and cases. A done activity, a note or a past call counts as last contact. An
  account that cannot read call logs still imports everything else. Code:
  `server/src/services/pipedrive-timeline-import.ts`.
- Each imported deal's history (`/v1/deals/{id}/flow`, one read per deal) adds its emails
  (subject, snippet, from, to, cc) and its stage, pipeline and status changes to the same
  timeline, linked to the deal case (migration `0358_crm_timeline_email_history`). Other field
  changes, and activities and notes already read above, are not added twice.
- Emails on a person or organisation but not on a deal come from their own history
  (`/v1/persons/{id}/flow`, `/v1/organizations/{id}/flow`), read only for records whose
  `email_messages_count` is above 0. Each email is written once, linked to the person or
  organisation; one already on a deal stays on the deal.
- A person with no organisation in Pipedrive, or whose organisation was not imported, is kept as a
  contact with no organisation (`organisation_contacts.organisation_id` is nullable from migration
  `0359_contacts_without_organisation`). The Organisations page lists them under "People with no
  organisation", from `GET /api/companies/:companyId/organisation-contacts/unassigned`. The export
  file import does the same.
- The product catalogue (`/v1/products`, `/v1/productFields`) lands in `crm_products` with its
  code, unit, tax, owner, prices in every currency and every other field, custom fields included,
  under Pipedrive's name (migration `0360_crm_products`). The products on each deal
  (`/v1/deals/{id}/products`, read only for deals whose `products_count` is above 0) land in
  `crm_deal_products` with quantity, price, discount, tax, sum and comments, linked to the case
  and the catalogue product. The case also gets a "Products" field listing them with a total. A
  product taken off a deal in Pipedrive comes off the case. An account without the Products
  add-on still imports everything else, and a deal whose products cannot be read keeps what it
  had. Code: `server/src/services/pipedrive-product-import.ts`.
- The Leads inbox (`/v1/leads?archived_status=all`, `/v1/leadLabels`) becomes cases in one
  "Pipedrive leads" pipeline, keyed `pipedrive-lead-<id>`, with stages Lead, Archived and
  Converted or removed. Each lead keeps its value, owner, creator, person, organisation, labels,
  source, seen flag and the custom deal fields Pipedrive shares with leads. Pipedrive removes a
  lead when it is converted to a deal, so a lead no longer listed moves to Converted or removed.
  Activities and notes on a lead link to its case. An account with no leads gets no empty
  pipeline. Code: `server/src/services/pipedrive-lead-import.ts`.
- Every file (`/v1/files`) lands in `crm_files` with its name, size, owner, description and the
  deal, lead, person, organisation, activity or note it was on (migration `0361_crm_files`). The
  bytes are downloaded (`/v1/files/{id}/download`) once and copied into GSAM storage as an
  asset; a file on a deal or lead is also put on the case's files. A file linked from Google
  Drive and the like, larger than the upload limit, or of a type GSAM does not accept keeps its
  details and link without the bytes, with the reason. A failed download is tried again on the
  next import. The organisation page lists the files under "Files", served by
  `GET /api/companies/:companyId/crm-files/:fileId/content`. Code:
  `server/src/services/pipedrive-file-import.ts`.
- The people on each deal (`/v1/deals/{id}/participants`) become the case's contacts, the main
  contact first, keyed on the Pipedrive person id (`pipeline_case_contacts.source` and
  `external_id`, migration `0362_case_contact_sources`). A person taken off the deal in
  Pipedrive leaves the case; contacts added by hand in GSAM are never touched. The users
  following a deal (`/v1/deals/{id}/followers`) are named in a "Followers" field on the case.
  Deals whose participant or follower count is 0 are not asked. Code:
  `server/src/services/pipedrive-participant-import.ts`.
- An organisation's Pipedrive owner links to the GSAM member with the same email (from the
  owner link or `/v1/users`, case ignored, active members only) as its owner
  (`countryOwnerUserId`). When Pipedrive hands the organisation to someone with no GSAM account,
  the old member is unlinked and the name follows Pipedrive. Export files carry no owner email,
  so they leave the link alone.
- A rerun updates names, adds new stages before Won, moves cases whose deal changed stage or
  status, and updates changed fields. A deal moved to another pipeline in Pipedrive stays where it
  is, with its fields updated, and is listed in the import's error samples.

## Not in this slice

- Stage write-back. A stage moved in Pipedrive still moves the case; a stage moved in GSAM is not
  sent to Pipedrive yet.
- Matching CRM users to GSAM users, so the own-change rule can count the CRM side.
- A named reviewer per pipeline (deck slide 8); Administer decides for now.
- Inbound webhooks. Polling covers Pipedrive; webhooks need a public address and come later.
- Importing Pipedrive persons into case contacts (`contact.*` rows).
- Adapters for other CRMs and Notion.
- Which CRMs ship first, and anything marked Open on slide 38 of the deck.
