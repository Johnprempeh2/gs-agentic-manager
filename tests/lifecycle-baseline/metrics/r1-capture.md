# Prospective R1 snapshot capture contract

Prepared 29 October 2026 for GRE-3270. This is an R1-only capture path for a **new isolated local or test database**. No measurement data was read or exported while preparing it. GRE-3269 must record approval for the **specific source** before an operator runs the capture. A generic approval, a prior live measurement, or the existence of this script is insufficient.

## Scope and manifest

The capture uses the current `computeStrandedTrees` definition in `compute.mjs`: all issues in one company, their live paths, parent and blocker edges, agent timer state, and historical run times that determine when each tree stopped. `R1_TABLE_COLUMNS` in `r1-snapshot.mjs` is the machine-readable table/column manifest. Its only sources are:

| Table | Columns read | Purpose |
|---|---|---|
| `issues` | `id`, `company_id`, `identifier`, `parent_id`, `status`, `assignee_agent_id`, `assignee_user_id`, `conversation_user_id`, `conversation_state`, `monitor_next_check_at`, `monitor_wake_requested_at`, `hidden_at`, `updated_at`, `tabled_by_user_id` | Tree, owner, monitor and activity state |
| `activity_log` | `company_id`, `entity_type`, `entity_id`, `actor_type`, `action`, `details`, `created_at` | Whether a person parked a backlog blocker |
| `heartbeat_runs` | `company_id`, `id`, `status`, `context_snapshot`, `native_issue_id`, `created_at`, `started_at`, `last_output_at`, `finished_at` | Live runs and tree last activity |
| `agent_wakeup_requests` | `company_id`, `status`, `payload` | Queued, claimed and deferred wakes |
| `issue_thread_interactions` | `company_id`, `issue_id`, `status` | Pending interaction path |
| `issue_approvals`, `approvals` | `company_id`, `issue_id`, `approval_id`; `id`, `company_id`, `status` | Pending approval path |
| `issue_recovery_actions` | `company_id`, `source_issue_id`, `resolved_at`, `status`, `cause`, `evidence` | Recovery path and execution hold |
| `issue_tree_holds` | `company_id`, `root_issue_id`, `status` | Deliberate hold |
| `issue_relations` | `company_id`, `issue_id`, `related_issue_id`, `type` | Blocker coverage |
| `agents` | `company_id`, `id`, `status`, `runtime_config` | Timer heartbeat path |

The query projects only R1 fields from JSON columns: issue IDs from run context and wake payload, recovery replay state, backlog status, and heartbeat enabled. It does not select comment bodies, issue descriptions, run output, error text, secrets or personal profile fields. UUIDs, issue identifiers and timestamps remain potentially sensitive; keep the file access restricted and do not attach it to an issue without source-specific approval.

Each row query filters on the required company ID. Joined tables also check both sides' company IDs. The validator rejects absent arrays, a missing database timestamp, issues from another company, and live-path references to issues outside the captured company. The script uses one `REPEATABLE READ READ ONLY` transaction, takes `transaction_timestamp()` before the row reads and passes that timestamp as `now` to the R1 calculator. Thus the seven-day window and grace period are tied to the database snapshot, not the operator's wall clock. The snapshot file stores the rows and result together under `gsam.r1-snapshot/v1` for reproducibility.

## Operator runbook after GRE-3269 source approval

1. On GRE-3269, record the exact isolated test source, company ID, capture date, retention destination and permission to read/export it. Verify that approval before connecting. Do not use the live `~/GSAM/data` database, a backup of it, or the live server on port 3100. The capture accepts loopback PostgreSQL only.
2. Set a local loopback database URL in the shell without putting credentials in a command, report or issue comment. Set the approved company ID. From this worktree, run:

   ```sh
   node tests/lifecycle-baseline/metrics/r1-capture.mjs --database-url "$R1_TEST_DATABASE_URL" --company "$R1_COMPANY_ID" --out "$GSAM_RUN_SCRATCH_DIR/r1-snapshot.json"
   ```

3. Record `snapshotAt`, company ID, commit, `weekly`, `total`, `treesWithOpenWork`, and the approved source reference in the measurement task. Keep the raw snapshot in the approved restricted location only; do not paste row data into comments. Capture the source version or backup identity needed to regenerate the same state. A later snapshot at a different time is a new measurement.
4. If validation fails, record the error as missing or inconsistent input, not `R1 = 0`. Do not broaden source access or silently discard rows. Send a source discrepancy to Everest for a decision.

## Preparation checks

Run `node --test tests/lifecycle-baseline/metrics/r1-snapshot.test.mjs`. It uses synthetic rows and a fake SQL reader; it never opens a database. Fixtures prove missing input and timestamp failure, company isolation, a deliberately stranded tree, company predicates and timestamp ordering. The existing R1 calculator fixtures remain in `compute.test.mjs`. This task prepares no baseline or CI budget: both require an approved source and a real capture.
