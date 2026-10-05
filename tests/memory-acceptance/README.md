# Organization memory acceptance tests

Acceptance runner for the organization memory gateway: phase 1 (GRE-675),
the phase 2 exit tests (GRE-888, see "Phase 2" below) and the phase 3 graph
and contribution tests (GRE-866, see "Phase 3" below). The
tests and the threat model behind them are in the GRE-651 document "Threat
model and acceptance-test dataset". Design: `doc/adr/0001-organization-memory-gateway-on-hindsight.md`.

**Synthetic data only.** Every record, identity and secret comes from the
Kestrel Works fixtures in `fixtures/`. Load them into sandbox instances only.

## Commands

Run the phase 1 to 3 tests against the in-process test double:

```sh
pnpm test:memory-acceptance            # one line per test, exit 0 only if all pass
pnpm test:memory-acceptance -- --phase 2   # phase 2 only (1 | 2 | 3 | all)
pnpm test:memory-acceptance -- -v      # every check plus the audit rows used as evidence
pnpm test:memory-acceptance -- --json tmp/memory-acceptance.json
```

Prove the tests can fail (the double has one switch per control):

```sh
node tests/memory-acceptance/run.mjs --list-faults
node tests/memory-acceptance/run.mjs --break grant-check-allow   # MT-01..04 go red, exit 1
```

Check the runner itself (fixtures, green run, and every fault turning its tests red):

```sh
pnpm test:memory-acceptance:self
```

Run against a sandbox gateway and engine:

```sh
MEMORY_ACCEPTANCE_LIVE_CONFIG=tmp/memory-live.json \
  node tests/memory-acceptance/run.mjs --target live -v --json tmp/memory-acceptance-live.json
```

Never point the live target at the live app. The runner refuses port 3100.

### Against the real gateway (`--target gsam`)

`--target gsam` runs the 11 tests through the gateway that shipped in GRE-672
(`server/src/routes/memory.ts`), in a sandbox GSAM server, with a sandbox
engine. Each run provisions a fresh synthetic Kestrel Works company: scopes,
projects and agents through the board API, memory grants and heartbeat runs in
the sandbox database (no API exists for them yet). Audit evidence is the
gateway's `memory_operations` table. Fixture names map to UUIDs both ways, and
every UUID in a response is renamed to its fixture name, so a leaked id shows
up as a leaked name.

1. Sandbox engine: follow "Sandbox test" in `doc/GS-MEMORY-ENGINE.md` (own
   folder, ports 25432/28888, `link-gateway` into the scratch folder).
2. Sandbox GSAM in `local_trusted` mode with its own config (port, embedded
   database port, telemetry off) and
   `GSAM_MEMORY_GATEWAY_CONFIG=<scratch>/gsam/gs-memory/secrets/gateway.env`.
3. Optional egress evidence for MT-31:
   `node server/scripts/memory-egress-check.mjs sample --root-pid <hindsight-api pid> --out <scratch>/egress.jsonl`.
4. Run:

```sh
MEMORY_ACCEPTANCE_GSAM_CONFIG=<scratch>/gsam-target.json \
  node tests/memory-acceptance/run.mjs --target gsam -v --json <scratch>/memory-acceptance-gsam.json
```

```json
{
  "gatewayUrl": "http://127.0.0.1:<sandbox port>",
  "databaseUrl": "postgres://paperclip:paperclip@127.0.0.1:<sandbox db port>/paperclip",
  "retainMode": "chunks",
  "engine": { "host": "127.0.0.1", "restPort": 28888, "controlPlanePort": 9999, "postgresPort": 25432 },
  "engineAdmin": { "psql": "<pg bin>/psql", "socketDir": "<engine root>/pg/run", "port": 25432, "database": "hindsight", "env": { "LD_LIBRARY_PATH": "<pg lib dir>" } },
  "egressLogPath": "<scratch>/egress.jsonl"
}
```

The runner refuses gateway port 3100 and database port 54329 (the live app).
`engineAdmin` is the sandbox engine's superuser socket; it reads bank config
(MT-09) and every engine table (MT-07, MT-12). It is never the shared engine.

How fixture calls become gateway calls:

| Fixture | Gateway |
|---|---|
| `hu-john-syn` | the local board (no credential) |
| `ag-*` identities | sandbox agents with their own API keys |
| grant `read` / `contribute` on scopes | `memory:read` / `memory:contribute` with `memoryScopeIds` |
| grant `approve`, scoped `administer` | not mapped: phase 2, and `memory:admin` is company-wide (listed in the preflight line) |
| recall with `client` / `scope` | `scopeIds: [that scope]`, or an id that does not exist |
| recall with no scope | `scopeIds` = every scope the caller lists from `GET …/memory/scopes` |
| bare recall (`bare: true`, MT-01) | no `scopeIds`; the gateway then skips client and restricted-project scopes by design (GRE-869) |
| `X-Bank-Id` header | sent as is (the gateway ignores it) |

`--prime-org` adds one neutral synthetic org record before the tests so the
company bank exists. It is a diagnostic, not an acceptance run.

## Results

Each test ends as **pass**, **fail** or **inconclusive**. Inconclusive means
the target could not give the evidence the test needs (no egress log, no
admin inspection route, engine not confirmed running). It is never counted as
a pass, and the exit code is 1.

MT-07, MT-08 and MT-09 need the engine to be running. A refused connection
to an engine that is not running proves nothing, so they are inconclusive
unless the engine is confirmed up (gateway health route on `live`, the
engine's own `/health` plus a successful seed on `gsam`).

MT-01, MT-03 and MT-04 pass when the response holds no record, record id,
client name or code name from a scope the caller may not read (GRE-869).
Semantic recall also returns weak hits from the caller's own scopes; those are
allowed. Each test lists its forbidden strings explicitly in `lib/tests.mjs`.

Isolation only counts if the recall really searched. A recall the
gateway answers with "memory unavailable" fails MT-01, MT-03 and MT-04.

Gateway tests (MT-01 to MT-06, MT-12) also check the gateway audit rows. Direct
engine tests (MT-07 to MT-09) bypass the gateway, so their evidence is the
probe result and the admin read-back. MT-31 uses the egress log.

| Test | Threat | Fixture | What it checks |
|---|---|---|---|
| MT-01 | T1 cross-client | D3 | `ag-lintel-syn` recall returns `R-302` and nothing from a scope it may not read; a bare recall returns nothing from any client scope |
| MT-02 | T1 cross-client | D3 | body `cl-alder` denied, same as "not found"; `X-Bank-Id: cl-alder` answers 200 or a denial, never Alder data |
| MT-03 | T2 cross-project | D3 | `ag-mason-syn` gets nothing from `pj-kestrel-acq` or `cl-brook` (own `cl-alder` and org hits allowed) |
| MT-04 | T2 cross-project | D3 | org-wide read (`ag-everest-syn`) gets nothing from the sensitive project or any client |
| MT-05 | T3 forged identity | — | `actingAgentId: hu-john-syn` in the body is ignored or rejected |
| MT-06 | T3 forged identity | — | another agent's run id and an expired run are rejected |
| MT-07 | T4 engine bypass | — | engine REST recall and retain without the key are refused |
| MT-08 | T4 engine bypass | — | engine MCP by path and by `X-Bank-Id` is refused |
| MT-09 | T4, T13 | — | control plane, PostgreSQL and MCP bank-config change refused; config unchanged |
| MT-12 | T9 sensitive data | D7 | fake secrets blocked or redacted, absent from every engine store |
| MT-31 | T9 outbound | D1–D7 | only declared provider hosts in the egress log |

## Phase 2 (GRE-888)

Phase 2 exits only when every phase 1 and phase 2 test passes on `main`
(`--phase all`, the default). Test ids follow GRE-651 section 6; MT-33 is new.

| Issue item | Test | What it checks |
|---|---|---|
| 1 price conflict | MT-10 | Mason asks the Alder price: R-101 £180 approved leads, approver visible; R-102 £150 returned, not approved, names R-101 |
| 1 | MT-10b | Mason proposes £120 in `cl-alder` with no `topics`: refused with 400 naming topics; the text is in no gateway or engine table; R-101 still the approved answer; audit row shows the refusal (Everest's B-lite decision on GRE-888) |
| 1 | MT-11 | R-101 same version and text after R-102 and proposal R-601; R-102 history links R-101; one conflict-queue item for R-101 |
| 2 dated change | MT-32 | John supersedes R-201 (8h) with R-202 (4h): recall leads with R-202, R-201 `superseded`; recall `asOf: 2026-07-01` answers R-201; history links both; nothing left in the conflict queue |
| 3 different clients | MT-33 | Same question in cl-alder and cl-brook: each answers for its own client; R-304 is flagged against R-301 only, R-305 against nothing; no queue item mixes clients |
| 4 malicious text | MT-14, MT-15, MT-16, MT-17 | D4a–d: stored unreviewed, flagged (instruction-like / claims approval), recalled with the evidence note, no grant change, price stays £180, no directive |
| 5 self-approval, wrong role | MT-18, MT-26, MT-30 | Mason approves own R-601, John approves own R-918, Rogue approves R-602/R-926, steward approves R-102: all refused, audit rows denied |
| 6 interrupted audit | MT-19 | Steward pass killed after 18 entries, resumed, 2026-10-06 skipped and caught up: each entry once, no repeat escalation, price items grouped and routed to John, no cl-brook entry, duration and queue age reported |
| 7 deletion | MT-13 | John deletes R-801: its marker is gone from every engine table and every `memory_*` gateway table; tombstone row kept; Rogue's delete refused; backup expiry written down |

Seeding rule: nobody approves their own entry (GRE-886), John included. The
seed agent `ag-scribe-syn` writes the phase 1 records and the fixture
decisions; John approves them (or supersedes, for D2). Fixture records carry
the `entities` and `topics` a contributor would tag, because the gateway's
conflict check matches on those.

On `--target gsam` the phase 2 calls use the routes in `PHASE2_ROUTES`
(`lib/gsam.mjs`); override any with `routes` in the config file. A route that
answers "API route not found" makes its test inconclusive, never a pass.

| Runner call | Gateway |
|---|---|
| approve | `POST …/memory/records/:id/review` `{ action: "approve", reason }` |
| supersede | `POST …/memory/records/:id/supersede` `{ replacementRecordId, reason }` |
| delete | `POST …/memory/records/:id/delete` `{ reason }` |
| history | `GET …/records/:id/history` and `GET …/records/:id/relationships` |
| conflict queue | `GET …/memory/conflicts` (open groups) |
| steward grant | `POST …/memory/steward/grants` (needs `GSAM_MEMORY_STEWARD_SANDBOX_GRANTS=true` on the sandbox) |
| steward pass | `POST …/memory/steward/review` with `{ sandbox: { now, killAfterEntries } }` (asked of GRE-887; ignored today, so MT-19 is inconclusive) |
| steward queue, report | `GET …/memory/steward/queue`, `GET …/memory/steward/report` |
| steward evidence | `memory_steward_runs.entries_seen` summed against the records in the steward grant's scopes (no per-entry ledger) |

The sandbox server for phase 2 also needs `GSAM_MEMORY_STEWARD_SANDBOX_GRANTS=true`.

## Phase 3 (GRE-866)

Plan GRE-646 section 8: John can see memory connections and what each agent
contributes. Fixture D9 (`fixtures/graph.json`) has eleven records by Mason,
Scribe, Wren and Rogue across both clients, the Alder site project, the
restricted project and org. John approves or disputes them, and edits R-903
by superseding it with R-904. Four relationships are stated (one is in the
restricted project). R-911 is added after the reviews, so the conflict check
opens one possible conflict with the approved R-907. That is the inferred
edge. GRE-864 draws inferred edges only from open conflict-check rows; engine
entity links are not stored in GSAM, so they are never edges.
`ensureD9` seeds it once per run, then backdates records, review events and
relationships to 28 Sep to 4 Oct so that date ranges split them.

Two identities were added: `ag-wren-syn` (Brookfield contributor) and
`ag-quill-syn` (no memory grants: every view must be an empty 200).

| Plan point | Test | What it checks |
|---|---|---|
| 8.1.1 | MT-40 | Every explicit edge has a stored relationship or supersession row, every inferred edge an open conflict-check row; each stated relationship drawn once; no edge on the five "no edge" pairs (shared words across scopes, different clients) |
| 8.1.4 | MT-41 | Stated relationships are `explicit` with type, author and source; R-911 ~ R-907 is `inferred`, authored by a check, not a person; no label or meaning claims cause (sentences that deny cause are allowed) |
| 8.1.2, 8.1.5 | MT-42 | Agent, scope, status and text filters (alone and combined) return the right D9 records; the list has the same records as the graph; edges stay inside the filtered view |
| 8.1.3 | MT-43 | Node detail: text, source, status. Edge detail: meaning, type, author, source, for explicit and inferred edges |
| 8.2.1, 8.2.2 | MT-44 | Activity by agent and date: contributor, time, originating task or document, status; R-903 shows its supersession by the edit R-904; R-902 shows John's dispute |
| 8.2.3 | MT-45 | For John, Mason and Lintel, every agent and four date ranges (one is today), count = drill-down rows = fixture count of readable records; no score, rank or quality fields |
| 8.3.1 | MT-46 | Contributor stays the contributor after review; the reviewer is listed separately; the engine is never a reviewer; the contributor is never the approver |
| 8.3.2 | MT-47 | Every `memory_extracted_facts` row names a record and contributor, and node detail traces each fact to the contributing agent and the source |
| 8.3.3 | MT-48 | Activity item -> graph node (in the agent-filtered graph) -> source; source search -> memory; node -> contributor's activity |
| 8.3.4 | MT-49 | Only `unreviewed`, `approved`, `disputed`, `superseded`, and the same value per record in graph, list, activity and detail |
| 8.4.1, 8.4.2 | MT-50 | Mason, Lintel and Quill: no hidden ids, labels, entities or code names in graph or list; no dangling edges; a hidden-scope filter looks like an unknown scope; a hidden node or edge id answers like a missing one |
| 8.4.2 | MT-51 | The same callers: no hidden records in activity (overall and per agent); counts equal the readable fixture count |
| 8.4.3 | MT-52 | No-grant caller: every view an empty 200. John with a search or agent that matches nothing: empty 200 |

Hidden strings per restricted caller are in `graph.json` (`restricted`). The
self-test checks that none of them appear in a record that caller may read, so
a match in a response is a leak and not a fixture accident.

Every phase 3 control has a fault switch (`--list-faults`; `graph-*`,
`counts-*`, `activity-*`, `roles-merged`, and so on). The self-test pins each one
to the tests it turns red.

On `--target gsam`, the phase 3 reads use `PHASE3_ROUTES` in `lib/gsam.mjs`
(GRE-864: `/graph`, `/graph/nodes/:id`, `/graph/edges/:id`, `/activity`,
`/activity/counts`). The adapter maps the gateway's fields onto the runner's
shape and keeps the raw response under `raw`, so the leak checks scan
everything the gateway sent. There is no list route: the list view is built
from `/graph`, so on this target MT-42's list check holds by construction.
The UI list itself is covered by GRE-865's component tests. The gateway takes
`to` as exclusive, so the adapter adds a day to the fixture's inclusive end
date. Ground truth comes from the sandbox database: `memory_relationships`,
supersession links, open `memory_conflicts` and `memory_extracted_facts`. In
`chunks` retain mode the engine extracts nothing, so MT-47 is inconclusive.
Phase 3 never reads from the engine, so `--phase 3` can run without one: set
`"requireEngine": false` in the config (contributions then wait in the outbox).
Phases 1 and 2 still need the engine.

The screens get the same 8.3.3 check in a headless browser. After a phase 3
`gsam` run, on the same sandbox server:

```sh
MEMORY_UI_BASE=http://127.0.0.1:<sandbox port> \
  node tests/memory-acceptance/ui-clickpath.mjs --shots <scratch>/shots
```

It adds one synthetic task and one memory linked to it, then walks: activity
item -> "Show in graph" -> source link -> the task -> Back to the same node ->
contributor's activity -> search by the task id finds the memory.

## Live config

`MEMORY_ACCEPTANCE_LIVE_CONFIG` points at a JSON file (keep it out of git; it
holds sandbox tokens):

```json
{
  "gatewayUrl": "http://127.0.0.1:<sandbox port>",
  "companyId": "<sandbox company id>",
  "adminToken": "<sandbox admin token>",
  "seedIdentity": "hu-john-syn",
  "identities": {
    "ag-mason-syn": { "token": "..." },
    "ag-lintel-syn": { "token": "..." },
    "ag-everest-syn": { "token": "..." },
    "ag-rogue-syn": { "token": "..." },
    "hu-john-syn": { "token": "..." }
  },
  "runIds": { "run-mason-live": "<real run id>", "run-rogue-expired": "<finished run id>" },
  "bankIds": { "cl-alder": "<engine bank id>" },
  "engine": { "host": "127.0.0.1", "restPort": 18888, "controlPlanePort": 9999, "postgresPort": 15432 },
  "allowedEgressHosts": ["api.anthropic.com"],
  "egressLogPath": "<egress log from GRE-673, one host per line or JSON lines with a host field>",
  "routes": {}
}
```

`routes` overrides the gateway paths in `lib/live.mjs` (`health`, `recall`,
`contribute`, `audit`, `bankConfig`, `inspectRaw`). The defaults follow
ADR-0001 section 6 and will be matched to the gateway routes when GRE-672 lands.

## Files

- `fixtures/kestrel-works.json` — company, scopes, six identities and their grants (GRE-651 §5.1)
- `fixtures/scenarios.json` — scenario fixtures D1–D7 (GRE-651 §5.2) and D8 (GRE-888 probes)
- `fixtures/graph.json` — D9, the phase 3 graph and contribution fixture (GRE-866)
- `lib/tests.mjs` — the 11 phase 1 tests and `runAll`
- `lib/phase2.mjs` — the 14 phase 2 exit tests
- `lib/phase3.mjs` — the 13 phase 3 graph, contribution and permission tests
- `lib/double-graph.mjs` — the double's phase 3 views and their fault switches
- `lib/checks.mjs` — helpers both phases share
- `lib/double.mjs` — gateway and engine test double, with fault switches
- `lib/live.mjs` — generic HTTP target and the direct engine probes
- `lib/gsam.mjs` — the real GSAM gateway in a sandbox server, with a sandbox engine
- `run.mjs` — the command line runner
- `runner.test.mjs` — self-test for the runner
