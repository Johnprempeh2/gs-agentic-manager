# Greatstone R1 source capture route

Prepared 29 October 2026 for GRE-3271. **Proposal only.** The GRE-3269 source gate remains closed. No live source was opened, queried, copied or exported for this preparation. This route makes one direct, read-only, `REPEATABLE READ` transaction on the live default embedded PostgreSQL source, operated by John. It makes no backup or restore. Only the R1 result allowlist leaves the database process. Everest must present the specific source and action to John and record approval on GRE-3269 before execution.

## Source identity and decision

The target is the **default GS Agentic Manager instance embedded PostgreSQL database**, not a workspace, preview, sandbox or other company source. Database name is `paperclip`. John must verify its actual host-local port and absolute data directory against the running default instance and record those in the contract. The identity comprises `instanceId`, data directory, loopback port, database, restricted role and approved `sourceRef`. The program checks connection host, port, database and role. John checks the directory against the running instance and records evidence on GRE-3269. Port or branch name alone does not prove identity. Do not guess the live directory or port.

Everest's source-specific decision request must name the exact contract revision and source reference; state that John will run one read-only snapshot; permit only the result fields below to move to the approved local destination; and name the retention deadline and deletion owner. It must say that no full backup, raw row export, network upload or agent read is authorised. If source identity or coverage is unknown, the action is not ready for approval.

## Required private operator contract

Create a private JSON file outside the repository. Replace every placeholder with actual source evidence. The port below is illustrative. The file has no password or raw rows. The CLI refuses a missing field, a different company/source, expired retention, non-loopback connection or output outside the approved directory.

```json
{
  "schema": "gsam.r1-source-contract/v1",
  "route": "direct-live-read-only",
  "companyId": "34dad57e-b5ad-4a72-9400-9eba645c99f6",
  "sourceRef": "<approved GRE-3269 source reference>",
  "instanceId": "default",
  "dataDirectory": "<absolute source directory John verified>",
  "port": 5432,
  "database": "paperclip",
  "role": "<dedicated SELECT-only login>",
  "operator": "John",
  "approvalRef": "<GRE-3269 decision reference>",
  "destination": "<absolute private local result directory>",
  "retentionUntil": "<approved UTC deletion deadline>",
  "deletionOwner": "<named person>",
  "coverage": {
    "kind": "source-inventory",
    "checkedAt": "<UTC inventory time>",
    "checkedBy": "John",
    "method": "<source inventory and retention check method>",
    "allCurrentCompanyIssues": "<evidence reference>",
    "fullSevenDayActivity": "<evidence reference>",
    "olderRelevantRuns": "<evidence reference: no run time cutoff>",
    "runRetentionPolicy": "<evidence reference>",
    "activityRetentionPolicy": "<evidence reference>",
    "complete": true
  }
}
```

The coverage references must cite real source checks and policy. If a required row may have been deleted, seven-day coverage cannot be established, or older relevant runs cannot be established, set `complete` to `false` and stop. The validator checks presence and the explicit completeness decision; it cannot prove a human evidence claim is true. Everest reviews the references before asking John to execute.

## Separate John-operated source preflight

This is a **proposed read-only source inventory**, not permission to run the R1 capture. Everest first seeks John's separate approval on GRE-3269 to inspect only metadata and aggregate counts on the live default source. Agents must not run these steps or receive credentials, raw rows, process output or a database copy. John records the following facts as short evidence references on GRE-3269; the contract stays private on his machine. No R1 result is produced in this preflight.

1. John identifies the running **default** instance using its own configuration and process record. He records the absolute PostgreSQL data directory, local listening port, database name and a source reference that distinguishes this instance from a sandbox. He cross-checks the directory and port against the running process, not a worktree path or a presumed default port. If either cannot be proved, stop.
2. John identifies an existing restricted login, if there is one. He checks `current_user`, `current_database()`, `inet_server_port()`, `transaction_read_only`, role attributes and table grants against the role requirements below. He records the role name and a grant-check reference, never the password. If no suitable login exists, stop the preflight and request **separate approval to create or alter a SELECT-only role on the live database**. That write is not part of read-only inventory approval.
3. After Keystone and Flint approve the exact SQL revision and John approves **inventory only**, John verifies that the reviewed commit and the [preflight wrapper](./r1-source-preflight.sh) are present in his local execution worktree. The reviewed path is `/Users/johnprempeh/Desktop/Code/gs-clip/.gsam/worktrees/GRE-1781-reviewer-wake-text-does-not-say-how-to-record-a-review-decision-agent-reviewers-strand-stages-with-comment-only/tests/lifecycle-baseline/metrics/r1-source-preflight.sh`. He checks the worktree commit with `git -C /Users/johnprempeh/Desktop/Code/gs-clip/.gsam/worktrees/GRE-1781-reviewer-wake-text-does-not-say-how-to-record-a-review-decision-agent-reviewers-strand-stages-with-comment-only rev-parse HEAD` against the approved PR head. A different revision needs fresh source-inventory approval. No dev checkout or presumed path is an acceptable substitute.
4. John runs one copyable command: `bash /Users/johnprempeh/Desktop/Code/gs-clip/.gsam/worktrees/GRE-1781-reviewer-wake-text-does-not-say-how-to-record-a-review-decision-agent-reviewers-strand-stages-with-comment-only/tests/lifecycle-baseline/metrics/r1-source-preflight.sh`. It prompts for the verified port and role from steps 1 and 2, then the role password through `psql`. He does not put the password in the command, comments or files. The SQL aborts before inventory if any manifest field is missing or unreadable, if the role lacks a stored read-only default, or if it has effective write privileges on any user table, sequence, schema, database, or executable security definer function. He records the transaction timestamp and aggregate counts only: all current company issues; Greatstone activity across the preceding seven days; and **all retained** runs linked to current Greatstone issues, including the older-run count and oldest timestamp. The run inventory has no lower time filter. The aggregate query is an inventory aid, not proof that deleted rows still exist.
5. John checks the live run and activity retention settings and any purge history against that timestamp. A count or oldest date alone cannot prove completeness. He records the policy and purge evidence separately for `runRetentionPolicy` and `activityRetentionPolicy`, and records whether the full seven-day activity interval and older relevant runs are demonstrably intact. If retention or purge history cannot establish coverage, set `coverage.complete` to `false` and stop. No zero result may be inferred.
6. John chooses an absolute **private local** destination for the permitted JSON result, names its deletion owner and exact UTC deadline, and records whether only he can read it. He records these as proposed transfer and retention terms, not as permission to capture. The contract and result must be deleted by that owner at the deadline, with completion recorded on GRE-3269.
7. John gives Everest only the source reference, directory, port, database, role name, aggregate coverage references, proposed destination, deletion deadline and owner. Everest reviews those facts, resolves any missing proof, then presents a **separate source-specific R1 capture decision** to John. Until that decision is approved, the collector must not be run.

The preflight must not install an agent, enable outbound access, copy the database, produce raw rows, or create a restore. A read-only source role may still see other companies at the database permission level; the capture SQL and result validator filter to Greatstone, and the operator does not transfer any raw query output. If a stronger database-level company boundary is required, this direct route needs a new design and approval.

John must make or identify a dedicated login with `CONNECT` to `paperclip`, schema `USAGE`, and `SELECT` only on the tables below. It must not be superuser, create roles/databases, replicate, bypass RLS or have effective write privileges anywhere in the user database, including through roles, sequences, schema/database creation, or executable security definer functions. Store `default_transaction_read_only=on` on that role for this database or globally. Creating or changing this role needs separate, explicit approval for a live write before preflight can continue; inventory approval does not include role creation. The collector also starts a read-only transaction and checks role, grants and isolation from inside it. The first SQL read is `transaction_timestamp()`; it is the source transaction timestamp that fixes the seven-day window. If a midnight-bound measurement is required, John must start then, or Everest must register a revised window on GRE-3269. A later restore time is irrelevant to this direct route.

## Minimal source manifest

`R1_TABLE_COLUMNS` in [r1-snapshot.mjs](./r1-snapshot.mjs) is the machine-readable field manifest. Every query is company-filtered. Joined `activity_log`/`issues` and `issue_approvals`/`approvals` check both company IDs. No comments, descriptions, run output, error text, secrets or personal profiles are selected.

| Table | Columns read | Reason |
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

The run query has **no time cutoff**. It reads every retained run linked to a current Greatstone issue, including runs older than seven days that can move a tree's last activity time. The issue query reads all current company issues. The activity query reads the latest relevant backlog transition. The source inventory must establish the full seven-day interval and older relevant runs. A missing table or selected column fails at SQL read; a missing projected field, foreign-company row or foreign issue reference fails validation. Missing coverage fails before connecting. Failure is never `R1 = 0`.

## Operator sequence after source-specific approval

1. John verifies source directory and port, restricted role, coverage, private destination and retention. He records evidence references in the contract and on GRE-3269. He checks the reviewed worktree commit with `git -C /Users/johnprempeh/Desktop/Code/gs-clip/.gsam/worktrees/GRE-1781-reviewer-wake-text-does-not-say-how-to-record-a-review-decision-agent-reviewers-strand-stages-with-comment-only rev-parse HEAD` against the capture revision approved on GRE-3269. A different revision requires a fresh capture decision. He does not share the database password or raw rows with agents.
2. John runs this locally, with `R1_SOURCE_DATABASE_URL` held only in his shell environment and pointing to the approved loopback source:

   ```sh
   node /Users/johnprempeh/Desktop/Code/gs-clip/.gsam/worktrees/GRE-1781-reviewer-wake-text-does-not-say-how-to-record-a-review-decision-agent-reviewers-strand-stages-with-comment-only/tests/lifecycle-baseline/metrics/r1-capture.mjs --company 34dad57e-b5ad-4a72-9400-9eba645c99f6 --source-ref "$R1_APPROVED_SOURCE_REF" --contract "$R1_APPROVED_CONTRACT" --out "$R1_APPROVED_OUTPUT_DIR/r1-result.json"
   ```

3. The collector creates one `0600` JSON result containing only `schema`, `sourceRef`, `companyId`, source transaction `sourceCapturedAt` and `readAt`, `windowStart`, `windowDays`, `weekly`, `total`, `treesWithOpenWork`, and `rootIssueId`/`rootIdentifier` pairs counted in `weekly`. Projected rows stay in process memory. John may transfer only those result fields to Everest through the approved local route. Do not upload or attach the result unless the decision expressly permits that transfer.
4. The named deletion owner deletes the private contract and result by `retentionUntil` and records completion on GRE-3269. No backup or restore exists in this route.

The operator process is not an agent run. It uses no GSAM agent key and makes no outbound request. The live app may continue running; the capture transaction is read only. If identity, role, coverage, destination or retention fails, stop and return the failure to Everest. Do not fall back to a full-instance backup.

## Synthetic verification

`node --test tests/lifecycle-baseline/metrics/r1-snapshot.test.mjs tests/lifecycle-baseline/metrics/r1-source-contract.test.mjs` uses synthetic rows and fake SQL readers only. It covers missing arrays and columns, foreign-company references, timestamp ordering, result allowlist, absent source tables, missing identity and coverage proof, wrong role, write grants and writable transactions. This preparation gives no Greatstone baseline or CI budget. Those require an approved real measurement and variance samples.
