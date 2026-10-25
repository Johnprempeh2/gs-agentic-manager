# gs-interview-v1: the Parallel Interview between GSAM and the website (DRAFT)

GRE-2611 (GSAM side, Mason) and GRE-2612 (website engine port, Bedrock). **Draft for agreement: nothing here is
built on the website yet.** GSAM builds against a fake bridge with these shapes. When Bedrock agrees or changes
it, the agreed copy goes in both repos at this path, like `contracts/gs-bridge-v1`.

Every call is signed as in `contracts/gs-bridge-v1`. The public site never calls GSAM for this: GSAM pushes and
reads. Reads use the `read` key (GET only). Writes use the `write` key and sign gs-bridge-v2 with an idempotency
key, so a retry writes once. `tenantId` is GSAM's client id, the same tenant as the Deep Dive sync (GRE-2439).

## What lives where

- **GSAM** owns the round's setup and the approved question sets, the invite list, and what the results become
  in the Deep Dive. A person approves every set before it is sent, and confirms every result before it lands.
- **The website** owns the interviewee's account (made from a per-engagement invite link), the emails, the
  interview itself (Everest's engine), the transcript, consent and the synthesis with its release gate.

## Push the round: GSAM to the site

`PUT /api/admin/v1/interview/tenants/:tenantId/round` (write). Sent when a person opens the round; only approved
sets are in it. The whole round each time, so a set removed before sending is gone.

```json
{
  "schema": "gs-interview-v1",
  "roundId": "uuid",
  "mode": "per_team | per_person",
  "targetMinutes": 20,
  "contextPack": {
    "company_background": "", "org_summary": "", "systems": "", "scope": "",
    "priority_questions": "", "glossary": "", "do_not_discuss": "", "working_pattern": ""
  },
  "sets": [
    {
      "setId": "uuid",
      "target": { "kind": "unit | person", "id": "uuid", "name": "Finance", "detail": "Team" },
      "questions": [
        { "prompt": "...", "purpose": "validate | investigate", "streamKey": "operations", "gifKey": "business-impact" }
      ],
      "known": [{ "streamKey": "operations", "gifKey": "current-state", "text": "..." }]
    }
  ]
}
```

The context pack keys are Everest's `CONTEXT_FIELDS` (parallel-discovery-agent), so the engine reads them
unchanged. `known` is context for the interviewer: it says it, it never asks it. The site answers
`{ item: { roundId, receivedAt } }`; a round of another company's tenant is `not_found`.

## Invites: GSAM to the site

`POST /api/admin/v1/interview/tenants/:tenantId/invites` (write)

```json
{ "invites": [{ "inviteId": "uuid", "setId": "uuid", "name": "...", "email": "...", "role": "...", "unitName": "..." }] }
```

The site makes a website account invite link for this engagement and emails it. The same account is the
person's client portal login. It answers `{ items: [{ inviteId, status: "invited", invitedAt }] }`. The same
`inviteId` again changes nothing.

- `POST .../invites/:inviteId/resend` (write): send the same link again.
- `POST .../invites/:inviteId/remind` (write): send a reminder. The site may refuse more than one a day with
  `bad_request`.

## Progress: GSAM reads

`GET /api/admin/v1/interview/tenants/:tenantId/progress` (read), a list:

```json
{ "items": [{ "inviteId": "uuid", "setId": "uuid", "status": "invited | started | completed | abandoned | declined",
  "invitedAt": "", "startedAt": null, "completedAt": null, "lastRemindedAt": null }], "nextCursor": null }
```

`abandoned` is the site's call: started, then no answer for its timeout. GSAM shows the counts per team and per
person.

## Results: GSAM reads

`GET /api/admin/v1/interview/tenants/:tenantId/synthesis` (read): the **released** synthesis only (Everest's
release gate), else `not_found`.

```json
{ "item": {
  "synthesisId": "uuid", "releasedAt": "",
  "themes": [{ "themeId": "", "kind": "pain | process | idea | strength", "statement": "", "streamKey": null,
               "gifKey": null, "voiceCount": 3, "setIds": ["uuid"] }],
  "people": [{ "inviteId": "uuid", "name": "", "role": "", "unitName": "", "reportsToInviteId": null }],
  "quotes": [{ "quoteId": "", "inviteId": "uuid", "themeId": "", "text": "", "attribution": false }]
} }
```

- **Two voices.** `voiceCount` is how many different people raised the theme. GSAM never proposes a pain from
  one voice as a finding.
- **Consent.** Only quotes from people who gave participation consent are sent. `attribution: false` means GSAM
  keeps the quote as qualitative evidence without the person's name.
- Nothing in the results is Shared to the client by default: in GSAM every result lands Internal, as a proposal a
  person confirms.

## Open questions for Bedrock

1. Does the engine take `known` and the per-set `questions` as they are, or as part of `contextPack.units`?
2. Is `abandoned` a status the site sets, or does GSAM work it out from `startedAt`?
3. Can the synthesis carry `streamKey` and `gifKey` per theme, or does GSAM place themes itself?
