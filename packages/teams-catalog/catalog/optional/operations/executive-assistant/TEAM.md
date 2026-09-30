---
name: Executive Assistant
description: Designed by Greatstone. One executive assistant for a small business owner that sorts the inbox, screens CVs, keeps the diary, drafts documents from templates, chases unpaid invoices and writes a Friday briefing, with the owner as the one human overseer who approves every send.
schema: agentcompanies/v1
slug: executive-assistant
category: operations
key: paperclipai/optional/operations/executive-assistant
manager: agents/executive-assistant/AGENTS.md
includes:
  - skills/weekly-briefing/SKILL.md
  - projects/owner-support/PROJECT.md
defaultInstall: false
recommendedForCompanyTypes:
  - small-business
  - generalist
  - services
tags:
  - greatstone
  - executive-assistant
  - inbox
  - admin
  - routines
---

# Executive Assistant

Designed by Greatstone. This team gives a small business owner one executive assistant agent. It prepares; the owner decides. The owner is the one human overseer and approves every email, invite, document and payment before it goes anywhere.

## Who is in the team

| Agent | Role it replaces | Share of that job |
| --- | --- | --- |
| Executive Assistant | Part-time executive assistant or office manager | About 60% |

## What ships

- `owner-support` project: the home for inbox, CV, diary, document and invoice work.
- `daily-inbox-sweep` routine: sorts the inbox, drafts replies and flags overdue invoices each weekday. It ships paused with a schedule for 08:00 Monday to Friday, UK time.
- `friday-weekly-briefing` routine: a one-page briefing for the owner every Friday. It ships paused with a schedule for 15:00 on Fridays, UK time.
- `weekly-briefing` skill: the briefing format.

The owner checks the times and switches both routines on after install.

## Before you start

The assistant needs access to the owner's email, diary and files to do this work. Connect them after install. Until then it can only work with what is attached to its tasks.

## Human approval

No email, invite, reminder, contract or payment leaves the business until the owner says yes.
