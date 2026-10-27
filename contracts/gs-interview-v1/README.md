# gs-interview-v1: GSAM runs a Parallel Interview round on the website

GRE-2612 (website side), GRE-2611 (GSAM side). This is the canonical copy in `gs-agentic-manager`;
the website vendors it with `contracts/check.mjs --vendor`.

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

**People are website accounts** (Better Auth). A person's `userId` is the website user id (a uuid); GSAM keys people by
it and by the organisation id, never by name or email. GSAM stores only those ids and reads names and emails live
(`GET rounds/{roundId}/people`).

**Synthesis is made in GSAM** (GRE-2611). GSAM reads the completed interviews (`GET rounds/{roundId}/interviews`),
makes and reviews the synthesis, and pushes the released one (`POST rounds/{roundId}/synthesis/released`). The
website's own pipeline (`POST rounds/{roundId}/synthesis`, then `…/release`) stays only as a fallback.

A **round** is one interview engagement. GSAM makes the round id (uuid) and keeps it. The website stores the round
under that id. One round per client engagement (the Deep Dive's first step).

**The data processing agreement comes first** (GRE-2794, gate GRE-2656; John, 26 Oct). A company admin of the
organisation reads and accepts the interview data processing agreement in the client portal (`#portal/agreement`).
Until the organisation has accepted the **current** text (its `version` and `contentSha256`):
`POST rounds/{roundId}/invites` and `POST rounds/{roundId}/invites/send` (resend and remind) answer
`409 { error: { code: "agreement_required" } }` and write and email nothing; the round's `joinUrl` is `null`; the join
link refuses; nobody can take a seat. A round may still be created, updated and opened. A new agreement text is a new
version: invites stop again until an admin accepts it. Read the state with `GET agreement` (below).

## Writes (write key, POST)

### `POST rounds/{roundId}` — create or update a round

```json
{
  "schema": "gs-interview-round-v1",
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
    "people": { "<website userId>": "questions and notes for this person" }
  }
}
```

- There is no `clientName`: the client's name is the organisation's name on the website, read when the round is saved.
  A body with `clientName` (or `customerId`) is `400`.
- `contextPack` keys are Everest's (`renderContextPack`). `units` is used in `team` mode, `people` in `person` mode.
  `people` is keyed by the website `userId`. Until a person has an account, the lower-case email is accepted as the
  key; the user id wins when both are present.
  Each save makes a new approved context-pack version and points the round at it: a live interview keeps the version
  it started with only for its current turn; the next turn reads the new one.
- `voice: false` takes voice away from this round at once (typed only, the Indago fallback); `true` or absent offers
  it when the site has voice on. The site-wide `VOICE_ENABLED=0` still wins.
- `retentionDays` (0 to 3650, default 90) and `readoutAt` set the retention delete date (see "What the website owns").
  They come with GRE-2653 (website PR #134).
- Units are upserted by id. A unit that GSAM leaves out is kept if anyone is placed in it, otherwise removed.
- `status: open` needs an approved context pack, `seatTotal > 0` and at least one allowed domain. `draft` and
  `closed` refuse new interviews; `closed` also closes enrolment.
- Answer `200 { round }` (shape under "Reads"). The round's `joinUrl` carries the enrolment token. It is returned on
  every answer (`null` until the organisation has accepted the agreement); `rotateToken: true` makes a new token and the
  old link stops working.

### `POST rounds/{roundId}/invites` — invite people

```json
{ "people": [
    { "userId": "uuid", "roleTitle": "Analyst", "unitId": "uuid or null", "portalRole": "employee" },
    { "email": "a@example.com", "name": "A Person", "roleTitle": "Analyst", "unitId": "uuid or null",
      "portalRole": "employee | team_leader | client_admin" } ],
  "send": true }
```

- **`{ userId }`**: an existing website account. It must be a member of this organisation (a live `customer_users` row
  of the organisation whose `auth_subject` is the user id); otherwise the call is `400` and nothing is written. The site
  reads the name and email from the account.
- **`{ email, name }`**: someone with no website account yet. The site holds the invitation by email. The person makes
  the account (Better Auth, email verified) when they open the join link, and the invitation becomes theirs by user id.
  The site never makes a password-less account on someone's behalf. `userId` is `null` in the answer until then; read
  it later from `GET people`. Sending `{ userId }` for a person already invited by email links the invitation at once.
- A body item may not mix the two forms. Each person's place in the round is created (status `invited`) or updated,
  never duplicated. Emails must be on the round's allowed domains, except `client_admin`.
- `send: true` makes the website email each new invitee the round's join link (Resend, from the site). Nothing is
  emailed on a replay.
- Answer `200 { invited: [ { userId, organisationId, employeeId, outcome: "created | updated" } ], emailed }`, in the
  order sent. No name or email comes back: GSAM stores only the ids.
- At most 200 people per call.
- `409 agreement_required` until the organisation has accepted the current data processing agreement.

### `POST rounds/{roundId}/invites/send` — resend the link or send a reminder

```json
{ "kind": "resend | remind", "userIds": ["website user id"], "employeeIds": ["employee id from the invite answer"] }
```

- Names people already on the round. `userIds` for those with an account; `employeeIds` for an invitation held by
  email (its `userId` is still `null`). Give either list or both, at most 200 ids in all. An id not on the round is
  `400` and nothing is sent.
- `resend` emails the join link to those who have not started (status `invited`). `remind` emails a reminder to those
  who have not finished (`invited` or `started`). Others are skipped: nobody who completed or declined gets an email.
- The round must be open (`400` otherwise), and the organisation must have accepted the current data processing
  agreement (`409 agreement_required` otherwise).
- Answer `200 { emailed, skipped }`. Each call with a **new** idempotency key emails again, so a second reminder is
  sent; a replay of the same key and body emails nothing.

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
{ "item": { "id": "uuid", "organisationId": "uuid", "mode": "team", "status": "open",
  "targetMinutes": 20, "seatTotal": 40, "joinUrl": "https://…/#join/<token> or null", "enrol": { … },
  "agreement": { "version": "v2", "contentSha256": "hex", "accepted": true, "acceptedAt": "ISO or null" },
  "counts": { "invited": 0, "started": 0, "completed": 0, "declined": 0, "abandoned": 0 },
  "spendPence": 0, "costEnvelopePence": 50000, "contextPackVersion": 3,
  "retentionDays": 90, "readoutAt": "ISO or null", "closedAt": "ISO or null", "deletionDate": "ISO or null",
  "released": { "synthesisId": "uuid or null", "releasedAt": "ISO or null" } } }
```

### `GET rounds/{roundId}/people`

`{ items: [ { employeeId, userId, email, name, roleTitle, unitId, portalRole, status, sessionStartedAt, sessionEndedAt,
completionScore, phase } ] }`. Status and progress only: no interview content. `userId` is `null` for an invitation
not yet taken up. GSAM shows the name and email live and does not store them.

### `GET rounds/{roundId}/events?after=<cursor>&limit=<1..100>`

The engine's outbox (formerly sent to Notion), oldest first: `{ items: [ { cursor, event, createdAt, payload } ],
nextCursor }`. Events: `phase_complete` and `session_end` (with insights; `session_end` also has the transcript).
Insights carry `attribution_redacted`: when true, GSAM must not show the person's name with that insight. A person
who withdraws is hard-deleted and their events are removed.

### `GET rounds/{roundId}/withdrawals?after=<cursor>&limit=<1..500>` — hard deletes

`{ items: [ { cursor, userId, interviewId, at } ], nextCursor }`, oldest first. One item each time an interview
(`interviewId` set) or a whole person (`interviewId: null`) is hard-deleted from the round: a person who stops and
discards their interview, or a person removed by an erasure request. The rows are gone from the site, so GSAM must
remove that person's quotes (all of them when `interviewId` is null) from anything it has not yet released, and treat
a released synthesis that used them as needing a new release. Deleting the whole round (retention) writes none.

### `GET rounds/{roundId}/interviews` — the interviews that may enter synthesis

`{ items: [ { interviewId, employeeId, userId, voiceKey, unitId, unitName, roleTitle, leaderTrack, complete, partial,
phase, completionScore, startedAt, endedAt, insightCount, fingerprint } ], counts: { sessions, ended, eligible,
complete, partial }, log }`. Eligible means ended and at least `pain_mapping` reached; `complete` reached sign-off
with the read-back; `partial` insights are capped at 0.7 confidence. Test sessions never appear. `fingerprint`
changes when the interview changes, so GSAM can cache its per-interview summary. The list is always complete (no
`completedAfter` or cursor): a round has at most a few hundred interviews, and the fingerprint tells GSAM which ones
changed.

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

### `GET agreement` — the organisation's acceptance of the data processing agreement

Path: `/api/admin/v1/interview/organisations/{organisationId}/agreement` (not under a round). An organisation that is
not this tenant's answers `404`.

```json
{ "item": { "key": "interview-dpa", "version": "v2", "contentSha256": "hex", "accepted": true,
  "acceptance": <record or null>,
  "history": [ { "id": "uuid", "organisationId": "uuid", "agreementKey": "interview-dpa", "version": "v2",
    "contentSha256": "hex", "acceptedAt": "ISO (UTC)", "userId": "website user id", "name": "…", "email": "…",
    "roleTitle": "as typed", "legalName": "as typed", "companyCountry": "or null", "companyNumber": "or null",
    "registeredAddress": "or null", "readConfirmed": true, "authorityConfirmed": true, "ipAddress": "…",
    "current": true } ] } }
```

`acceptance` is the record for the current text; `history` is every acceptance, newest first. Records are kept and
cannot be edited.

### `GET agreement/acceptances/{acceptanceId}/copy` — the accepted agreement with its record

`{ item: { filename, contentType: "text/html; charset=utf-8", html } }`: one self-contained HTML file, the acceptance
record and then the agreement text exactly as accepted. The company admin downloads the same file in the portal.

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
