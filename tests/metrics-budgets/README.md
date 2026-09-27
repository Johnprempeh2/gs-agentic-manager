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

## Margins

A margin must be wider than the noise between runs, or CI becomes flaky. p95
values get the widest margin, because the tail is the noisiest part. Each
budget's `margin` field states the reasoning, and `baseline` records what was
measured on the recorded date (see `baselineRecorded`). Change a budget only
with a new measurement from the same command, and record the new baseline on
the tracking task.

Budgets are calibrated on the machine named in `baselineRecorded.machine`. A
slower CI runner needs its own calibration. Record a run there, then commit
the numbers as a separate budget file selected through the
`METRIC_BUDGETS_FILE` repository variable. Do not widen the shared margins
to hide the difference.
