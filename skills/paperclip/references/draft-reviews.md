# Draft reviews

Use `request_draft_review` (MCP tool of the same name) when you have drafted something a person will send or approve: an email, a message to a client, a LinkedIn post, a document section. The person edits the text right in the card, then sends their edits, approves it as is, or asks for a redraft with a note.

```json
POST /api/issues/{issueId}/interactions
{
  "kind": "request_draft_review",
  "idempotencyKey": "draft:{issueId}:indago-email:v1",
  "title": "Draft email to Indago",
  "payload": {
    "version": 1,
    "purpose": "Email to Indago",
    "body": "Hi Martyn,\n\nThanks for the call...",
    "subject": "Next steps",
    "recipients": ["martyn@example.com"],
    "channel": "email"
  }
}
```

- Always human-only: you cannot resolve your own draft. `continuationPolicy` defaults to `wake_assignee`.
- Accepted (`outcome: "accepted"`): `result.draft` holds `originalBody`, `finalBody`, `edited`, `changeCount`, a word-level `diff` and `editSummary`. Use `finalBody` exactly as written for the next step (send it, file it). Never send your original if the person edited it.
- Rejected: `result.reason` is the redraft note. Post a new draft card; do not send the old one.
- Your wake message carries the final text, a list of what changed and any note. When `learnFromEdits` is true and you have `memory_contribute`, save one short factual note to `my_notes` about what this person changes (tone, length, greeting, formatting), and recall it before drafting for them again.
- A user comment does not expire a pending draft (`supersedeOnUserComment` defaults to `false`).
