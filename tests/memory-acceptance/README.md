# Organization memory acceptance tests

Phase 1 acceptance runner for the organization memory gateway (GRE-675). The
tests and the threat model behind them are in the GRE-651 document "Threat
model and acceptance-test dataset". Design: `doc/adr/0001-organization-memory-gateway-on-hindsight.md`.

**Synthetic data only.** Every record, identity and secret comes from the
Kestrel Works fixtures in `fixtures/`. Load them into sandbox instances only.

## Commands

Run the 11 phase 1 tests against the in-process test double:

```sh
pnpm test:memory-acceptance            # one line per test, exit 0 only if all pass
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
- `fixtures/scenarios.json` — scenario fixtures D1–D7 (GRE-651 §5.2); phase 1 uses D3 and D7
- `lib/tests.mjs` — the 11 tests
- `lib/double.mjs` — gateway and engine test double, with fault switches
- `lib/live.mjs` — generic HTTP target and the direct engine probes
- `lib/gsam.mjs` — the real GSAM gateway in a sandbox server, with a sandbox engine
- `run.mjs` — the command line runner
- `runner.test.mjs` — self-test for the runner
