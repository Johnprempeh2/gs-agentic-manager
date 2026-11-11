---
name: deep-dive-interview-log
description: >
  Log a client interview from a Notion meeting transcript into that client's
  Deep Dive in GSAM, as a draft a person approves. Also propose register rows
  (risks, decisions, evidence) as drafts. Use only when someone asks you to log
  a named interview or propose a row. Never approve, publish or delete.
---

# Deep Dive interview log

You turn one Notion meeting transcript into a draft in one client's Deep Dive. A
person (John or Ben) approves or rejects every draft in GSAM, under Clients >
Deep Dive > the client's tile > Questions and answers. You never approve,
publish or delete anything, and the API refuses if you try.

## When to run

Only when a person asks, for example "log the interview with the finance lead
from yesterday's Notion meeting into the Northwind Deep Dive". Never sweep every
Notion recording on your own.

## Steps

1. **Find the Deep Dive.** One client can have more than one, so pick by client
   and date, and ask if two fit.

   ```sh
   curl -sS "$GSAM_API_URL/api/companies/$GSAM_COMPANY_ID/deep-dives" \
     -H "Authorization: Bearer $GSAM_API_KEY"
   ```

   Note its `id` (the `recordId`) and its `workstreams`.

2. **Read the transcript** in Notion (the `meeting-insights-notion` skill or the
   Notion tools). Read the whole transcript, not the AI summary.

3. **Find the questions that were asked.** Use the question list the person
   named (a document, the interview guide). If none was named, ask.

4. **Mark every question, in order:**
   - `answered`: give `answer` (short, in the speaker's terms) and `quote` (their
     exact words, two sentences at most). Both are required.
   - `unclear`: something was said but it did not answer the question. Give a
     short `answer` saying what was said, and a quote if it helps.
   - `not_answered`: skipped or never reached. No answer.
   - `at`: the time in the recording when you have it, for example `00:14:05`.
   - `workstream`: one of the Deep Dive's workstreams, exactly as listed. Leave it
     out if none fits; never invent one.
   - `pillars`: any of `data`, `technology`, `people`, `communication`, `process`,
     `governance`, `customer`, `competitor`, only when clear.

   Never guess an answer. If you are not sure, it is `unclear`.

5. **Talk outside the questions** goes in `outsideNotes` (`note`, optional
   `quote` and `at`).

6. **Save the draft.** Always send the run id header; the API records it with
   your agent id on every draft.

   ```sh
   curl -sS -X POST \
     "$GSAM_API_URL/api/companies/$GSAM_COMPANY_ID/deep-dive/drafts/interview-log?recordId=$RECORD_ID" \
     -H "Authorization: Bearer $GSAM_API_KEY" \
     -H "X-Paperclip-Run-Id: $GSAM_RUN_ID" \
     -H "Content-Type: application/json" \
     -d @interview.json
   ```

   `interview.json`:

   ```json
   {
     "interview": {
       "notionPage": "https://www.notion.so/...",
       "meetingTitle": "Finance lead interview",
       "heldOn": "2026-11-12",
       "interviewee": "Name, Finance lead",
       "questionSource": "Interview guide v3 (named by Ben)",
       "items": [
         { "question": "How is a month closed today?", "status": "answered",
           "answer": "Closed by hand in spreadsheets over five days.",
           "quote": "We close the month by hand, it takes about five days.",
           "at": "00:04:10", "workstream": "<a workstream listed on the Deep Dive>", "pillars": ["process", "data"] },
         { "question": "Who signs off the forecast?", "status": "not_answered" }
       ],
       "outsideNotes": [ { "note": "Mentioned a new ERP being trialled.", "at": "00:31:40" } ]
     }
   }
   ```

   To fix a draft before anyone decides it, send the same call with `draftId`
   and `expectedVersion` (the `version` you last read) beside `interview`.

7. **Report back** on your task: the draft id, the counts (answered, unclear,
   not answered, notes) and the GSAM link
   `/deep-dive/<recordId>/questions`. Say it waits for a person's approval.

## Proposing a register row

```sh
curl -sS -X POST \
  "$GSAM_API_URL/api/companies/$GSAM_COMPANY_ID/deep-dive/drafts/record-proposal?recordId=$RECORD_ID" \
  -H "Authorization: Bearer $GSAM_API_KEY" -H "X-Paperclip-Run-Id: $GSAM_RUN_ID" \
  -H "Content-Type: application/json" \
  -d '{"title":"Risk: source files arrive late","proposal":{"register":"Risks","values":{"Risk":"...","Likelihood":"High","Impact":"High","Owner":"..."},"workstream":"<a workstream listed on the Deep Dive>"}}'
```

## Reading drafts

- `GET .../deep-dive/drafts?recordId=...&status=draft` lists drafts.
- `GET .../deep-dive/drafts/<draftId>?recordId=...` reads one, with the reviewer's
  note once decided.

Claude sessions with the GSAM MCP have the same calls as tools:
`deep_dive_list`, `deep_dive_log_interview`, `deep_dive_propose_record`,
`deep_dive_list_drafts`, `deep_dive_get_draft`.

## Rules

- Client data stays in GSAM: never paste transcript text into task comments
  beyond the counts and the draft link.
- No contact details for the interviewee.
- British English. No em or en dashes in anything you write.
