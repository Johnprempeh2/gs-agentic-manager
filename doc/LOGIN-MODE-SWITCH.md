# Login mode for John's install: run-book

Switch the live install from `local_trusted` (no log-in) to `authenticated` +
`private` (log-in, private network only), and back. GRE-133, design GRE-124
section 1. Owner: Bedrock. John does the switch.

Why:
- The Releases page asks for the password again before release, rollback and
  "Promote to Stable". `local_trusted` has no password, so this check needs
  login mode.
- Login mode also lets John open the app from his phone over Tailscale.

## Rules

- Do the switch like a release: when no agent runs, with this page open.
- No password, token or secret goes into an issue, a commit, a log or this page.
- Only John does the switch. An agent never switches, restarts or edits
  anything under `~/GSAM/`.

## Before you start (all must be true)

1. **The restart works in login mode.** `greatstone-release.sh` asks the live
   server to restart through `POST /api/health/dev-server/restart`. It sends no
   log-in, and in login mode that route needs one. Until the release path sends
   a log-in or token (Keystone, GRE-121), every release from the app fails at
   "restarting". **Do not switch before that fix is in the live release.**
2. The Releases page calls the password re-check for release, rollback and
   promote (GRE-121, GRE-122, GRE-127). The live release must include them.
3. No agent runs. The Releases page or `curl -s localhost:3100/api/health`
   shows the live version, and the dashboard shows no running runs.
4. A fresh backup exists: `~/GSAM/backups/` (the hourly backup, or run one).
5. Tailscale runs on the Mac and on the phone, with the same account.
   `tailscale status` lists both.

## What changes

The whole switch is one file:
`~/GSAM/data/instances/default/.env`. The server reads it at start. The
live install has no `config.json`, so nothing else changes. The way back is to
remove the file.

| Setting | Value | Why |
| --- | --- | --- |
| `GSAM_DEPLOYMENT_MODE` | `authenticated` | log-in required |
| `GSAM_DEPLOYMENT_EXPOSURE` | `private` | private network only; no public URL |
| `GSAM_BIND` | `lan` | listens on all addresses of the Mac, so `localhost` (agents, release scripts) and Tailscale both work |
| `GSAM_ALLOWED_HOSTNAMES` | `<mac>.<tailnet>.ts.net,<tailscale-ip>` | the only extra host names the server answers; every other name gets 403 |
| `BETTER_AUTH_SECRET` | the contents of `secrets/agent-jwt.key` (already in the instance folder) | signs log-in sessions; the server does not start in login mode without it |
| `GSAM_AUTH_DISABLE_SIGN_UP` | `true` (step 5) | nobody else can make an account |

Notes:
- **`lan`, not `tailnet`.** `tailnet` listens only on the Tailscale address.
  Then `localhost:3100` stops working for agents and scripts, and the app does
  not start when Tailscale is off. With `lan`, the host-name check lets only
  `localhost`, `127.0.0.1` and the names above through. Other names get 403,
  and everything needs a log-in.
- **Agents keep working.** Agent API keys and run tokens are checked the same
  way in both modes.
- **Why the agent key file.** When `BETTER_AUTH_SECRET` is set, it also signs
  agent run tokens, in place of `secrets/agent-jwt.key`. With the same value,
  agent run tokens do not change at the switch, or on the way back.

## The switch (about 10 minutes)

Run each step in Terminal on the Mac.

**1. Stop live.** Stop the live server the way you normally do (the
`start-live.sh` process). Check that `curl -s localhost:3100/api/health` gets
no answer.

**2. Write the `.env` file.** Nothing is printed to the screen.

```sh
ENV_FILE=~/GSAM/data/instances/default/.env
TS_NAME="$(tailscale status --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
TS_IP="$(tailscale ip -4 | head -1)"
umask 077
cat > "$ENV_FILE" <<EOF
# Login mode (GRE-133). Remove this file to go back to local_trusted.
GSAM_DEPLOYMENT_MODE=authenticated
GSAM_DEPLOYMENT_EXPOSURE=private
GSAM_BIND=lan
GSAM_ALLOWED_HOSTNAMES=${TS_NAME},${TS_IP}
BETTER_AUTH_SECRET=$(cat ~/GSAM/data/instances/default/secrets/agent-jwt.key)
EOF
chmod 600 "$ENV_FILE"
grep -v SECRET "$ENV_FILE"     # check the values; the secret is not shown
```

**3. Start live:** `~/GSAM/start-live.sh`. Then check:

```sh
curl -s localhost:3100/api/health | python3 -m json.tool | grep -E '"(status|deploymentMode|deploymentExposure|bootstrapStatus)"'
```

Expect `"status": "ok"`, `"deploymentMode": "authenticated"`,
`"deploymentExposure": "private"`.

**4. Make your board log-in.**
Your install already has a board: the built-in `local-board`. So you claim it;
you do not make a new one (`gsam auth bootstrap-ceo` refuses here).

1. Find the one-time claim link in the live log:
   `grep -o 'http[^ ]*/board-claim/[^ ]*' ~/GSAM/logs/live.log | tail -1`.
   If it starts with `http://0.0.0.0:3100`, use `http://localhost:3100`
   instead. Do not paste this link anywhere; it is good until it is used.
2. Open `http://localhost:3100` in your browser and create your account:
   your e-mail, your name and a strong password. Keep the password in your
   password manager. After this step the board is empty; that is normal.
3. In the same browser, open the claim link and press **Claim**.
4. Reload: your companies, issues and agents are back. You are now the
   instance admin and owner of every company, and `local-board` is no longer
   an admin.

**5. Close sign-up.** Stop live, add one line, start live again:

```sh
echo 'GSAM_AUTH_DISABLE_SIGN_UP=true' >> ~/GSAM/data/instances/default/.env
```

**6. Check that it worked** (all must pass):

| Check | How | Expect |
| --- | --- | --- |
| Mode | health, as in step 3 | `authenticated`, `private` |
| Log-in needed | `curl -s -o /dev/null -w '%{http_code}\n' localhost:3100/api/companies` | `401` or `403` |
| Your data | sign in at `http://localhost:3100` | same companies, issues and agents as before |
| Agents run | assign or wake one small task | the run starts, comments as the agent |
| Phone | on the phone, open `http://<mac>.<tailnet>.ts.net:3100` | sign-in page, then the board after sign-in |
| Other names refused | `curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: example.com' localhost:3100/api/health` | `403` |
| Sign-up closed | the sign-in page has no "create account" link | none |
| Password re-check | Releases page: release or roll back | asks for the password first |

If a check fails, go back (below) and say which check failed on the release
issue.

## Forgot the password

There is no "forgot password" e-mail. Set a new password on the Mac:

Live must run (the database is inside it). The new password is typed at a
hidden prompt and never shown. The live database port is `54329` (the
default; the live install has no `config.json`).

```sh
cd ~/GSAM/live/server
read -rs NEW_PW && export NEW_PW        # type the new password, press Enter
HASH=$(node --input-type=module -e 'import { hashPassword } from "better-auth/crypto"; process.stdout.write(await hashPassword(process.env.NEW_PW));')
unset NEW_PW
psql "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip" -v ON_ERROR_STOP=1 -v hash="$HASH" -v email="<your e-mail>" <<'SQL'
UPDATE account SET password = :'hash', updated_at = now()
 WHERE provider_id = 'credential'
   AND user_id = (SELECT id FROM "user" WHERE email = :'email');
DELETE FROM session WHERE user_id = (SELECT id FROM "user" WHERE email = :'email');
SQL
unset HASH
```

Expect `UPDATE 1`. Every device must then sign in again with the new
password. (Tested on a sandbox: the old password got 401 and the new one 200.)
If you are locked out and in a hurry, take the way back below: `local_trusted`
needs no password.

## The way back to `local_trusted`

Tested on a sandbox (GRE-133 pull request): no data lost, and agent keys
still work. When the server starts in `local_trusted`, `local-board` gets its
admin role back, so nobody is locked out.

1. Stop live.
2. Move the file away. Keep it, in case you switch again:
   `mv ~/GSAM/data/instances/default/.env ~/GSAM/data/instances/default/.env.login-mode`
3. Start live: `~/GSAM/start-live.sh`.
4. Check: health shows `"deploymentMode": "local_trusted"`, and
   `http://localhost:3100` opens with no log-in. Wake one small agent task.

Your log-in user stays in the database, but `local_trusted` does not use it.
Phone access stops, because `local_trusted` listens on `localhost` only.

## What the password re-check does

- Release, rollback and "Promote to Stable" each ask for the password. One
  password entry is good for one action, for 5 minutes, on that device.
- 5 wrong passwords lock the re-check for 15 minutes.
- Agents never pass it (403), and a board API key cannot pass it.
- In `local_trusted` the actions stay board only, with no password.
- Code: `server/src/services/release-reauth.ts`; route `POST /api/reauth`.
