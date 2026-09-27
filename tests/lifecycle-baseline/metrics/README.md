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
`backlog` counts as parked on purpose, not open. A tree is stranded when:

- it has at least one open issue;
- no open issue has a live path. A live path is any of: a queued, running or
  retry-scheduled run; a queued or deferred wake; a pending interaction; a
  pending approval; an unresolved recovery action; a scheduled monitor; an
  assignee agent with a timer heartbeat that can be invoked; or a blocker
  (followed through chains) that itself has a path;
- no open issue is assigned to a human (humans act without being woken);
- no active tree hold covers it (a human deliberately stopped it); and
- nothing in the tree has changed for 30 minutes (the grace period).

An agent assignee alone is **not** a live path: agents act only when woken. The
weekly number counts stranded trees whose last activity falls in the window,
i.e. trees that stopped this week. The report also lists every stranded tree
of any age.

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
not harness bookkeeping: `environment.*` leases, checkout, read markers and
release don't count. Only finished runs are counted. Runs with no useful
action are counted but not timed. Median and p95 use nearest rank. The report
also includes the wake-to-start queue delay, so W3 can see where the time goes.

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
- The definitions are independent of `server/src/services/recovery/*`. That is
  deliberate: the recovery code is what W2 changes, and the number must not be
  graded by the code it judges.
