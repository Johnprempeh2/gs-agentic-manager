---
name: Research and Reporting Team
description: Designed by Greatstone. A research lead, data analyst and report writer who turn survey and interview data collected by your field team into analysis, sector benchmarks and branded reports, with one human overseer who signs off everything that leaves the organisation.
schema: agentcompanies/v1
slug: research-and-reporting
category: research
key: paperclipai/optional/research/research-and-reporting
manager: agents/research-lead/AGENTS.md
includes:
  - agents/data-analyst/AGENTS.md
  - agents/report-writer/AGENTS.md
  - skills/survey-to-report-outline/SKILL.md
  - projects/research-reporting/PROJECT.md
defaultInstall: false
recommendedForCompanyTypes:
  - research
  - consultancy
  - nonprofit
tags:
  - greatstone
  - research
  - reporting
  - surveys
  - routines
---

# Research and Reporting Team

Designed by Greatstone. This team helps a research firm, a non-profit or a consultancy turn survey and interview data into analysis, sector benchmarks and branded reports. People collect the data in the field. The agents check it, analyse it and draft the report. One human overseer signs off everything that leaves the organisation.

## Who is in the team

| Agent | Role it replaces | Share of that job |
| --- | --- | --- |
| Research Lead | Research manager | About 50% |
| Data Analyst | Data analyst on a survey study | About 70% |
| Report Writer | Report writer or research associate | About 60% |

The Research Lead reports to the human overseer. The Data Analyst and Report Writer report to the Research Lead.

## What ships

- `research-reporting` project: the home for every study.
- `monthly-report-cycle` routine: the Research Lead's monthly run from new data to a draft report. It ships paused with a schedule for 09:00 on the 1st of each month, UK time. The overseer checks the time and switches it on.
- `survey-to-report-outline` skill: turns a brief, a questionnaire and a batch of data into a report outline.
- One first task, in the backlog: `first-study-plan`. Move it to To do to start.

## Human approval

No report, dataset or email leaves the organisation, and no money is spent, until the human overseer says yes.
