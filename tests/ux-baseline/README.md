# UX baseline: top five flows

Measures how much work the five everyday flows take, at desktop (1440×900)
and phone (390×844) width. Each user action goes through one recorder, so the
counts are what the script needed to do, not estimates.

```sh
pnpm build                 # the harness times the built UI (ui/dist)
pnpm ux:baseline           # 5 samples per flow and viewport
```

Before it starts, the run checks that `ui/dist` matches the checkout. The
build writes `ui/dist/build-info.json` (commit and build time). The run fails
when that file is missing, when it names a commit whose UI or `packages`
sources differ from HEAD, or when a UI or package source file is newer than
the build. Run `pnpm --dir ui build`, or set `GSAM_UX_BASELINE_BUILD=1` to
rebuild automatically. The bundle's commit is saved in `baseline.json` under
`meta.bundle`.

The run starts its own empty, loopback-only instance, seeds one company and
writes to `test-results/ux-baseline/`:

- `baseline.md`: summary table and per-step timings (median / p95)
- `baseline.json`: the same, plus every raw sample and the bundle commit
- `screens/`: a screenshot after every step of the first sample of each flow,
  and a full-page screenshot of any failure

Options:

| Variable | Default | Effect |
| --- | --- | --- |
| `GSAM_UX_BASELINE_RUNS` | 5 (minimum 3) | Samples per flow and viewport |
| `GSAM_UX_BASELINE_VIEWPORTS` | `desktop,phone` | Limit to one viewport |
| `GSAM_UX_BASELINE_FLOWS` | all | Comma-separated flow ids, for example `2-answer-decision` |
| `GSAM_UX_BASELINE_BUILD` | off | `1` rebuilds `ui/dist` when it is stale instead of failing |
| `GSAM_UX_BASELINE_PORT` | 3203 | Port for the launched instance |
| `GSAM_UX_BASELINE_BASE_URL` | none | Reuse a disposable loopback instance while editing flows. Start it with no `GSAM_*` variables from an agent shell, because its scripted agents run inside it |

## Flows

| Id | Flow | Done when |
| --- | --- | --- |
| `1-ask-everest` | Ask Everest for something in chat, then open the task it filed | The new task's title is on screen |
| `2-answer-decision` | Open Decisions and approve a pending confirmation | The card has left the list |
| `3a-needs-me-inbox` | Find what needs John today in the Inbox (Mine) | The task assigned to John is on screen |
| `3b-needs-me-focus` | The same through Decisions → Focus | Focus mode shows its first decision |
| `4-task-latest-result` | Find a finished task and read its latest result | The result comment is on screen |
| `5-overnight-activity` | See what the agents did overnight (home → Since you were last here) | The first agent's work is on screen |

Every sample starts from a cold load of the dashboard in a fresh browser
context, like opening the app.

## What is measured

- **Clicks/taps**, **typing** (one per field filled), **scrolls** (one each
  time the target was below the fold or under fixed chrome, such as the phone
  tab bar) and **screens** (pages the user lands on, including home;
  redirects along the way do not count).
- **Total time**: from the dashboard being ready to the goal being on screen.
  It is machine time with no human reading or thinking time. Use it to compare
  runs of this script, not as a human task time.
- **Active time**: total time minus the wait for the agent's reply (flow 1).
- **Home load**: the cold dashboard load before each flow.
- **Steps**: time from each action to the next screen being ready. This is the
  page-load figure for each screen in the flow.

## Seed data

The agents (Everest, Ridge, Mica) are local processes running
`fixtures/ux-agent.mjs`. They make no model calls, but every write they make
goes through a real heartbeat run, so comments, decisions and audit entries
look the same as real agent work. Each task the seed hands them carries its
script on a `ux-script:` line in its description.
