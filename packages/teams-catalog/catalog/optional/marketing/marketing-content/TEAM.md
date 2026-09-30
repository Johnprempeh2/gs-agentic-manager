---
name: Marketing Content Team
description: Designed by Greatstone. A marketing lead, content writer and social media coordinator who plan, draft and prepare a business's content each week, with one human overseer who approves every piece before anything is published, posted or sent.
schema: agentcompanies/v1
slug: marketing-content
category: marketing
key: paperclipai/optional/marketing/marketing-content
manager: agents/marketing-lead/AGENTS.md
includes:
  - agents/content-writer/AGENTS.md
  - agents/social-media-coordinator/AGENTS.md
  - skills/content-planning/SKILL.md
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

Designed by Greatstone. This team plans a business's content each week, drafts it, and gets it ready for each channel. One human overseer approves every piece. Nothing is published, posted, scheduled or sent until they say yes.

## Who is in the team

| Agent | Role it replaces | Share of that job |
| --- | --- | --- |
| Marketing Lead | Marketing manager | About 40% |
| Content Writer | Content writer or copywriter | About 60% |
| Social Media Coordinator | Social media executive | About 50% |

The Marketing Lead reports to the human overseer. The Content Writer and Social Media Coordinator report to the Marketing Lead.

## What ships

- `marketing-content` project: the home for the content calendar and every piece of content.
- `weekly-content-planning` routine: the Marketing Lead's Monday planning run. It ships paused with a schedule for 09:00 on Mondays, UK time. The overseer checks the time and switches it on.
- `content-planning` skill: a weekly content calendar with an approval step for every item. It follows the same calendar approach as the Content Machine team and adds the human approval gate.

## Human approval

Nothing is published, posted, scheduled or sent, and no money is spent on ads, boosts or tools, until the human overseer approves that exact version.
