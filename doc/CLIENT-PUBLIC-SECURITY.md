# Client instances on the public internet: security checklist

One client, one instance, one server (`doc/CLIENT-INSTANCES.md`,
`doc/CLIENT-HOSTING.md`). Clients are not technical, so no instance relies on
a private network such as Tailscale for its safety. Every instance must be
safe with its address open to anyone. This page is the checklist to run for
each new client server, and the record of what the app itself does.

## What the app does on its own

| Area | Behaviour |
| --- | --- |
| Sign-in | The existing email and password sign-in (Better Auth). Sign-up is closed; a person joins only through an invite. |
| Rate limit | Better Auth limits sign-in per client address (3 tries every 10 seconds). The address comes from Express's `req.ip`, which follows `TRUST_PROXY`, so a client cannot dodge the limit by sending a made-up `X-Forwarded-For`. |
| Two-step sign-in | Each person can turn it on in Profile: after the password, sign-in asks for a 6-digit code from an authenticator app, or one of ten single-use backup codes. "Do not ask again on this device" lasts 30 days. Wrong codes lock the code step. Turning it off needs the password. |
| Required two-step | An instance admin can require it for everyone (Settings, Security, "Require two-step sign-in for everyone"). A person without it then reaches only sign-in, their own setup and invite links until they turn it on, and nobody can turn it off. The admin must have it on before they can require it. CLI keys count as the person who made them, so a key made earlier stops working too until its owner turns two-step sign-in on. Emails in `GSAM_TWO_STEP_EXEMPT_EMAILS` are left out; `client-instance.sh` puts only the operator log-in there. |
| Lost phone | An owner or admin resets it for someone below their role under Members ("Reset two-step"), when that person belongs to no other organisation; an instance admin for anyone but themselves. The person is signed out everywhere. On the host, `gsam auth reset-two-step --email <email>` does the same for anyone. |
| Lockout | 10 wrong passwords for one account inside 15 minutes lock that account's sign-in for 15 minutes, even with the right password. A good sign-in clears the count. The refusal is the same for real and made-up emails. Counts are kept in the database, keyed by a hash of the email, so a restart does not clear them. |
| Hostnames | In `private` exposure the app answers only its allowed hostnames (403 otherwise). `X-Forwarded-Host` counts only from a trusted proxy, so a direct client cannot claim to be `localhost`. |
| CSRF | Board changes made with a browser session need a same-origin `Origin` or `Referer`. Sign-in cookies are `SameSite=Lax`, `HttpOnly`, and `Secure` on HTTPS. Better Auth checks the origin of every sign-in call. |
| Headers | Every response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Content-Security-Policy: frame-ancestors 'self'`, `Referrer-Policy: strict-origin-when-cross-origin`, no `X-Powered-By`. `Strict-Transport-Security` when the public address is HTTPS. |
| CLI sign-in | Anyone may open a CLI sign-in challenge, so one address may open at most 10 every 10 minutes. |
| Secrets | Each instance has its own auth secret (`.env`, mode 600) and its own secrets master key. Stored secrets are encrypted with it; backups keep them encrypted. |

## Routes anyone can reach

Every API route checks its own caller; a request with no session and no key
is the actor `none`, which those checks refuse. These are reachable without
signing in, by design:

| Route | Protection |
| --- | --- |
| `GET /api/health` | Read only. Shows mode, exposure, commit and whether the instance has its first admin yet. |
| `GET /api/openapi.json` | Read only. Describes the API, no data. |
| `/api/auth/*` (Better Auth) | Rate limit, lockout, origin check. |
| `/api/invites/:token/*` | Token in the link, 20 requests a minute per address. |
| `/api/client-acceptance/:token/*` | 256 bit token in the link. |
| `POST /api/cli-auth/challenges` | Rate limit; a challenge does nothing until a signed-in admin approves it. |
| Chat, email, GitHub and routine webhooks | Provider signature or a secret per hook. |
| Plugin webhooks | Each plugin checks its own signature. Install only plugins you trust. |
| Fleet check-in | Signed messages; only on the fleet hub. |

When adding a route, check the caller in the route. There is no central gate,
so a route without a check is public.

## Checklist for each new client server

Run in order. Tick each line on the client's issue. Lines marked
**(verify)** are checked by `client-instance.sh verify`, which prints a PASS
or FAIL line for each; run it after `public-url.sh` so the HTTPS lines are
checked too.

### Server

- [ ] Server made from `doc/CLIENT-HOSTING.md` ("Set up a server"), in the EU, with provider backups on.
- [ ] `setup-host.sh` ran: firewall allows only SSH, 80 and 443; SSH by key only, no root password; daily security updates on.
- [ ] Nothing else listens publicly: `ss -tlnp` shows the app and its database on 127.0.0.1 only. **(verify** checks the app's own config listens on loopback.**)**
- [ ] The instance runs as user `gsam`, never root.

### Instance

- [ ] Made with `client-instance.sh create --edition managed` (or `managed-plus`), never `internal`.
- [ ] Mode is `authenticated`: `curl -s https://<host>/api/health` shows `"deploymentMode":"authenticated"`. **(verify)**
- [ ] `public-url.sh <code> <host>` ran: HTTPS through Caddy, the hostname allowed, `TRUST_PROXY=loopback` in the instance `.env`. **(verify:** HTTPS address, only that hostname and loopback allowed, `TRUST_PROXY`.**)**
- [ ] `curl -sI http://<host>/` redirects to HTTPS, and `curl -sI https://<host>/` shows `strict-transport-security`. **(verify:** also the frame, type and `X-Powered-By` headers, from loopback and from the public address.**)**
- [ ] A request with another hostname is refused: `curl -sk -H 'Host: other.example' https://<server ip>/api/health` gives 403 (or Caddy's own refusal).
- [ ] Sign-up is closed: `verify` passes ("new sign-ups are refused"). **(verify)**
- [ ] `GSAM_AUTH_RATE_LIMIT_ENABLED` is not set to `false` anywhere. **(verify** reads the instance `.env`; check the systemd unit by hand.**)**

### People and passwords

- [ ] The operator log-in has a long random password kept in Greatstone's password manager, never in an issue, chat or email.
- [ ] The client's first log-in goes to them through an invite, not a password sent by email.
- [ ] Two-step sign-in stays off for the operator log-in: `client-instance.sh` signs in with it for verify, pause and the fleet check-in, and has no phone. It is the one account left out of "Require two-step sign-in" (`GSAM_TWO_STEP_EXEMPT_EMAILS`, set by `client-instance.sh`), so its password must stay long, random and only in the password manager and the host config.
- [ ] The client is asked to turn on two-step sign-in for their own log-in at handover.
- [ ] Once the client's owner has it on, the operator turns on "Require two-step sign-in for everyone" (Settings, Security). The client log-in is not an instance admin, so this is the operator's step.
- [ ] When someone leaves, follow `doc/WHEN-SOMEONE-LEAVES.md`.

### Secrets

- [ ] No key, token or password in this repo, an issue, a pull request or a log.
- [ ] Provider keys (AI, Pipedrive, email) entered in the app's secrets, so they are stored encrypted.
- [ ] The instance `.env` and secrets key file are mode 600, owner `gsam`. **(verify** checks the mode of `.env`, `config.json` and the secrets key, and that the auth secret is the instance's own.**)**

### Backups

- [ ] Hourly app backups are running (`instance-ctl.sh status <code>`).
- [ ] Off-host backups set up (`gsam-offsite@<code>.timer`, GRE-666), to storage the client server cannot delete.
- [ ] `restore-check` has passed once on this server.

### Updates and watching

- [ ] Upgrades only to a Stable tag John has released, with `client-instance.sh upgrade` (`doc/CLIENT-HOSTING.md`, "Upgrade").
- [ ] The public watch probes `https://<host>/api/health` from outside the server, so an expired certificate or DNS fault is noticed.
- [ ] Someone owns reading the security update e-mails for Node, Caddy and Ubuntu.

## Known gaps

- `GET /api/health` shows the exact commit; fine while only Greatstone runs instances, worth trimming before any self-hosted public release.
