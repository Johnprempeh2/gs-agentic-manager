# Run-book: switch John's install to login mode (`authenticated` + `private`)

GRE-125, part of GRE-119. Decided on GRE-124 (proposal rev 2, section 5).

Today John's install runs `local_trusted`: anyone who can reach
`localhost:3100` is the board, and there is no login. Login mode adds one
account for John, with one sign-in per device. It lets the Releases page ask
for the password again (GRE-133), and it lets John's phone reach the app over
Tailscale or the home network.

**John does the live move.** Agents prepare and test it; they never run these
steps on `~/GSAM/`. Do it like a release: when no agent is running.

## What changes and what does not

| | Before | After |
|---|---|---|
| Who is the board | Anyone on this Mac | John, after signing in |
| Browser on the Mac | `http://localhost:3100` | Same address, sign in once |
| Phone | Not possible | `http://<mac-name>:3100` over Tailscale, sign in once |
| Agents | Run keys and agent keys | **The same keys, no change** |
| Where it is set | Nothing set (defaults) | 7 lines in `~/GSAM/data/instances/default/.env` |
| Data | | Kept. Only John's account and the board claim are added |

Side effects to know about:

- **Secrets strict mode is on** in login mode. Existing agents keep running.
  When you *edit* an agent's or project's environment, a sensitive value must
  be a stored secret, not plain text.
- **Deleting a company is off** in login mode (it is on in `local_trusted`).
- The dev runner still prints `dev mode: local_trusted (default)` at start.
  Ignore it; `/api/health` shows the real mode.

## Before you start (gates)

1. **GRE-136 is released.** Until then the release scripts cannot restart live
   or count running agents in login mode, so every release would fail. Do not
   switch before GRE-136 is on live.
2. **This change (GRE-125) is released,** so `~/GSAM/live` has
   `gsam auth mode` and `gsam auth reset-password`. Check:
   `cd ~/GSAM/live && pnpm gsam auth mode --help`.
3. **No agent is running.** The dashboard shows no running agents, and nothing
   is queued to start in the next few minutes.
4. **For the phone:** Tailscale is on for the Mac and the phone. Find the Mac's
   name and address: `tailscale status --self` and `tailscale ip -4`.
   (For the home network instead, use the Mac's `.local` name or LAN address.)

## Steps (about 10 minutes, two restarts)

All commands run in Terminal on the Mac.

**1. Back up the database** (reads only; about a minute).

```sh
cd ~/Desktop/Code/gs-clip
PORT=$(sed -n 4p ~/GSAM/data/instances/default/db/postmaster.pid)
node cli/node_modules/tsx/dist/cli.mjs scripts/greatstone-db.ts backup \
  --source-url "postgres://paperclip:paperclip@127.0.0.1:$PORT/paperclip" \
  --dir ~/GSAM/backups --prefix before-login-mode
```

**2. Switch the setting.** Put your Mac's Tailscale name and address in place of
the examples. The command prints what it set and hides the two secrets.

```sh
cd ~/GSAM/live
pnpm gsam auth mode authenticated --data-dir ~/GSAM/data \
  --allowed-hostname my-mac.tailnet-name.ts.net --allowed-hostname 100.x.y.z
```

This writes `~/GSAM/data/instances/default/.env` (mode 0600) and saves the
previous file as `.env.before-auth-mode-<time>`. It sets:
`GSAM_DEPLOYMENT_MODE=authenticated`, `GSAM_DEPLOYMENT_EXPOSURE=private`,
`GSAM_BIND=lan` (so `localhost` and the Tailscale address both work),
`GSAM_ALLOWED_HOSTNAMES` (`localhost`, `127.0.0.1` and your names),
`GSAM_AUTH_DISABLE_SIGN_UP=false` (open, for step 4 only), a new
`BETTER_AUTH_SECRET`, and `GSAM_AGENT_JWT_SECRET` pinned to the key the
agents already use (without it, the new secret would change every run key).

**3. Restart live** (restart 1 of 2).

```sh
pkill -TERM -f "dev-runner.ts dev --data-dir $HOME/GSAM/data"
while curl -fsS -m 2 http://localhost:3100/api/health >/dev/null 2>&1; do sleep 1; done
~/GSAM/start-live.sh
curl -s http://localhost:3100/api/health | grep -o '"deploymentMode":"[a-z_]*"'
```

The last line must show `"deploymentMode":"authenticated"`.

**4. Create your account (once).** Open `http://localhost:3100`. On the sign-in
page choose **Create one**, enter your name, email and a password (8+
characters), and choose **Create Account**.

**5. Claim the board.** The server printed a one-time link at start:

```sh
grep -a -o 'http://[^ ]*/board-claim/[0-9a-f]*?code=[0-9a-f]*' ~/GSAM/logs/live.log | tail -n 1
```

Open that link in the same browser (you are signed in) and choose
**Claim ownership**.
Your account now owns every company and is the instance admin. The link lasts
24 hours; a restart makes a new one.

**6. Close sign-up, then restart** (restart 2 of 2).

```sh
cd ~/GSAM/live
pnpm gsam auth mode authenticated --data-dir ~/GSAM/data --sign-up closed
pkill -TERM -f "dev-runner.ts dev --data-dir $HOME/GSAM/data"
while curl -fsS -m 2 http://localhost:3100/api/health >/dev/null 2>&1; do sleep 1; done
~/GSAM/start-live.sh
```

**7. Sign in on each device once.** On the Mac, sign in at
`http://localhost:3100`. On the phone (Tailscale on), open
`http://my-mac.tailnet-name.ts.net:3100` and sign in.

## Check it worked

| Check | How | Expected |
|---|---|---|
| Mode | `curl -s http://localhost:3100/api/health` | `"deploymentMode":"authenticated"`, `"deploymentExposure":"private"` |
| Board routes need a login | `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3100/api/companies` | `403` |
| Sign-up is closed | Open `/auth` in a private window, try **Create one** | Refused |
| You are the board | Signed in, open the dashboard and Instance settings | Both load |
| Agents still work | Assign a small task to an agent | The agent runs and comments as itself |
| Phone | Open the Tailscale address on the phone | Sign-in page, then the app |

If any check fails, use the way back below.

## Way back

**Forgot the password.** The server keeps running. You are asked for the new
password twice. Every device is signed out and signs in again.

```sh
cd ~/GSAM/live
pnpm gsam auth reset-password --data-dir ~/GSAM/data --email you@example.com
```

`--generate` makes and prints a password instead. `--password-stdin` reads it
from a pipe.

**Switch back to `local_trusted`.** One command and a restart. Nothing is
deleted: your account stays, and the built-in board user gets its admin role
back at start. Switching to login mode again later needs no new account or
claim.

```sh
cd ~/GSAM/live
pnpm gsam auth mode local_trusted --data-dir ~/GSAM/data
pkill -TERM -f "dev-runner.ts dev --data-dir $HOME/GSAM/data"
while curl -fsS -m 2 http://localhost:3100/api/health >/dev/null 2>&1; do sleep 1; done
~/GSAM/start-live.sh
```

**Undo one edit exactly.** Each `gsam auth mode` run that changes the file
saves the previous one as `.env.before-auth-mode-<time>` in
`~/GSAM/data/instances/default/`. Copy the one you want back over `.env`
and restart.

**The step 1 backup** is a safety copy only. The switch does not change
existing data: it adds your account and moves the admin role, and the switch
back gives the role back. If you ever need the copy, ask Everest to plan the
restore; do not restore by hand while agents run.

## Rehearsal (for agents; never on `~/GSAM/`)

`scripts/auth-switch-sandbox-check.sh` runs every step above on a throwaway
sandbox from a worktree (`pnpm dev:once --data-dir ./tmp/...`, clean
environment, free port). It checks:

- in every mode, a real agent run: the server starts the agent, and the
  agent's own call to the API with its injected run key answers 200;
- `local_trusted` start, with an agent key and a run token working;
- after `gsam auth mode authenticated`: board-only routes refuse a request with
  no session (401/403), the agent key and the run token made *before* the
  switch still work, and an agent key is not a board session;
- sign-up, board claim from the printed link, sign-in, board routes open;
- `--sign-up closed`: a second sign-up is refused, the owner still signs in;
- `gsam auth reset-password`: old session signed out, old password refused,
  new password accepted;
- `gsam auth mode local_trusted`: board routes open with no login, agent key
  and run token still work.

The server test
`server/src/__tests__/auth-switch-authenticated-private.integration.test.ts`
covers the same path in `vitest` against a real Postgres.
