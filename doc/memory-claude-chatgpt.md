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
  app is detected from the file's shape. Several files can be picked at once
  (an export split into parts); their entries are merged.

ChatGPT exports also hold hidden system turns and tool output (browsing,
code results, images). Only visible text, multimodal text and code turns are
kept.

Before anything is sent, the page asks
`POST /api/companies/:companyId/memory/import/check` (read-only, up to 500
entries per call) which candidates are already in the chosen scope. Each one
comes back as `already_imported` (same `sourceId`), `similar` (word overlap of
0.7 or more with an existing entry, see `memoryTextSimilarity`) or no match.
Matches start unticked with a note saying why. The check compares against the
newest 2,000 entries in the scope and yields between batches so a large paste
cannot stall the server.

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

## Review, clients and search

- **Quick review** (`/memory/review`). Each waiting entry is compared with
  approved entries in the same scope and with earlier waiting ones. A close
  match is tagged "Looks like one in memory" and offered first as the merge
  target. Rows can be ticked and confirmed or rejected in one go; entries the
  person may not act on (their own proposals) are skipped and listed.
- **Clients** (`/memory/clients`). Lists client scopes, with an Add client form
  for owners and admins. Each client page shows what GSAM remembers about that
  client, confirmed apart from waiting, with links to import into or review
  that client's memory (`?scope=<id>` on Claude and ChatGPT and on Review).
- **Search.** Typing in the Memory search box shows a plain list by default,
  with matching words highlighted and the matching text shown under each
  title. The graph is still one click away.

## Live connection

The same page has "Use memory from inside Claude". An owner or admin, signed
in as a person, picks an app and presses Connect. The server
(`server/src/routes/memory-connections.ts`):

- creates one paused link agent per person and app (`metadata.memoryConnection`),
  or reuses the existing one. It never runs tasks;
- mints a `memory_only` key for it (GRE-958), so the key reaches only the
  memory routes and `POST /api/mcp/memory-tools`;
- when "Let it suggest new entries" is ticked, gives the agent the
  `memory:contribute` right through the grants service;
- logs `memory.connection_created` and, on Disconnect, revokes every live key
  and logs `memory.connection_revoked`.

The key is shown once inside ready-to-paste setup text for the Claude desktop
app (`mcp-remote` in `claude_desktop_config.json`), Claude Code
(`claude mcp add --transport http`), Codex (`~/.codex/config.toml` with
`bearer_token_env_var`) or any other MCP app. The key always travels in the
`Authorization` header, never the URL.

ChatGPT cannot connect live yet: its connectors need an OAuth sign-in, which
GSAM does not offer. The page says so and points to the import instead.
