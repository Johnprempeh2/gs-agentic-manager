# Metric budgets

`budgets.json` holds one budget per tracked number. Each budget records its
baseline, the margin added to it and the limit that results. `check.mjs`
compares saved reports against those limits. It exits nonzero when a value
is over its limit, below its minimum sample size, or missing.

```sh
pnpm test:metrics                                  # checker and definition tests
pnpm perf:issue-detail && pnpm perf:task-chat      # produce S2 + task-chat reports
pnpm metrics:budgets --group ci                    # enforce CI budgets
pnpm metrics:collect && pnpm metrics:budgets --group weekly   # enforce R1/R2/S1
```

Use `--input <name>=<path>` to point a budget input at another report, and
`--budgets <file>` to use another budget file (for example, a CI-runner
calibration).

## Watch mark

The table shows each budget's `baseline` and the value as a multiple of it
(`x baseline`; `-` when there is no baseline or it is 0). A passing value at
2x baseline or more (0.7x or less for a `min` floor) prints `PASS (watch)`.
The exit code does not change. Summit opens a look-into task for each watch
row in the weekly report, and the owning engineer does the fix.

## Measured column

Each row shows how long ago its report was measured (the report's
`measuredAt`), or `unknown` when the report has none. A report older than its
group limit (weekly: 2 days; ci: 6 hours, `STALE_MAX_MS` in `check.mjs`) is
marked `STALE`, and a `STALE:` line follows the table. `pnpm test:metrics:s2`
prints the same on its `measured:` line. The exit code does not change; failing
on a stale report is register row 102 and waits for John.

## Groups

- **ci** — S2 (issue detail and board, p95 and median) and task-chat
  main-thread load. These are measured on a fresh seeded instance serving the
  built UI (`pnpm build` first), so any machine can reproduce them. They are
  enforced by `.github/workflows/metric-budgets.yml`, which runs the
  unthrottled profile only (`GSAM_ISSUE_PERF_PROFILES=unthrottled`, n=20).
  The p95 tail is noisy, so its margin is wide. The median budgets are there
  to catch smaller regressions.
- **weekly** — R1, R2 and S1. These need a real instance's run history, which
  CI does not have. The weekly routine runs `metrics:collect` against the
  local instance and then this check. A breach is reported on the weekly task.

## S2 check before merge (Keystone)

Keystone runs the S2 page-load check on each pull request that can change
the issue page or the board. Nothing runs it on GitHub per pull request.

```sh
pnpm metrics:s2-needed --pr 123     # "S2 page-load check needed: yes|no" and why
pnpm test:metrics:s2                # build UI, measure (n=20, unthrottled), check
pnpm test:metrics:s2 --metrics test-results/issue-detail-perf/metrics.json   # check only
```

`s2-paths.mjs` holds the path rule: `ui/**` (not tests, stories or docs), the
issue routes under `server/src/routes/`, `server/src/services/issues.ts`, the
S2 harness, and these budget files. `s2-check.mjs` measures with the instance
data in `./tmp/s2-check-*` (deleted afterwards). It prints one PASS or FAIL
line that names each broken budget, and exits 1 on FAIL.

It judges against `budgets.keystone-host.json`, the S2 budgets calibrated on
the machine Keystone runs on (Linux, WSL2). It uses the same margins as
`budgets.json`. Pass `--budgets tests/metrics-budgets/budgets.json` to use the
Apple-silicon calibration. If the Keystone machine changes, recalibrate:
run `pnpm test:metrics:s2 --skip-build` five times on unchanged `main`, take
the median of each measure, and apply the margins.

## Margins

A margin must be wider than the noise between runs, or CI becomes flaky. p95
values get the widest margin, because the tail is the noisiest part. Each
budget's `margin` field states the reasoning, and `baseline` records what was
measured on the recorded date (see `baselineRecorded`). A budget whose
baseline came from a later window records it in `baselineWindow` and
`baselineSamples` (S1 uses the week to 2026-09-28; S1-work uses the week to
2026-10-05). Change a budget only
with a new measurement from the same command, and record the new baseline on
the tracking task.

Budgets are calibrated on the machine named in `baselineRecorded.machine`. A
slower CI runner needs its own calibration. Record a run there, then commit
the numbers as a separate budget file selected through the
`METRIC_BUDGETS_FILE` repository variable. Do not widen the shared margins
to hide the difference.
