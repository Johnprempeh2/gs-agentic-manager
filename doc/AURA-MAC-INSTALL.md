# Aura: GSAM on the owner's own Mac

One install package puts a fresh, empty GSAM on one Mac, with one company,
"Aura" (GRE-6092, GRE-6097). The owner makes their own log-in and links their
own Claude and ChatGPT subscriptions. Nothing from Greatstone is in it: no
data, agents of ours, keys, AI routes, clients or memory. Owner: Bedrock.

This is not a Managed client instance (`doc/CLIENT-INSTANCES.md`): it has no
edition values, because the owner needs invites, connectors and their own
subscriptions (John, 23 Nov).

## The package

Built and tested by the "Aura macOS package" workflow
(`.github/workflows/aura-macos.yml`) on a GitHub Apple Silicon Mac. Take
`gsam-aura-macos-arm64.tar.gz` from the artifacts of a green run. The run also
keeps the file list (`*-FILES.txt`), sizes and `manifest.json` for Flint.

- **Apple Silicon only** (M1 and later). Intel Macs are not covered: they
  need the same workflow on an Intel runner.
- Contents: Node, the GSAM app with its embedded database, the Claude Code and
  Codex command-line tools (only for the subscription sign-in), the Aura
  template (`scripts/client-instance/templates/aura/`) and the scripts below.
- **Nothing to install first, nothing built on the Mac.** A stock Mac has no
  Node, pnpm, Rust or git. The package brings Node, and the agent runner
  (Rust) comes prebuilt for Apple Silicon; `check-package.sh` refuses a
  package without it. Only git comes from Apple: if the Command Line Tools are
  missing, the installer opens Apple's install prompt.
- **Not developer mode.** The log-in item runs the built server
  (`gsam run`), never `pnpm dev`. `gsam-aura stop` stops it and its database.
- Build by hand on a Mac: `pnpm install --frozen-lockfile`, then
  `AURA_FEATURE_REQUEST_ADDRESS=<address> scripts/aura-macos/build-package.sh <out dir>`.
  `scripts/aura-macos/check-package.sh` stops the build if it finds data,
  keys, local paths of our machines or Greatstone-only skills.

## Install (John present)

1. Copy the `.tar.gz` to the Mac. In Terminal:
   `tar -xzf gsam-aura-macos-arm64.tar.gz && bash gsam-aura-macos-arm64/install.sh`
   No administrator password is needed.
2. If macOS asks to install the Command Line Tools (for git), say yes.
3. The browser opens the first-run page. Choose **Sign in / Create account**,
   make the owner log-in, then press **Claim ownership**. The installer then
   closes public sign-up and restarts GSAM. If the page was closed too early:
   `~/GSAM-Aura/app/bin/gsam-aura claim`.
4. In GSAM, link the owner's own Claude and ChatGPT subscriptions (Connections).
   Never sign in with a Greatstone account.

What the installer makes:

| Where | What |
| --- | --- |
| `~/GSAM-Aura/app` | code (Node, app, tools, template) |
| `~/GSAM-Aura/data/instances/default` | config, database, files, secrets key |
| `~/GSAM-Aura/data/instances/default/data/backups` | backups, hourly, kept 30 days |
| `~/GSAM-Aura/logs` | server and install logs |
| `~/Library/LaunchAgents/com.gsam.aura.plist` | starts GSAM at log-in, restarts it after a crash |
| `~/Applications/GSAM.app` and the Dock | opens GSAM in the browser |

Settings at install: authenticated mode, this Mac only (`127.0.0.1`, port 3300
or the next free one), at most 2 agents at once (Instance settings), the
template's modules on, no install-wide AI route. To make GSAM an app window,
open it in Chrome or Edge and choose **Install GSAM** (or Safari: File > Add
to Dock).

## Day to day

`~/GSAM-Aura/app/bin/gsam-aura` with: `open`, `status`, `start`, `stop`,
`restart`, `backup` (a backup now), `logs`, `url`, `phone on|off`,
`telegram on|off`.

Restore (GRE-6109): `gsam-aura restore <backup file>` (a full path, or just the
file name from the backups folder; `gsam-aura status` shows the newest). It
checks the file, stops GSAM, moves the database aside to
`data/instances/default/db.before-restore-<date>`, restores the backup into a
new database with the bundled Postgres (no Postgres needed on the Mac), starts
GSAM and checks health. If the restore or the start fails, it puts the old
database back and starts GSAM on it. When all is well, delete the
`db.before-restore-*` folder. A backup holds the database only: files
(attachments, workspaces) stay as they are, and
`data/instances/default/secrets/master.key` must be the same key as when the
backup was made, so keep a copy of it with any backups taken off the Mac.

Upgrade (a release John has made): build a new package, then
`bash gsam-aura-macos-arm64/install.sh --upgrade`. It makes a backup, keeps the
old code in `~/GSAM-Aura/app.previous` and checks health after.

## Phone and John's access (the owner's choice, off by default)

Both go over the **owner's own** Tailscale account, never Greatstone's tailnet.
First the owner installs Tailscale on the Mac (and the phone) from
tailscale.com/download and signs in to their own account.

Phone:

1. `gsam-aura phone on`. It serves GSAM on
   `https://<mac>.<tailnet>.ts.net:8443` to the owner's tailnet only, allows
   that name and restarts GSAM.
2. Phone: open that address, sign in, Share > Add to Home Screen.
3. `gsam-aura phone off` ends it.

John's access, only if the owner wants it:

1. The owner shares the Mac with John from the Tailscale admin page
   (Machines > the Mac > Share). This shares one machine; John does not join
   the owner's tailnet and the owner does not join John's.
2. In GSAM the owner invites John (Company settings > Members > Invite,
   role Operator) and sends him the link.
3. John opens it (on `https://<mac>.<tailnet>.ts.net:8443`, so `phone on`
   first), makes a log-in, accepts; the owner approves the join request.
4. To end it: remove John in Members and stop the Tailscale share.

The CI smoke test proves steps 2 and 3 on a clean install (invite, log-in with
the invite while public sign-up is closed, approval).

## Telegram (no public URL needed)

GSAM fetches the bot's messages from Telegram itself over the Mac's normal
internet connection. No public address, tunnel or Tailscale Funnel is needed.

1. In Telegram, open @BotFather and send `/newbot`. Give the bot a name and a
   username that ends in `bot`. BotFather replies with a token.
2. In GSAM, add a Telegram connection for the CEO agent John, paste the token
   and press **Connect bot**. The setup screen says "No public URL needed".
3. Send the bot a message from the phone. John replies, and that first
   message finishes the setup.

Messages arrive only while GSAM is running. Messages sent while the Mac is off
wait at Telegram (up to 24 hours) and arrive when GSAM starts again.

Webhook route instead (optional, off by default; only if Everest or John
choose it over long-poll): Tailscale Funnel on the owner's own tailnet makes
**only** `/api/chat-webhooks` public, on port 443; the rest stays private.

1. The owner's one step: in the Tailscale admin page, allow Funnel for the
   tailnet (or open the link `gsam-aura telegram on` prints the first time).
2. `gsam-aura telegram on`. It starts Funnel for that path, sets
   `GSAM_CHAT_WEBHOOK_PUBLIC_URL=https://<mac>.<tailnet>.ts.net` in the
   instance `.env` and restarts GSAM. `gsam-aura telegram off` undoes it.

## Uninstall

`bash ~/GSAM-Aura/app/bin/uninstall.sh` (or `uninstall.sh` in the package),
type `DELETE`. It stops GSAM and removes the log-in item, the app and its Dock
icon, and `~/GSAM-Aura` with all data and backups. `--keep-backups` copies the
backups to `~/GSAM-Aura-backups-<date>` first. It does not remove Tailscale or
sign out of Claude or ChatGPT; do that in those apps if wanted.

## Test

The workflow installs from scratch on a clean Mac, then
`scripts/aura-macos/smoke-test.sh` checks: server healthy in authenticated
mode; the first-run owner page is open and served; nothing readable before
sign-in; after the claim exactly one company, "Aura", with only agent "John",
no secrets, cap 2, one human member; public sign-up closed; the invite flow;
a backup, then `gsam-aura restore` of it (a goal made before the backup comes
back; a change and a goal made after it are gone; a damaged file is refused
with GSAM left running); the log-in item restarts GSAM after `kill -9`; uninstall leaves
nothing behind. It also checks the prebuilt runner is installed and signed,
no developer process runs, and `phone`/`telegram` refuse cleanly without
Tailscale.

A real Mac is still needed (GRE-6100) for: the Dock and the browser page;
Gatekeeper prompts; the Command Line Tools prompt on a Mac without them;
`gsam-aura phone on` from a phone; and, only if the webhook route is chosen,
`gsam-aura telegram on` with Funnel, a Telegram message reaching GSAM, and any
other path on `https://<mac>.<tailnet>.ts.net/` **not** answering from the
internet.
