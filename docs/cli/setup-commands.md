---
title: Setup Commands
summary: Onboard, run, doctor, and configure
---

Instance setup and diagnostics commands.

## `gsam run`

One-command bootstrap and start:

```sh
pnpm gsam run
```

Does:

1. Auto-onboards if config is missing
2. Runs `gsam doctor` with repair enabled
3. Starts the server when checks pass

Choose a specific instance:

```sh
npx gsam run --instance dev
```

## `gsam onboard`

Interactive first-time setup:

```sh
pnpm gsam onboard
```

If GS Agentic Manager is already configured, rerunning `onboard` keeps the existing config in place. Use `gsam configure` to change settings on an existing install.

First prompt:

1. `Quickstart` (recommended): local defaults (embedded database, no LLM provider, local disk storage, default secrets)
2. `Advanced setup`: full interactive configuration

Start immediately after onboarding:

```sh
pnpm gsam onboard --run
```

Quickstart defaults + immediate start:

```sh
pnpm gsam onboard --yes
```

When onboarding starts GS Agentic Manager from an interactive terminal, it opens the
onboarding page in your browser once. Non-interactive terminals stay silent.
Suppress browser opening explicitly for headless or automated runs with either
environment variable:

```sh
GSAM_NO_BROWSER=1 pnpm gsam onboard --yes
GSAM_OPEN_ON_LISTEN=false pnpm gsam onboard --yes
```

On an existing install, `--yes` now preserves the current config and just starts GS Agentic Manager with that setup.

## `gsam doctor`

Health checks with optional auto-repair:

```sh
pnpm gsam doctor
pnpm gsam doctor --repair
```

Validates:

- Server configuration
- Database connectivity
- Secrets adapter configuration, including AWS Secrets Manager non-secret env
  config when selected
- Storage configuration
- Missing key files

## `gsam configure`

Update configuration sections:

```sh
pnpm gsam configure --section server
pnpm gsam configure --section secrets
pnpm gsam configure --section storage
```

`--section secrets` updates the deployment-level provider used as the fallback
for secrets that do not target a specific company vault. Per-company provider
vaults (named instances, default vault selection, multiple vaults per provider,
coming-soon GCP/Vault) live in the board UI under
`Company Settings → Secrets → Provider vaults` and the
`/api/companies/{companyId}/secret-provider-configs` API.

## `gsam env`

Show resolved environment configuration:

```sh
pnpm gsam env
```

This now includes bind-oriented deployment settings such as `GSAM_BIND` and `GSAM_BIND_HOST` when configured.

## `gsam allowed-hostname`

Allow a private hostname for authenticated/private mode:

```sh
npx gsam allowed-hostname my-tailscale-host
```

## Local Storage Paths

| Data | Default Path |
|------|-------------|
| Config | `~/.gsam/instances/default/config.json` |
| Database | `~/.gsam/instances/default/db` |
| Logs | `~/.gsam/instances/default/logs` |
| Storage | `~/.gsam/instances/default/data/storage` |
| Secrets key | `~/.gsam/instances/default/secrets/master.key` |

Override with:

```sh
GSAM_HOME=/custom/home GSAM_INSTANCE_ID=dev pnpm gsam run
```

Or pass `--data-dir` directly on any command:

```sh
npx gsam run --data-dir ./tmp/paperclip-dev
npx gsam doctor --data-dir ./tmp/paperclip-dev
```
