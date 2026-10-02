---
name: Marketing Content Team
description: Designed by Greatstone. A marketing lead, content writer, social media coordinator and marketing analyst who plan, draft, prepare and measure a business's content each week, with one human overseer who approves every piece before anything is published, posted or sent.
schema: agentcompanies/v1
slug: marketing-content
category: marketing
key: paperclipai/optional/marketing/marketing-content
manager: agents/marketing-lead/AGENTS.md
includes:
  - agents/content-writer/AGENTS.md
  - agents/social-media-coordinator/AGENTS.md
  - agents/marketing-analyst/AGENTS.md
  - skills/content-planning/SKILL.md
  - skills/content-results-report/SKILL.md
  - projects/marketing-content/PROJECT.md
defaultInstall: false
recommendedForCompanyTypes:
  - small-business
  - marketing
  - services
tags:
  - greatstone
  - marketing
  - content
  - social-media
  - routines
---

# Marketing Content Team

Designed by Greatstone. This team plans a business's content each week, drafts it, gets it ready for each channel, and reports what worked. One human overseer approves every piece. Nothing is published, posted, scheduled or sent until they say yes.

## Who is in the team

| Agent | Role it replaces | Share of that job |
| --- | --- | --- |
| Marketing Lead | Marketing manager | About 40% |
| Content Writer | Content writer or copywriter | About 60% |
| Social Media Coordinator | Social media executive | About 50% |
| Marketing Analyst | Marketing analyst | About 50% |

The Marketing Lead reports to the human overseer. The Content Writer, Social Media Coordinator and Marketing Analyst report to the Marketing Lead.

## What ships

- `marketing-content` project: the home for the content calendar and every piece of content.
- Five routines. Each ships paused with a schedule in UK time; the overseer checks the times and switches them on.
  - `weekly-content-planning`: the Marketing Lead plans the week, Mondays at 09:00.
  - `daily-draft-review`: the Marketing Lead reviews drafts and batches them for approval, weekdays at 11:00.
  - `daily-social-posts`: the Social Media Coordinator drafts the day's posts and replies, weekdays at 09:30.
  - `weekly-content-numbers`: the Marketing Analyst reports the week's numbers, Fridays at 12:00.
  - `monthly-content-report`: the Marketing Analyst writes the monthly report, on the 1st at 09:00.
- Two first tasks, in the backlog: `brand-voice-guide` for the Marketing Lead and `results-baseline` for the Marketing Analyst. Move them to To do to start.
- `content-planning` skill: a weekly content calendar with an approval step for every item. It follows the same calendar approach as the Content Machine team and adds the human approval gate.
- `content-results-report` skill: the monthly results report format.
- Daily run limits: Marketing Lead 6, Content Writer 10, Social Media Coordinator 8, Marketing Analyst 2.

## Human approval

Nothing is published, posted, scheduled or sent, and no money is spent on ads, boosts or tools, until the human overseer approves that exact version.
