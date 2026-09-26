---
title: CLI Overview
summary: CLI installation and setup
---

The GS Agentic Manager CLI handles instance setup, diagnostics, and control-plane operations.

## Usage

```sh
pnpm gsam --help
```

## Global Options

All commands support:

| Flag | Description |
|------|-------------|
| `--data-dir <path>` | Local GS Agentic Manager data root (isolates from `~/.gsam`) |
| `--api-base <url>` | API base URL |
| `--api-key <token>` | API authentication token |
| `--context <path>` | Context file path |
| `--profile <name>` | Context profile name |
| `--json` | Output as JSON |

Company-scoped commands also accept `--company-id <id>`.

For clean local instances, pass `--data-dir` on the command you run:

```sh
npx gsam run --data-dir ./tmp/paperclip-dev
```

## Context Profiles

Store defaults to avoid repeating flags:

```sh
# Set defaults
npx gsam context set --api-base http://localhost:3100 --company-id <id>

# View current context
pnpm gsam context show

# List profiles
pnpm gsam context list

# Switch profile
npx gsam context use default
```

To avoid storing secrets in context, use an env var:

```sh
npx gsam context set --api-key-env-var-name GSAM_API_KEY
export GSAM_API_KEY=...
```

Secret operations are available under `gsam secrets`:

```sh
npx gsam secrets declarations --company-id <company-id> --kind secret
npx gsam secrets create --company-id <company-id> --name anthropic-api-key --value-env ANTHROPIC_API_KEY
npx gsam secrets link --company-id <company-id> --name prod-stripe-key --provider aws_secrets_manager --external-ref <provider-ref>
npx gsam secrets doctor --company-id <company-id>
npx gsam secrets migrate-inline-env --company-id <company-id> --apply
```

Context is stored at `~/.gsam/context.json`.

## Command Categories

The CLI has two categories:

1. **[Setup commands](/cli/setup-commands)** — instance bootstrap, diagnostics, configuration
2. **[Control-plane commands](/cli/control-plane-commands)** — issues, agents, approvals, activity
