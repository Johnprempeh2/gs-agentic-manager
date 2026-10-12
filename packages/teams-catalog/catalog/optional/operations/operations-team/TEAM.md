---
name: Operations Team
description: Designed by Greatstone. An operations coordinator, minutes taker, reporter and policy writer who turn requests into tasks, chase owners, write up meetings, draft the weekly status report and monthly board pack, and keep policies current, with one human overseer who approves everything that leaves the team.
schema: agentcompanies/v1
slug: operations-team
category: operations
key: paperclipai/optional/operations/operations-team
manager: agents/operations-coordinator/AGENTS.md
includes:
  - agents/minutes-taker/AGENTS.md
  - agents/operations-reporter/AGENTS.md
  - agents/policy-writer/AGENTS.md
  - skills/meeting-actions/SKILL.md
  - skills/status-report/SKILL.md
  - projects/operations/PROJECT.md
defaultInstall: false
recommendedForCompanyTypes:
  - small-business
  - services
  - generalist
tags:
  - greatstone
  - operations
  - reporting
  - meetings
  - routines
---

# Operations Team

Designed by Greatstone. This team takes the admin and reporting load off an operations manager or managing director. It turns requests into tasks, chases owners, writes up meetings, drafts the weekly status report and the monthly board pack, and keeps policies and procedures current. One human overseer approves every report, action list and policy before it goes to anyone.

## Who is in the team

| Agent | Role it replaces | Share of that job |
| --- | --- | --- |
| Operations Coordinator | Operations coordinator | About 50% |
| Minutes Taker | Executive assistant (meetings part) | About 60% |
| Operations Reporter | PMO analyst | About 50% |
| Policy Writer | Policy or process writer | About 50% |

The Operations Coordinator reports to the human overseer. The Minutes Taker, Operations Reporter and Policy Writer report to the Operations Coordinator.

## What ships

- `operations` project: the home for requests, meetings, reports and policies.
- Five routines. Each ships paused with a schedule in UK time; the overseer checks the times and switches them on.
  - `daily-triage`: the Operations Coordinator turns new requests into tasks, weekdays at 08:00.
  - `overdue-chase`: the Operations Coordinator chases overdue tasks, weekdays at 16:00.
  - `weekly-status-report`: the Operations Reporter drafts the weekly status report, Fridays at 14:00.
  - `monthly-board-pack`: the Operations Reporter drafts the board pack for the month just ended, on the 1st at 09:00.
  - `monthly-policy-review`: the Policy Writer checks which policies are due for review, on the 1st at 11:00.
- Two first tasks, in the backlog: `map-meetings-and-reports` for the Operations Coordinator and `status-report-template` for the Operations Reporter. Move them to To do to start.
- `meeting-actions` skill: turns meeting notes into decisions and actions.
- `status-report` skill: the weekly status report and monthly board pack format.
- Daily run limits: Operations Coordinator 8, Minutes Taker 8, Operations Reporter 4, Policy Writer 4.

## Before you start

The team works from what the business shares with it: meeting notes, documents, data exports and, if you choose, read access to a shared inbox. Connect these after install. Until then it can only work with what is attached to its tasks.

## Human approval

No report, action list, policy or email goes to anyone, inside or outside the business, until the human overseer says yes. The team drafts; people send.
