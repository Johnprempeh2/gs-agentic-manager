# Tracked numbers R1, R2 and S1

These three numbers come from what a GS Agentic Manager instance already records:
issues, heartbeat runs, wake requests and the activity log. `compute.mjs` holds
the definitions as pure functions. `collect.mjs` reads a database and saves a
report.

```sh
pnpm metrics:collect                       # local embedded instance, last 7 days
pnpm metrics:collect --company <id> --window-days 7 --database-url postgres://…@127.0.0.1:…/…
pnpm test:metrics                          # fixture tests for the definitions
```

The collector runs in a read-only transaction and accepts only loopback hosts.
It writes `.lifecycle-baseline/metrics/<stamp>/metrics.{json,md}`, plus
`.lifecycle-baseline/metrics/latest.json`, which the weekly budget check reads
(`pnpm metrics:budgets --group weekly`). Reports hold identifiers and
timings only, never titles, comment bodies or run output.

## Definitions

**R1 — stranded task trees per week.** A tree is a root issue plus all its
descendants. An open issue is `todo`, `in_progress`, `in_review` or `blocked`.
`backlog` counts as parked on purpose, not open. Coverage is decided per open
issue, not per tree, so a live branch cannot hide a dead sibling. An open issue
is covered when any of these holds:

- it has a live path of its own:
  - a queued or retry-scheduled run, or a running run with output in the last
    4 hours (`staleRunHours`, the server's
    `ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS`); a silent `running` run is hung.
    Under an execution hold (below) a queued or retry-scheduled run is not a
    path: dispatch cancels it as stale;
  - a queued or claimed wake;
  - a deferred wake (`deferred_issue_execution`), only while the issue also has
    a live run from the line above and no execution hold. A deferred wake moves
    only when the run holding the issue lock releases and the drain promotes
    it. A dead holder's lock is swept without a drain, and under a hold release
    skips the drain, so otherwise nothing will move it (GRE-23 D1, D2);
  - a pending interaction or a pending approval;
  - an unresolved recovery action with `status = 'active'` (an `escalated`
    action waits on the board with no owner and no wake, so it is not a path);
  - a monitor whose next check is in the future or overdue by less than the
    grace period (the server's `hasScheduledIssueMonitorPath` uses "in the
    future");
  - an assignee agent with a timer heartbeat that can be invoked;
- it is assigned to a human (humans act without being woken);
- an active tree hold sits on it or an ancestor (a human deliberately stopped it);
- an open child is covered (the parent waits on its children); or
- an open blocker is covered (followed through chains).

An **execution hold** is a recovery action whose `cause` is one of the shared
`EXECUTION_RECONCILIATION_CAUSES` (copied into `EXECUTION_HOLD_CAUSES`) and
that is `active`, `escalated`, or resolved with
`evidence.automaticRecovery.replay = 'blocked'`.

Runs are matched to issues on `context_snapshot.issueId`, `taskId` or
`native_issue_id`; wakes on `payload.issueId`, `taskId` or
`_paperclipWakeContext.issueId`/`taskId`. A tree is stranded when at least one
open issue is uncovered and nothing in the tree has changed for 30 minutes (the
grace period). A monitor re-claim bumps `issues.updated_at` every 5 minutes
without doing anything, so when that claim is an issue's last write, its
activity time is the moment the monitor fell due.

An agent assignee alone is **not** a live path: agents act only when woken. The
weekly number counts stranded trees whose last activity falls in the window,
i.e. trees that stopped this week. The report also lists every stranded tree
of any age, with the uncovered issues in it.

**R2 — run failure rate and unattended recovery.** Among runs that finished in
the window, failure rate is `failed + timed_out + interrupted` divided by those
plus `succeeded`. Cancelled runs are reported but excluded, because
cancellation is usually a human decision or a supersession. A failed run
counts as recovered without a human when a later run on the same issue
succeeds, or the issue reaches `done`, and no human acted on that issue in
between. Reading, starring and trace inspection do not count as acting. The
unattended share is auto-recovered failures divided by failures that have an
issue. Failures with no issue are counted separately.

**S1 — wake to first useful agent action.** The start point is the wake
request's `requested_at`, or the run's `created_at` if the run has no wake
request. The end point is the first agent activity row for that run that is
not harness bookkeeping: `environment.*` leases, checkout, read markers,
release and `tool_gateway.*` audit rows don't count. The one exception is a
gateway approval or elicitation request, which the user sees. Gateway tool
calls don't count because the audit row can't tell a read from a write.
Only finished runs are counted. Runs with no useful action are counted but not
timed. Median and p95 use nearest rank.

To show where the time goes, the report also gives the wake-to-start queue
delay and splits each timed run at the moment the prompt was sent (the run's
`prepare_turn` phase event): **setup** is wake → prompt sent (queue,
workspace, adapter start, prompt build); **agent** is prompt sent → first
useful action (model time and the agent's own tool calls). Runs without a
`prepare_turn` event are left out of the split only.

## Known limits

- "Useful action" means the first *visible* write, such as a comment, status
  change, document or new issue. A run that thinks for eight minutes before its
  first comment scores eight minutes, even if it was working. That is
  intended: it is what the user waits for.
- R1 is a snapshot. A tree that stranded and was rescued within the same week
  is not counted. The weekly routine takes a snapshot every week, so trees
  that stay stranded show up.
- Small instances give small samples. Every report states its sample size;
  budgets require a minimum sample (see `tests/metrics-budgets`).
- The execution hold skips one server carve-out: a
  `legacy_execution_requires_reconciliation` action on a legacy conversation
  run is not a hold on the server (`conversationRecoveryActionPredicate`).
  R1 treats it as one, so it can call such a tree stranded when a comment
  would still resume it. That errs toward reporting a strand. The cause list
  is copied by hand, so a new cause needs adding here too.
- The definitions are independent of `server/src/services/recovery/*`. That is
  deliberate: the recovery code is what W2 changes, and the number must not be
  graded by the code it judges.
