# gs-interview-v1: GSAM runs a Parallel Interview round on the website

GRE-2612 (website side), GRE-2611 (GSAM side). This folder is at the same path in `greatstone-website` and
`gs-agentic-manager`: change it in both pull requests or neither.

GSAM calls outward; the website never calls GSAM. Every call is a signed admin-bridge call
(`contracts/gs-bridge-v1/`): `GET` with a **read** key (`gs-bridge-v1`), `POST` with a **write** key
(`gs-bridge-v2`, so each write carries `X-GS-Bridge-Idempotency-Key` and a retry with the same key and body writes
nothing twice). Errors are `{ error: { code } }` as in gs-bridge-v1. Prefix: `/api/admin/v1/interview/`.

A **round** is one interview engagement. GSAM makes the round id (uuid) and keeps it. The website stores the round
under that id. One round per client engagement (the Deep Dive's first step).

## Writes (write key, POST)

### `POST rounds/{roundId}` — create or update a round

```json
{
  "schema": "gs-interview-round-v1",
  "clientName": "Example Ltd",
  "customerId": "uuid of the website customer, or null",
  "sponsor": "text or null",
  "mode": "team | person",
  "targetMinutes": 20,
  "status": "draft | open | closed",
  "seatTotal": 40,
  "costEnvelopePence": 50000,
  "endDate": "2026-11-13 or null",
  "retentionDeleteAfter": "2027-02-13 or null",
  "enrol": { "enabled": true, "expiresAt": "ISO or null", "allowedEmailDomains": ["example.com"],
             "defaultUnitId": "uuid or null", "rotateToken": false },
  "units": [ { "id": "uuid", "parentId": "uuid or null", "name": "Finance", "kind": "team", "seatAllocation": 8 } ],
  "contextPack": {
    "company_background": "", "org_summary": "", "systems": "", "scope": "", "glossary": "",
    "do_not_discuss": "", "working_pattern": "", "priority_questions": "",
    "units":  { "<unit id>": "questions and notes for this team" },
    "people": { "<email, lower case>": "questions and notes for this person" }
  }
}
```

- `contextPack` keys are Everest's (`renderContextPack`). `units` is used in `team` mode, `people` in `person` mode.
  Each save makes a new approved context-pack version and points the round at it: a live interview keeps the version
  it started with only for its current turn; the next turn reads the new one.
- Units are upserted by id. A unit that GSAM leaves out is kept if anyone is placed in it, otherwise removed.
- `status: open` needs an approved context pack, `seatTotal > 0` and at least one allowed domain. `draft` and
  `closed` refuse new interviews; `closed` also closes enrolment.
- Answer `200 { round }` (shape under "Reads"). The round's `joinUrl` carries the enrolment token. It is returned on
  every answer; `rotateToken: true` makes a new token and the old link stops working.

### `POST rounds/{roundId}/invites` — invite people

```json
{ "people": [ { "email": "a@example.com", "name": "A Person", "roleTitle": "Analyst", "unitId": "uuid or null",
                "portalRole": "employee | team_leader | client_admin" } ],
  "send": true }
```

- Creates each person's place in the round (status `invited`); an email already on the round is updated, never
  duplicated. Emails must be on the round's allowed domains, except `client_admin`.
- `send: true` makes the website email each new invitee the round's join link (Resend, from the site). Nothing is
  emailed on a replay. Answer `200 { invited: [ { email, employeeId, outcome: "created | updated" } ], emailed }`.
- At most 200 people per call.

### `POST rounds/{roundId}/synthesis` — run synthesis

Starts the synthesis pipeline in the background (Opus; minutes). Answer `202 { started: true }`. Poll
`GET rounds/{roundId}/synthesis/latest`. A run already in progress answers `409 conflict`.

### `POST rounds/{roundId}/synthesis/{synthesisId}/release` — the release gate

A person in GSAM has reviewed this synthesis. After release, the client's admins see it on the website
(`#portal/interview/results`). Nothing else ever reaches the client. Answer `200 { round }`.

### `POST rounds/{roundId}/synthesis/withdraw` — withdraw the release

The client stops seeing it at once. Answer `200 { round }`.

### `POST rounds/{roundId}/close` — close the round

Closes enrolment and runs the abandonment close-out for open sessions now (the scheduled close-out does the same
after the idle limit). Answer `200 { round, closedSessions }`.

## Reads (read key, GET)

### `GET rounds/{roundId}`

```json
{ "item": { "id": "uuid", "clientName": "", "customerId": null, "mode": "team", "status": "open",
  "targetMinutes": 20, "seatTotal": 40, "joinUrl": "https://…/#join/<token>", "enrol": { … },
  "counts": { "invited": 0, "started": 0, "completed": 0, "declined": 0, "abandoned": 0 },
  "spendPence": 0, "costEnvelopePence": 50000, "contextPackVersion": 3,
  "released": { "synthesisId": "uuid or null", "releasedAt": "ISO or null" } } }
```

### `GET rounds/{roundId}/people`

`{ items: [ { employeeId, email, name, roleTitle, unitId, portalRole, status, sessionStartedAt, sessionEndedAt,
completionScore, phase } ] }`. Status and progress only: no interview content.

### `GET rounds/{roundId}/events?after=<cursor>&limit=<1..100>`

The engine's outbox (formerly sent to Notion), oldest first: `{ items: [ { cursor, event, createdAt, payload } ],
nextCursor }`. Events: `phase_complete` and `session_end` (with insights; `session_end` also has the transcript).
Insights carry `attribution_redacted`: when true, GSAM must not show the person's name with that insight. A person
who withdraws is hard-deleted and their events are removed.

### `GET rounds/{roundId}/synthesis/latest`

`{ item: <synthesis or null> }`: the newest synthesis, released or not (for review in GSAM).

### `GET rounds/{roundId}/synthesis/released`

`{ item: <synthesis or null> }`: exactly what the client sees.

## What the website does on its own

- The join page, account sign-up (Better Auth, email verified), enrolment checks (token, domain, seats), the
  interview, consent, sign-off read-back, memory opt-in and hard-delete opt-out.
- Abandonment close-out (scheduled), retention delete after `retentionDeleteAfter` (scheduled).
- The client sees only a released synthesis.
