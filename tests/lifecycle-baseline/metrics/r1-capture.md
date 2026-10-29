# Prospective R1 capture contract

Prepared 29 October 2026 for GRE-3270. This is code and documentation preparation. No Greatstone measurement source was opened, queried, copied or exported. The source gate on GRE-3269 remains closed until Everest records source-specific approval. This contract does not itself authorise a capture.

## Proposed source route and gate

The proposed route is a **full, time-stamped Greatstone database backup restored into a disposable, isolated PostgreSQL instance**. It is not yet approved. GRE-3269 must separately approve (1) making and moving the specific backup from the Greatstone instance and (2) reading the named restored copy. A fresh test database can check mechanics, but cannot supply a Greatstone R1 baseline. The CLI accepts only a loopback database URL; it must never point at the live instance. The proposed operator is Everest or a person Everest names after the gate, not this preparation run.

Before either approval, Everest records on GRE-3269 the backup identity and original consistent source capture timestamp, company ID, host and isolation boundary, the exact read-only database role, output destination, retention deadline and deletion owner. The source capture timestamp must come from the source database transaction that fixes the backup's consistent snapshot. A backup file's modification time, restore completion time, and a later SQL transaction time are not substitutes. If the backup process cannot provide that timestamp, this route cannot produce a defensible seven-day window and needs a new gate decision.

The approved operator records evidence that the restored instance has no agent process or scheduler, no outbound network path, no mounted live secret store or live worktrees, and no route to port 3100. Grant the capture role `SELECT` on only the tables below, with no write privileges. Connect over loopback. The restricted result file stays in the approved destination until the recorded retention deadline; the named deletion owner removes it then. Do not attach the backup, raw rows, credentials or result file to a task unless the source approval expressly permits it.

## Minimal table and column manifest

`R1_TABLE_COLUMNS` in [r1-snapshot.mjs](./r1-snapshot.mjs) is the machine-readable manifest. Every query is company-filtered. Joined `activity_log`/`issues` and `issue_approvals`/`approvals` check both company IDs. The collector projects only the fields used by `computeStrandedTrees` and does not select comments, descriptions, run output, error text, secrets or personal profiles.

| Table | Columns read | Why |
|---|---|---|
| `issues` | `id`, `company_id`, `identifier`, `parent_id`, `status`, `assignee_agent_id`, `assignee_user_id`, `conversation_user_id`, `conversation_state`, `monitor_next_check_at`, `monitor_wake_requested_at`, `hidden_at`, `updated_at`, `tabled_by_user_id` | Tree, owner, monitor and activity state |
| `activity_log` | `company_id`, `entity_type`, `entity_id`, `actor_type`, `action`, `details`, `created_at` | Human-parked backlog blockers |
| `heartbeat_runs` | `company_id`, `id`, `status`, `context_snapshot`, `native_issue_id`, `created_at`, `started_at`, `last_output_at`, `finished_at` | Live runs and historical tree activity |
| `agent_wakeup_requests` | `company_id`, `status`, `payload` | Queued, claimed and deferred wakes |
| `issue_thread_interactions` | `company_id`, `issue_id`, `status` | Pending interaction path |
| `issue_approvals`, `approvals` | `company_id`, `issue_id`, `approval_id`; `id`, `company_id`, `status` | Pending approval path |
| `issue_recovery_actions` | `company_id`, `source_issue_id`, `resolved_at`, `status`, `cause`, `evidence` | Recovery path and execution hold |
| `issue_tree_holds` | `company_id`, `root_issue_id`, `status` | Deliberate hold |
| `issue_relations` | `company_id`, `issue_id`, `related_issue_id`, `type` | Blocker coverage |
| `agents` | `company_id`, `id`, `status`, `runtime_config` | Timer heartbeat path |

The run query has **no time cutoff**. It reads every retained run associated with a current company issue, including runs older than seven days that can move a tree's last-activity time. The issue query reads all current company issues and the activity query reads the latest relevant backlog transition. The approved backup must be a full consistent database capture, not a seven-day export or a subset of tables. Before using its number, the operator checks the source's retention policy or source inventory for complete issue, activity and run history through the seven-day window and older relevant runs. If that cannot be established, report coverage unknown and do not call the result a baseline. The CLI cannot reconstruct rows already absent from the source.

## Read-only capture after approval

The command opens one `REPEATABLE READ READ ONLY` transaction. Its **first read** records `transaction_timestamp()` from the restored database as `readAt`; all row reads and R1 computation follow inside that transaction. For a restore, `--source-captured-at` supplies the original source snapshot time, which determines the seven-day window and 30-minute grace calculation. The output records both times so the distinction remains visible. Every input array and every required projected field in a nonempty row is checked. Cross-company rows, foreign issue references, absent tables and missing timestamps fail closed.

Run only after both approvals are recorded on GRE-3269. Use the approved source reference and original UTC timestamp, and a restricted output path under the approved destination. Keep credentials in the operator's shell environment, never in a task comment:

```sh
node tests/lifecycle-baseline/metrics/r1-capture.mjs --database-url "$R1_RESTORE_DATABASE_URL" --company "$R1_COMPANY_ID" --source-ref "$R1_APPROVED_SOURCE_REF" --source-captured-at "$R1_SOURCE_CAPTURED_AT" --out "$R1_APPROVED_OUTPUT_DIR/r1-result.json"
```

The file is created once with mode `0600`. Its `gsam.r1-result/v1` allowlist contains only source reference, company ID, original capture time, read time, seven-day window start and length, `weekly`, `total`, `treesWithOpenWork`, and the ID and identifier of each root counted in `weekly`. Raw projected rows and detailed tree results stay in process memory and are discarded when the command exits. The operator records the commit, command, source and isolation evidence, counts, counted roots and any coverage limits on the measurement task. A failed validation is a missing input, never `R1 = 0`.

If the 30 October 2026 00:00 UTC start is missed, register the next midnight UTC start on GRE-3269 before any capture. A restore measured later still uses its original source capture time, never the restore read time.

## Preparation checks

`node --test tests/lifecycle-baseline/metrics/r1-snapshot.test.mjs` uses only synthetic rows and a fake SQL reader. It checks missing arrays and columns, absent source tables, another company's rows and references, a deliberately stranded tree, the timestamp order and original-source-time handling, and the output allowlist. `pnpm test:metrics` runs the broader metric fixture suite. No baseline or CI budget can be set from this preparation task; those need an approved source measurement and observed variance.
