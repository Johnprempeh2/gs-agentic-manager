# Client instances on a hosted server: run-book

Option A of "Client hosting options" (GRE-664, approved by John 4 Oct 2026):
one cloud server per client, Ubuntu 24.04, one client instance on it, HTTPS
through Caddy. Owner: Bedrock. The instance itself is made and run by
`scripts/client-instance.sh` exactly as in `doc/CLIENT-INSTANCES.md`; this
page adds only what a server needs.

Files: `scripts/client-instance/host/`.

| File | What |
| --- | --- |
| `setup-host.sh` | Prepares a fresh server once: Node 24, pnpm, git, lsof, restic, Caddy, user `gsam`, `/srv/gsam`, firewall, SSH keys only, daily security updates, reserved instance ports. Safe to run again. |
| `gsam-client@.service` | systemd unit, one per instance code: starts at boot, restarts on failure. |
| `instance-ctl.sh` | What the unit runs: `start`, `stop`, `status`, `verify` from the release folder the instance last started from. |
| `public-url.sh` | Puts an instance on `https://<hostname>`: app config, Caddy site, restart under systemd. |

## Rules

- All rules of `doc/CLIENT-INSTANCES.md` apply. Sandbox data only until John
  names the first client on an issue.
- Use a code (`c001`), never a client name, for the instance folder, the unit
  and the hostname.
- No token, password or key goes into this repo, an issue or a log. The
  Hetzner API token, the deploy key and the log-ins are given outside the app.

## Layout on the server

| Path | What |
| --- | --- |
| `/srv/gsam/releases/<stable tag>` | one clone per release (owner `gsam`) |
| `/srv/gsam/instances/<code>` | the instance folder (`<root>` in the run-book) |
| `/etc/caddy/sites/<code>.caddy` | the HTTPS site for that instance |
| `/usr/local/lib/gsam/` | `instance-ctl.sh`, `public-url.sh` |

The server listens on 127.0.0.1 only. Caddy is the one way in (ports 80 and
443). The firewall allows SSH, 80 and 443.

## Set up a server

1. Make the server (Hetzner Cloud CX43, Ubuntu 24.04, EU) in Greatstone's
   project, with our SSH key and backups on. Point `<code>.<client domain>`
   (an A record) at its IPv4 address.
2. Copy the read-only deploy key (given outside the app) to the server as
   `/root/.ssh/gsam_deploy`, mode 0600.
3. As root on the server, clone the Stable tag into a temporary folder and run
   the setup from there. `setup-host.sh` makes user `gsam` and `/srv/gsam`, so
   nothing can be owned by `gsam` before it runs:

   ```sh
   TAG=<stable tag>
   apt-get install -y -q git
   SETUP="$(mktemp -d)"
   GIT_SSH_COMMAND="ssh -i /root/.ssh/gsam_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
     git clone --depth 1 --branch "$TAG" <repo url> "$SETUP/gsam"
   "$SETUP/gsam/scripts/client-instance/host/setup-host.sh"
   rm -rf "$SETUP"
   ```

4. Give the deploy key to `gsam` (its default key, so `upgrade` can fetch new
   tags too), remove root's copy, and clone the release as `gsam`:

   ```sh
   install -d -o gsam -g gsam -m 0700 /home/gsam/.ssh
   install -o gsam -g gsam -m 0600 /root/.ssh/gsam_deploy /home/gsam/.ssh/id_ed25519
   rm /root/.ssh/gsam_deploy
   runuser -u gsam -- env HOME=/home/gsam GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new" \
     git clone --branch "$TAG" <repo url> "/srv/gsam/releases/$TAG"
   runuser -u gsam -- git -C "/srv/gsam/releases/$TAG" remote set-url --push origin DISABLED
   runuser -u gsam -- env HOME=/home/gsam bash -c "cd /srv/gsam/releases/$TAG && pnpm install --frozen-lockfile && pnpm --filter @greatstone/plugin-sdk build && pnpm --filter @greatstone/ui build"
   ```

## Make the instance

As `gsam`, with a clean environment, from the release folder:

```sh
sudo -u gsam env -i HOME=/home/gsam USER=gsam LOGNAME=gsam LANG=C.UTF-8 PATH=/usr/local/bin:/usr/bin:/bin \
  "/srv/gsam/releases/$TAG/scripts/client-instance.sh" create --root /srv/gsam/instances/<code> --edition managed
```

Give the two log-ins it prints to John (run-book, "Start a new instance").
`create` leaves the server running outside systemd. Then, as root:

```sh
/usr/local/lib/gsam/public-url.sh <code> <code>.<client domain>
```

It sets the app's base URL to `https://<hostname>` and allows that hostname
(plus 127.0.0.1, so `verify` still works), writes the Caddy site, enables the
unit and restarts the instance under it. Caddy gets the certificate on the
first request. Check:

```sh
systemctl status gsam-client@<code>
sudo -u gsam /usr/local/lib/gsam/instance-ctl.sh verify <code>
curl -sI https://<code>.<client domain>/api/health
```

Exposure stays `private`. The app's `public` exposure is for the shared
cloud: it refuses the embedded database this install uses (GRE-664 found
this on 4 Oct). With `private`, the app refuses any hostname that is not
allowed (403) and any sign-in from another origin.

## Start, stop, status

```sh
systemctl start|stop|restart gsam-client@<code>
sudo -u gsam /usr/local/lib/gsam/instance-ctl.sh status <code>
journalctl -u gsam-client@<code>       # the unit
less /srv/gsam/instances/<code>/server.log   # the server
```

Do not use `client-instance.sh start` or `stop` directly on a hosted server
except as part of `upgrade` (below): systemd then loses track of the server.

## Back up and restore

As in the run-book: hourly app backups in the instance folder, `backup`,
`restore-check`. Off-host backups and the host watch are GRE-666 (Ridge).

## Upgrade

After John promotes a Stable release, and with his go-ahead on the issue for
a real client:

```sh
sudo -u gsam env -i HOME=/home/gsam USER=gsam LOGNAME=gsam LANG=C.UTF-8 PATH=/usr/local/bin:/usr/bin:/bin \
  "/srv/gsam/releases/<old tag>/scripts/client-instance.sh" upgrade /srv/gsam/instances/<code> <new tag> \
  --releases /srv/gsam/releases
systemctl restart gsam-client@<code>
```

Always pass `--releases /srv/gsam/releases`: `instance-ctl.sh` starts only
from a folder under it. `upgrade` starts the new release outside systemd;
the restart stops that server and starts it again under the unit, from the
new release folder (it is recorded in `client-instance.json`). Then run
`verify`. Run `setup-host.sh` from the new release folder too, in case the
host files changed.

## Stop for good

```sh
systemctl disable --now gsam-client@<code>
rm /etc/caddy/sites/<code>.caddy && systemctl reload caddy
```

Keep the instance folder and its backups until John says what happens to the
client's data.
