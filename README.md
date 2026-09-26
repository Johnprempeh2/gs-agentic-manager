# GS Agentic Manager

Greatstone's control plane for teams of AI agents. You set the goal, hire the agents, and approve the plan. GS Agentic Manager runs the work and keeps every task, run, cost and decision in one place, where an operator can see what is happening, whether it needs them, and what to do about it.

It works with the agents you already use (Claude Code, Codex, Cursor, Gemini, OpenCode, OpenClaw, Hermes, plain processes and HTTP endpoints), and it gives them the structure a real organisation has: an org chart, budgets, approvals, routines and an audit trail.

GS Agentic Manager is Greatstone International's fork of the open-source [Paperclip](https://github.com/paperclipai/paperclip) project. See [NOTICE.md](NOTICE.md) for attribution.

## Running it locally

You need Node.js 24.11 or newer and pnpm 9. A full production build also compiles the runner daemon in Rust, so install a stable Rust toolchain (`rustup` or `brew install rust`) if you plan to run `pnpm build`.

```sh
pnpm install
pnpm dev
```

The API and the board UI both come up on `http://localhost:3100`. An embedded PostgreSQL starts automatically, so there is nothing else to set up. To keep a test instance away from your real data, give it its own folder:

```sh
pnpm dev --data-dir ./tmp/gsam-dev
```

The first visit walks you through naming your organisation, creating a first agent and connecting a model.

## The command line

The CLI is `gsam`. Inside this repo, run it through pnpm:

```sh
pnpm gsam onboard
pnpm gsam doctor
pnpm gsam issue get <task-id>
```

Instance data lives under `~/.gsam` by default (set `GSAM_HOME` to move it).

## Configuration

Every setting is a `GSAM_*` environment variable; `.env.example` lists the common ones.

Existing Paperclip installs keep working. At startup the server, CLI and dev runner read any legacy `PAPERCLIP_*` variable as its `GSAM_*` equivalent (the new name wins if both are set). In the other direction, every environment handed to an agent carries both names, because the upstream agent-runtime images, the OpenClaw and Hermes gateways and externally installed agent skills still read the old ones. The bridge lives in `packages/shared/src/legacy-env.ts`. Two things stay deliberately unchanged for the same reason: the `X-Paperclip-*` HTTP headers agents send, and the `ghcr.io/paperclipai/*` runtime images sandboxes pull.

## Brand and design

The interface follows the Greatstone brand: the void (`#121212`) with lime `#c8ff00` in dark mode, paper (`#f7f8f4`) with emerald `#1b5039` in light mode, and Montserrat throughout. All visual values live in one token file, `ui/src/index.css`; components never hardcode colour, spacing or type. [DESIGN.md](DESIGN.md) sets the rules and `pnpm check:token-gates` enforces them.

The stone mark is built from the traced outline of the Greatstone master logo (`ui/src/components/BrandMark.tsx`). Favicons and app icons are generated from the same geometry by `python3 scripts/generate-brand-icons.py`.

## Taking changes from upstream

The fork diverges from Paperclip on purpose, so upstream updates arrive as merges you review rather than a clean pull. After merging, re-run the rename and relink the workspace:

```sh
node scripts/greatstone-rebrand.mjs
pnpm install
node scripts/greatstone-rebrand.mjs --check
```

The script is idempotent and documents exactly what it renames and what it leaves alone. Its header also lists the runner artefacts to regenerate afterwards, because the runner checks generated files against sources the rename has touched. Upstream's CI under `.github/` still points at Paperclip's infrastructure and has not been adapted yet.

## Development

```sh
pnpm typecheck
pnpm test
pnpm build
```

Deeper guides sit in `doc/` (architecture, development, deployment modes, database) and the product documentation in `docs/`.

## Licence

MIT. See [LICENSE](LICENSE), which keeps the original Paperclip copyright alongside Greatstone International's.
