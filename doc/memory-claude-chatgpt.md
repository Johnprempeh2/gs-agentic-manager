# Claude and ChatGPT in organization memory

Memory > Claude and ChatGPT (`/memory/apps`) brings what a person's Claude or
ChatGPT knows into organization memory.

## Import

Two ways in, both parsed in the browser by `packages/shared/src/memory-import.ts`:

- **Copy what it remembers.** The page gives a question to paste into Claude or
  ChatGPT. The answer is pasted back and split into one entry per line.
- **Upload past conversations.** The `conversations.json` file from a ChatGPT
  or Claude data export (Claude's `memories.json` also works). Each
  conversation becomes one entry, trimmed to its first 6,000 characters. The
  app is detected from the file's shape.

Only the entries the person ticks are sent, at most 50 per call, to
`POST /api/companies/:companyId/memory/import`. Each one goes through the
normal contribution path, so it:

- arrives `unreviewed` and waits in Review;
- passes the sensitive-content check (refused entries are counted as held back);
- carries `sourceKind` `claude_import` or `chatgpt_import`, a stable `sourceId`
  (`paste:<hash>` or `conversation:<id>`), and `evidence.importedFrom` and `via`.

A second import of the same line or conversation into the same scope is
skipped. No model is called by the import itself; the memory engine retains
each entry as it does any contribution. Agent working-note scopes are not
offered as a destination.
