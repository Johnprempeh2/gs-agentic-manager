# gs-interview-v1: GSAM runs a Parallel Interview round on the website

GRE-2612 (website side), GRE-2611 (GSAM side). This folder is at the same path in `greatstone-website` and
`gs-agentic-manager`: change it in both pull requests or neither.

GSAM calls outward; the website never calls GSAM. Every call is a signed admin-bridge call
(`contracts/gs-bridge-v1/`): `GET` with a **read** key (`gs-bridge-v1`), `POST` with a **write** key
(`gs-bridge-v2`, so each write carries `X-GS-Bridge-Idempotency-Key` and a retry with the same key and body writes
nothing twice). Errors are `{ error: { code } }` as in gs-bridge-v1.

**Every path is keyed by the website organisation id** (John's rule 2, 25 Oct): the client's `customers.id` on the
website, which GSAM stores as the canonical client id on Clients > Organisation. Prefix:
`/api/admin/v1/interview/organisations/{organisationId}/`, so `rounds/{roundId}` below means
`/api/admin/v1/interview/organisations/{organisationId}/rounds/{roundId}`. The organisation is fixed when the round is
created. A round under another organisation answers `404 not_found`, and the database refuses it too (RLS on
`customer_id`). An organisation id the website does not have answers `400 bad_request`.

**People are website accounts** (Better Auth). A person's `userId` is the website user id; GSAM keys people by it and
by the organisation id, never by name or email.

**Synthesis is made in GSAM** (GRE-2611). GSAM reads the completed interviews (`GET rounds/{roundId}/interviews`),
makes and reviews the synthesis, and pushes the released one (`POST rounds/{roundId}/synthesis/released`). The
website's own pipeline (`POST rounds/{roundId}/synthesis`, then `…/release`) stays only as a fallback.

A **round** is one interview engagement. GSAM makes the round id (uuid) and keeps it. The website stores the round
under that id. One round per client engagement (the Deep Dive's first step).

## Writes (write key, POST)

### `POST rounds/{roundId}` — create or update a round

```json
{
  "schema": "gs-interview-round-v1",
  "clientName": "Example Ltd",
  "sponsor": "text or null",
  "mode": "team | person",
  "targetMinutes": 20,
  "status": "draft | open | closed",
  "voice": true,
  "seatTotal": 40,
  "costEnvelopePence": 50000,
  "endDate": "2026-11-13 or null",
  "retentionDeleteAfter": "2027-02-13 or null",
  "retentionDays": 90,
  "readoutAt": "ISO or null",
  "enrol": { "enabled": true, "expiresAt": "ISO or null", "allowedEmailDomains": ["example.com"],
             "defaultUnitId": "uuid or null", "rotateToken": false },
  "units": [ { "id": "uuid", "parentId": "uuid or null", "name": "Finance", "kind": "team", "seatAllocation": 8 } ],
  "contextPack": {
    "company_background": "", "org_summary": "", "systems": "", "scope": "", "glossary": "",
    "do_not_discuss": "", "working_pattern": "", "priority_questions": "",
    "units":  { "<unit id>": "questions and notes for this team" },
    "people": { "<employeeId from invites, or email before the invite>": "questions and notes for this person" }
  }
}
```

- `contextPack` keys are Everest's (`renderContextPack`). `units` is used in `team` mode, `people` in `person` mode.
  Each save makes a new approved context-pack version and points the round at it: a live interview keeps the version
  it started with only for its current turn; the next turn reads the new one.
- `voice: false` takes voice away from this round at once (typed only, the Indago fallback); `true` or absent offers
  it when the site has voice on. The site-wide `VOICE_ENABLED=0` still wins.
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

### `POST rounds/{roundId}/synthesis/released` — push the synthesis GSAM released

```json
{ "schema": "gs-interview-synthesis-v1", "synthesisId": "uuid made by GSAM",
  "headlineRead": { "text": "", "supporting_insight_ids": ["insight uuid"] },
  "themes": [ { "theme_id": "t1", "label": "", "summary": "",
                "evidence_quotes": [ { "insight_id": "insight uuid", "quote": "verbatim" } ] } ],
  "hotSpots": [ { "team": "", "local_themes": [ <theme> ] } ], "recommendations": [ { "rec_id": "r1",
  "evidence_quotes": [ … ] } ], "followUps": [], "methodology": {}, "modelVersion": "", "rulesVersion": "",
  "inputInsightIds": ["insight uuid"] }
```

- The inner objects keep the stored synthesis shape (snake_case), the same as `synthesis/latest` returns, so the
  client read-out renders it as it renders one made on the site.
- The website stores it as the next version and **re-verifies it against the stored interviews** before release:
  each quote must be verbatim in an eligible insight (`quoteEligible`); each theme needs two distinct voices
  (`voiceKey`) and one first-hand voice; each recommendation needs one verified quote. If any check fails, the answer
  is `400 bad_request` with the reasons and nothing is written or released.
- On success it is released at once: `200 { synthesisId, version, round }`. The same `synthesisId` again is `409`.
- Withdraw with `POST rounds/{roundId}/synthesis/withdraw`.

### `POST rounds/{roundId}/synthesis` — run synthesis on the site (fallback)

Starts the synthesis pipeline in the background (Opus; minutes). Answer `202 { started: true }`. Poll
`GET rounds/{roundId}/synthesis/latest`. A run already in progress answers `409 conflict`.

### `POST rounds/{roundId}/synthesis/{synthesisId}/release` — the release gate (fallback)

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
{ "item": { "id": "uuid", "clientName": "", "organisationId": "uuid", "mode": "team", "status": "open",
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

### `GET rounds/{roundId}/interviews` — the interviews that may enter synthesis

`{ items: [ { interviewId, employeeId, userId, voiceKey, unitId, unitName, roleTitle, leaderTrack, complete, partial,
phase, completionScore, startedAt, endedAt, insightCount, fingerprint } ], counts: { sessions, ended, eligible,
complete, partial }, log }`. Eligible means ended and at least `pain_mapping` reached; `complete` reached sign-off
with the read-back; `partial` insights are capped at 0.7 confidence. Test sessions never appear. `fingerprint`
changes when the interview changes, so GSAM can cache its per-interview summary.

### `GET rounds/{roundId}/interviews/{interviewId}` — one interview

`{ item: { interview: { … as above }, consent: { participation, attribution }, turns: [ { seq, role, content, ts,
inputMode } ], insights: [ { id, type, label, evidenceQuote, timePerWeekHours, confidence, secondHand,
attributionRedacted, quoteEligible } ] } }`. Confidence is already capped (partial, second-hand). Only an
`quoteEligible` insight may be quoted in a synthesis. `attributionRedacted: true` means GSAM must not name the
person with it. An interview that is not eligible answers `404`.

### `GET rounds/{roundId}/synthesis/latest`

`{ item: <synthesis or null> }`: the newest synthesis on the site, released or not.

### `GET rounds/{roundId}/synthesis/released`

`{ item: <synthesis or null> }`: exactly what the client sees.

## What the website does on its own

- Voice can be turned off (`VOICE_ENABLED=0`): the typed interview is complete on its own (the Indago fallback).
- The join page, account sign-up (Better Auth, email verified), enrolment checks (token, domain, seats), the
  interview, consent, sign-off read-back, memory opt-in and hard-delete opt-out.
- Abandonment close-out (scheduled, hourly). Retention delete (scheduled, daily, GRE-2653): on the deletion date,
  `readoutAt` (or the close, with no readout) plus `retentionDays` (optional, 0 to 3650, default 90), or
  `retentionDeleteAfter` if that comes first. The site first writes an anonymised themes copy, then hard-deletes the
  round's sessions, transcripts, insights, synthesis, invites and per-person memory; consent records and content-free
  usage stay. The round view returns `retentionDays`, `readoutAt`, `closedAt` and `deletionDate`. The outbox gets a
  `retention_deleted` event with counts for the engagement owner.
- The client sees only a released synthesis.
