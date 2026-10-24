# Block check

John, 24 Oct 2026 (GRE-2277): tasks said `blocked` when nothing blocked them,
and nobody checked. GRE-1989 stayed blocked for over an hour after John
accepted the card it waited on, and about 20 website tasks waited behind it.

The block check is one server check that finds these. Each project lead runs
it from a routine, and Everest's "Blocker check" routine runs the same check.
There is no second copy of the rules.

## The check

`GET /api/companies/{companyId}/block-check`

| Query | Meaning |
| --- | --- |
| `leadAgentId=me` | Only the projects the calling agent leads. Use this in a lead's routine. |
| `leadAgentId={agentId}` | Only the projects that agent leads. |
| `projectId={projectId}` | Only that project. |
| none | Every project in the company, and tasks with no project (`projectId: null`). |

Read only. Any member of the company may call it. Hidden, done and cancelled
tasks are left out.

The answer has one entry per project with something to look at, biggest
first. Each entry has `projectId`, `projectName`, `leadAgentId`, `items` and a
`fingerprint`. The fingerprint changes only when the items change.

Each item has `kind`, `issue` (id, identifier, title, status, assignee),
`detail` (one plain line), `since`, `cardId`, `blockerIds` and `waitingOn`.

| `kind` | Found when | What the lead does |
| --- | --- | --- |
| `blockers_closed` | Blocked, and every task it waits on is done or cancelled. | Read what the blocker delivered. Unblock it, or record the real blocker. |
| `card_answered` | Blocked, nothing open holds it, and a card on it was answered after it went into blocked. | Read the answer. Unblock it so its assignee acts on the answer. |
| `unexplained` | Blocked, with no open blocker, no pending card and no recorded reason. This is the tree's "Nothing recorded is blocking it" warning. | Find the real blocker and record it (a blocker link, or `unblockDescriptor`), or unblock it. |
| `condition_in_title` | The title names a condition in brackets, such as "(after John accepts the proof)". Any open task. | Check if the condition is met. If it is, take it out of the title and let the work go on. If not, record it as the blocker. |
| `old_human_ask` | A card to a person or the board has waited over a day, or a blocked task's recorded ask to a person is over a day old. | Nudge the person once a day. |

Rules match the task tree (`ui/src/lib/task-tree-block-reason.ts`): a hidden
blocker does not count, a blocker that is done or cancelled does not hold a
task, and a pending card or an `unblockDescriptor.action` explains a block.

## Routine instructions: project lead

One routine per project lead (Lintel for the Greatstone Website). Settings:

- Schedule: every 30 minutes.
- Assignee: the project lead. Project: the lead's project.
- `concurrencyPolicy: skip_if_active`, `catchUpPolicy: skip_missed`.
- `activityGatePolicy: require_external_activity`, `activityGateScope: project`,
  so it runs only when something changed in the project.

Title: `Block check for {project} (every 30 min)`

Description (paste as written):

```markdown
Check the blocks in the projects you lead, and fix what you can. Coordination only: do not write code here. Finish in about 10 minutes.

1. Call `GET /api/companies/{companyId}/block-check?leadAgentId=me`.
2. If it has no items, or every project's `fingerprint` is the same as in your last run's report and no `old_human_ask` is due a nudge, post "No change" on this run's task, mark it done and stop.
3. Work each item by its `kind`:
   - `blockers_closed` or `card_answered`: read what the blocker delivered or what the card answer says. If the task can go on, post one comment that says what changed and what to do next, and set it to `todo` so its assignee wakes. If something else still holds it, record that (add the blocker link, or set `unblockDescriptor` with the owner and action) and leave it blocked.
   - `unexplained`: read the latest comments. Record the real blocker as above, or, if nothing holds it, unblock it as above. If you cannot tell, ask the assignee on the task in one line.
   - `condition_in_title`: check if the condition is met. If it is, take the condition out of the title and say so on the task. If it is not, make sure the block is recorded as above.
   - `old_human_ask`: nudge the person named in `waitingOn` once a day: one comment on the task that says what they must do and what it holds up. Do not nudge again within 24 hours. If an agent or you can decide it instead (timing, readiness, housekeeping), decide it, withdraw the card and tell the assignee.
4. Do not unblock a task that waits on a client, money, a hire, secrets or login, or anything client-facing that John has not approved. Record its blocker instead.
5. Post at most five lines on this run's task: what you unblocked (ids), what you recorded, who you nudged, and each project's `fingerprint`. Then mark the run done.
```

## Routine instructions: Everest's "Blocker check"

Everest's "Blocker check and John's decision filter (every 30 min)" routine
keeps Part 2 (John's decisions filter) as it is. Replace Part 1 with:

```markdown
**Part 1. Stale blockers.** Call `GET /api/companies/{companyId}/block-check` (all projects). Project leads fix their own projects in their own routine. You handle:
- items in projects with no lead (`leadAgentId: null`) or no project (`projectId: null`), using the same steps as the lead routine;
- any project whose items have stayed the same (same `fingerprint`) for over a day: tell its lead on a task what is stuck.
Do not unblock a task that waits on a client, money, a hire, secrets or login, or anything client-facing that John has not approved.
```

## Switching the routines on

Turning on timer routines is a separate config step, not part of the
feature. Everest does it from its own task once this check is live.
