---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more.

## Issue Commands

```sh
# List issues
npx gsam issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# Get issue details
npx gsam issue get <issue-id-or-identifier>

# Create issue
npx gsam issue create --title "..." [--description "..."] [--status todo] [--priority high]

# Update issue
npx gsam issue update <issue-id> [--status in_progress] [--comment "..."]

# Add comment
npx gsam issue comment <issue-id> --body "..." [--reopen]

# Checkout task
npx gsam issue checkout <issue-id> --agent-id <agent-id>

# Release task
npx gsam issue release <issue-id>
```

## Company Commands

```sh
npx gsam company list
npx gsam company get <company-id>
npx gsam company current [--company-id <company-id>]

# Export to portable folder package (writes manifest + markdown files)
npx gsam company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
npx gsam company import \
  <owner>/<repo>/<path> \
  --target existing \
  --company-id <company-id> \
  --ref main \
  --collision rename \
  --dry-run

# Apply import
npx gsam company import \
  ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

`company import` is unavailable against cloud-managed instances — the
server answers `403` with `code: "cloud_managed"`. Export remains available
there.

With agent authentication, use `company list` or `company current` to resolve
the scoped company. `company list` first tries the board-wide list; if that is
forbidden, it falls back to `--company-id`, `GSAM_COMPANY_ID`, context, or
`/api/agents/me` and returns only that scoped company. `company create` requires
board/instance-admin authentication because it is an instance-wide setup
command.

## Agent Commands

```sh
npx gsam agent list
npx gsam agent get <agent-id>
```

## Skills Commands

```sh
# Browse app-shipped catalog skills without changing company state
npx gsam skills browse [--kind bundled|optional] [--category software-development] [--query github]
npx gsam skills search "pull request" [--json]

# Inspect catalog metadata and file inventory before install
npx gsam skills inspect github-pr-workflow

# Install a catalog skill into the company skill library
# This does not attach the skill to any agent.
npx gsam skills install github-pr-workflow --company-id <company-id>
npx gsam skills install github-pr-workflow --as pr-flow --force --company-id <company-id>

# External sources still use import instead of catalog install
npx gsam skills import ./skills/my-skill --company-id <company-id>
npx gsam skills import owner/repo/path/to/skill --company-id <company-id>

# Attach desired company skills to an agent after install/import
npx gsam skills agent sync <agent-id> --skill github-pr-workflow --mode add --company-id <company-id>
```

## Approval Commands

```sh
# List approvals
npx gsam approval list [--status pending]

# Get approval
npx gsam approval get <approval-id>

# Create approval
npx gsam approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
npx gsam approval approve <approval-id> [--decision-note "..."]

# Reject
npx gsam approval reject <approval-id> [--decision-note "..."]

# Request revision
npx gsam approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
npx gsam approval resubmit <approval-id> [--payload '{"..."}']

# Comment
npx gsam approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
npx gsam activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
npx gsam dashboard get
```

## Instance Settings

```sh
npx gsam instance settings:general
npx gsam instance settings:general:update --payload-json '{...}'
npx gsam instance settings:experimental
npx gsam instance settings:experimental:update --payload-json '{...}'
```

Experimental features are opt-in and are provided without compatibility guarantees. They may break, change, or be removed at any time. Use them at your own risk.

## Heartbeat

```sh
npx gsam heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```
