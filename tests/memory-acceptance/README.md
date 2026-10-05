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

## Results

Each test ends as **pass**, **fail** or **inconclusive**. Inconclusive means
the target could not give the evidence the test needs (no egress log, no
admin inspection route, engine not confirmed running). It is never counted as
a pass, and the exit code is 1.

MT-07, MT-08 and MT-09 need the engine to be running. A refused connection
to an engine that is not running proves nothing, so on the live target they
are inconclusive unless the gateway health route reports the engine as up.

Gateway tests (MT-01 to MT-06, MT-12) also check the gateway audit rows. Direct
engine tests (MT-07 to MT-09) bypass the gateway, so their evidence is the
probe result and the admin read-back. MT-31 uses the egress log.

| Test | Threat | Fixture | What it checks |
|---|---|---|---|
| MT-01 | T1 cross-client | D3 | `ag-lintel-syn` recall sees only `R-302`, nothing of `cl-alder` |
| MT-02 | T1 cross-client | D3 | explicit `cl-alder` (body and `X-Bank-Id`) denied, same as "not found" |
| MT-03 | T2 cross-project | D3 | `ag-mason-syn` finds nothing of `pj-kestrel-acq` |
| MT-04 | T2 cross-project | D3 | org-wide read (`ag-everest-syn`) does not include the sensitive project |
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
- `lib/live.mjs` — sandbox gateway and engine target
- `run.mjs` — the command line runner
- `runner.test.mjs` — self-test for the runner
