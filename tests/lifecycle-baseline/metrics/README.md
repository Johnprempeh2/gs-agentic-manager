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

**R1 detail — parked wakes with no live run** (`parkedWakes` in
`metrics.json`, GRE-685). Count of `deferred_issue_execution` wakes requested at
least 10 minutes ago whose issue has no `execution_run_id`, split by wake
`reason`. Nothing will drain such a wake, and the stranded-queue sweep promotes
it only when it carries comment ids or an interaction answer, so review
hand-offs, "blockers resolved" and assignment wakes stay parked. Report only:
it sizes the problem before the sweep change. Zero is printed as zero.

**R1 detail — repair escalations to the board** (`repairEscalations` in
`metrics.json`, register row 76, GRE-725). Count of
`issue.disposition_repair_escalated` activity in the window whose
`terminalReason` is `unchanged_source_state_exhausted`, in a 2x2 split:
agent-only task or not (agent assignee before escalation, no user assignee, no
chat user, every execution stage participant an agent), and whether any repair
run for that escalation posted a comment (agent `issue.comment_added` on a run
woken with `issue_disposition_repair` on the same issue, with the same
source-state fingerprint, started no later than the escalation; recovery action
ids differ per attempt, so they are not matched). Each cell lists its issue identifiers. Report only:
it sizes row 75 (who owns the escalation). Zero is printed as zero.

**R1 detail — throttled rewakes** (`throttledRewakes` in `metrics.json`,
register row 126, GRE-893). Count of `agent_wakeup_requests` with status
`skipped` and reason `issue_rewake_throttled` requested in the window: wakes
the rewake throttle refused because the agent had a streak of no-progress runs
on the issue. Split per agent and per (issue, agent), each with the highest
`heartbeatSkip.noProgressStreak` seen, the last skip time and the original wake
reasons; the report lists the top 10 pairs with issue ids. The throttle slows
such a loop but never stops it, and the run API does not show skipped wakes.
Report only: it sizes row 125 (cut-off to the manager). Zero is printed as zero.

**R2 — run failure rate and unattended recovery.** Among runs that finished in
the window, failure rate is `failed + timed_out + interrupted` divided by those
plus `succeeded`. Cancelled runs are reported but excluded, because
cancellation is usually a human decision or a supersession. A failed run
counts as recovered without a human when a later run on the same issue
succeeds, or the issue reaches `done`, and no human acted on that issue in
between. Reading, starring and trace inspection do not count as acting. The
unattended share is auto-recovered failures divided by failures that have an
issue. Failures with no issue are counted separately.

The **platform failure rate** is the same rate with rejected logins (below)
left out of both the failed count and the finished count. A refused login is
an account problem for the board, not a platform fault, so the R2 budget
checks the platform rate and the report shows login refusals as a separate
count (GRE-590). The all-in `failureRate` is still saved. The unattended
share still includes rejected logins.

Account and setup refusals are left out the same way and counted as
`r2.accountRefusals`, split by reason in `r2.accountRefusalsByReason`
(GRE-745): an expired credential, no personal default account, a connection
not permitted for the agent, low trust with no sandbox environment
(`low_trust_requires_sandbox_environment`), and a task with no project
workspace. Each is matched on its error code plus the fixed server message for
that one reason, never on a whole code: `configuration_incomplete` also carried
the GRE-236 platform bug, which stays counted, and so does `acpx_turn_failed`.
The collector reads a failed run's error text in memory for this match; the
text is not saved in the report.

**R2 detail — rejected logins.** A failed run whose login the provider
refused: its error code is `<provider>_auth_required`, or (servers before
GRE-15) its error text says "terminal access failure". Only that boolean is
read, never the text. The report counts these runs, the retry runs scheduled
from them, and the `Bounded retry exhausted` events in the window that follow
one. After GRE-15 the last two should be zero: a dead login goes straight to
`blocked` with a board-owned recovery action.

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

**S1-work — wake to first useful non-comment action** (`s1.work` in
`metrics.json`). Same start point and same useful-action filter as S1, but the
clock stops at the first useful action that is not `issue.comment_added`: a
status change, document, new issue, approval request and so on. Timed runs
that only commented are counted (`runsWithCommentsOnly`) but not timed.

**A speed claim needs both S1 and S1-work.** Since GRE-4 agents post a
one-line comment first, which moves S1 without the real work getting any
faster (S1 median 40.5 s → 12.1 s while wake → first non-comment action stayed
at 48 s). A fix that improves S1 but not S1-work has only moved the comment.

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

## Time lost to platform faults — L1 to L4 (GRE-37)

These count the three faults from the GRE-32 assessment, so the fixes in
GRE-34, GRE-35 and GRE-36 can be checked with a before and after number.
`lost-time.mjs` holds the definitions; `lost-time-collect.mjs` reads a database
the same way as `collect.mjs` (read only, loopback hosts only).

```sh
pnpm metrics:lost-time                                 # local embedded instance, last 7 days
pnpm metrics:lost-time --company <id> --since 2026-09-27T00:00:00Z --now 2026-09-28T00:00:00Z
pnpm metrics:lost-time --silence-minutes 20            # threshold for L1 manual cancels (default 20)
pnpm metrics:lost-time --run-log-dir <instance>/data/run-logs   # run logs for L1 manual cancels
```

It writes `.lifecycle-baseline/metrics/lost-time/<stamp>/lost-time.{json,md}`.
Reports hold identifiers, rule names and timings, never comment bodies.

- **L1 — runs stopped as silent or hung, and their minutes.** A run finished
  in the window counts when a watchdog stopped it (`run_silent_timeout`,
  `process_lost`, or status `timed_out`), or when a person cancelled it
  (`errorCode = 'cancelled'`) after it had written no output for at least the
  silence threshold (GRE-182). Silence is read from the run log's chunk times
  and ends where the stop flush starts: output in the last 60 s before
  `finished_at` is the dying process's own (tool call, status, error) and is
  ignored. The clock starts at the last output before that, then process
  start, then run start. A run with no local log falls back to the row's
  `last_output_at` (marked `run row` in the report), which the stop flush can
  hide. A bulk cancel of runs that were still writing does not count; the
  report gives how many long manual cancels were left out. The two kinds are
  reported apart: after GRE-34, hangs should move from "person" to "watchdog"
  and their minutes should drop to about the threshold.
- **L2 — recovery moved an issue to `blocked` while an interaction was
  pending.** A recovery move is a system `issue.updated` activity row with a
  `recovery.*` source and status `blocked`. It counts when an interaction on
  that issue was created before the move and resolved after it (or not yet).
- **L3 — runs cancelled by `issue_reassigned`, and their minutes.** Minutes
  run from start to cancel; a run cancelled while queued adds zero.
- **L4 — human comments that ask for or relay status, or recover a run.** A
  simple text rule (`HUMAN_COMMENT_RULES`): *asks status* ("why is…",
  "taking… long"), *relays status* ("been merged", "I fixed"), *recovers a
  run* ("hung", "last run failed", "token expired"). Best effort: it misses
  wording it does not know and can match a comment that is not a relay. Each
  counted comment is listed by id so the rule can be audited.

Each report gives finished runs and agent-minutes in the window, and L1/L3 as a
share of agent-minutes. Compare windows of the same length, and compare shares
as well as raw counts: a busier week has more runs to lose.

Limits: the database alone has no reliable silence signal for a cancelled run
(`last_output_at` and even `process_started_at` are written again during the
stop), so L1 reads the run logs; point `--run-log-dir` at the instance being
measured. The manual-cancel rule stays next to the watchdog because an agent
can turn the watchdog off (`silentTimeoutSec: 0`) and older windows predate
it. If GRE-34 or GRE-36 ship a different
stop code than the ones above, add it to `SILENT_STOP_CODES` or
`REASSIGN_STOP_CODE` before taking the after number.

## John's time — Chase, Unstick, Decisions, Cards rejected, Rounds, Failed runs (GRE-397, GRE-453)

One line for the 08:00 digest: how much of John's board time went on chasing
and unsticking rather than decisions. `john-time.mjs` holds the rules;
`john-time-collect.mjs` reads a database the same way as `collect.mjs` (read
only, loopback hosts only) and prints the line.

```sh
pnpm metrics:john-time --company <id>                 # line for the digest, last 24 h + 7-day trend
pnpm metrics:john-time --company <id> --json          # counts per day and the ids of counted comments
pnpm metrics:john-time --company <id> --now 2026-10-02T08:00:00Z --john-user-ids local-board,<user id>
```

Example: `**John's time (24h):** Chase 4 · Unstick 1 · Decisions 14 · Failed
runs 12 (workspace_validation_failed 4, …). 7 days, oldest first: Chase
0,0,3,1,2,4,4 · Unstick …`. Today is the 24 hours up to `--now`; the trend is
the seven 24-hour windows ending at `--now`, oldest first.

**Whose comments.** Only comments with `author_type = 'user'` from one of
John's user ids: by default every signed-in user plus the `local-board`
sentinel (one-person board). `board-concierge`, system and agent comments
never count. Override with `--john-user-ids`.

**Classes.** Each John comment gets one class; the first rule that matches wins.
Text is normalised first (HTML entities, curly quotes, markdown links and
images removed).

1. **Unstick, short nudge** (`UNSTICK_SHORT_RULE`): the whole comment is at
   most 8 words and is only "start", "continue", "run", "retry", "go ahead",
   "carry on", "proceed", "try again", "keep going" (with "now", "please",
   "it", "you can"), or "it's free now" / "should be unlocked".
2. **Repair** (`REPAIR_RULE`, counted under Unstick): a diagnosis of a stopped
   run posted under John's name — "your last run/wake … failed/hung/ended",
   "setup failed", "connection/token is fixed/expired", or "please continue /
   retry" inside a longer note.
3. **Unstick, restart agents** (`UNSTICK_ANY_RULE`, any length): reactivate /
   boot up / wake up agents, "activate the others", "get the agents working",
   "allow the next batch", "you can add/let more".
4. **Chase** (`CHASE_RULE`): asks for status or a reason — "how is it going",
   "any update", "is everything okay", "what do you need", "what's wrong",
   "what is X doing", "you working?", "are you receiving", "how long … take",
   "why is/doesn't … blocked/failing/taking/access", "what caused … fail",
   "is it done/stuck", "still working".
5. Everything else is **other** (instructions, decisions in text, questions
   about the product).

**Decisions.** Interactions John resolved as `accepted`, `rejected` or
`answered` (expired and cancelled cards are not decisions), plus approvals he
decided (`approved`, `rejected`, `revision_requested`).

**Cards rejected and rounds per approved card (GRE-453).** Rework on approval
cards: interactions of kind `request_confirmation` or
`request_checkbox_confirmation` that John resolved as `accepted` or
`rejected`. *Cards rejected* is the number he rejected in the 24 hours.
*Rounds* for a card he accepted is 1 plus the cards he rejected on the same
task since the last card he accepted there (rejections before the window
count; the collector reads 30 extra days of approval cards for this). The line
gives the average over the 7 days and how many approvals it covers, e.g.
`Rounds per approved card (7d): 1.2 over 47`; the history shows `Rejected` per
day and `Rounds` per day (`-` when nothing was approved that day). A task
rejected and never accepted adds to Cards rejected but not to Rounds.

Baseline (GRE-449 assessment): 15 of 33 approval cards rejected, 30 Sep to
3 Oct 2026. These rules give 16 rejected of 34 decided for the four 24-hour
windows ending 3 Oct 08:00 UTC, and 1.2 rounds over 47 approvals for the 7
days to then (`pnpm metrics:john-time --now 2026-10-03T08:00:00Z`).

**Failed runs, by cause.** Runs finished in the window with status `failed`,
`timed_out` or `interrupted`, or cancelled by a watchdog
(`run_silent_timeout`, `process_lost`, `adapter_failed`). Cause is the
`error_code` (status when empty); the line shows the top three and "other".
Routine cancels (`cancelled` by a person, `issue_reassigned`, dependency
blocked) are not failures; L1 above covers hung runs a person cancelled.

Error rate: on the 128 John comments from 27 Sep to 2 Oct 2026, the rules
counted 14 chase, 15 unstick and 8 repair (29 %, close to the "about 1 in 3"
of the GRE-394 assessment); one known false positive is a status relay that
ends "I see you are still working". The rules miss wording they do not know.
Use `--json` to audit by comment id; add misses to the rules and to the
sample comments in `john-time.test.mjs`.
