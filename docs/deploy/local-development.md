---
title: Local Development
summary: Set up GS Agentic Manager for local development
---

Run GS Agentic Manager locally with zero external dependencies.

## Prerequisites

- Node.js 24.11+
- pnpm 9+

## Start Dev Server

```sh
pnpm install
pnpm dev
```

This starts:

- **API server** at `http://localhost:3100`
- **UI** served by the API server in dev middleware mode (same origin)

No Docker or external database required. GS Agentic Manager uses embedded PostgreSQL automatically.

## One-Command Bootstrap

For a first-time install:

```sh
pnpm gsam run
```

This does:

1. Auto-onboards if config is missing
2. Runs `gsam doctor` with repair enabled
3. Starts the server when checks pass

## Bind Presets In Dev

Default `pnpm dev` stays in `local_trusted` with loopback-only binding.

To open GS Agentic Manager to a private network with login enabled:

```sh
pnpm dev --bind lan
```

For Tailscale-only binding on a detected tailnet address:

```sh
pnpm dev --bind tailnet
```

Legacy aliases still work and map to the older broad private-network behavior:

```sh
pnpm dev --tailscale-auth
pnpm dev --authenticated-private
```

Allow additional private hostnames:

```sh
npx gsam allowed-hostname dotta-macbook-pro
```

For full setup and troubleshooting, see [Tailscale Private Access](/deploy/tailscale-private-access).

## Health Checks

```sh
curl http://localhost:3100/api/health
# -> {"status":"ok"}

curl http://localhost:3100/api/companies
# -> []
```

## Safe Worktree Bootstrap for Local Agent Runs

For safer parallel local experiments, initialize a dedicated worktree instance instead of reusing your main checkout:

```sh
npx gsam worktree:make local-lab --seed-mode minimal
cd ~/paperclip-local-lab
pnpm gsam worktree env                       # inspect generated env exports
eval "$(npx gsam worktree env)"             # bash/zsh
pnpm gsam run
pnpm gsam doctor
```

If the experiment gets noisy, repair or reseed the worktree without touching the main branch:

```sh
# worktree repair rebuilds the local checkout metadata, so run the checked-out CLI through the direct-exec form.
node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts worktree repair --branch paperclip-local-lab
npx gsam worktree reseed --from . --to paperclip-local-lab
```

When done, shut it down and remove the isolated state explicitly:

```sh
npx gsam worktree:cleanup local-lab --force
```

## Reset Dev Data

To wipe local data and start fresh:

```sh
rm -rf ~/.gsam/instances/default/db
pnpm dev
```

## Data Locations

| Data | Path |
|------|------|
| Config | `~/.gsam/instances/default/config.json` |
| Database | `~/.gsam/instances/default/db` |
| Storage | `~/.gsam/instances/default/data/storage` |
| Secrets key | `~/.gsam/instances/default/secrets/master.key` |
| Logs | `~/.gsam/instances/default/logs` |

Override with environment variables:

```sh
GSAM_HOME=/custom/path GSAM_INSTANCE_ID=dev pnpm gsam run
```
