#!/usr/bin/env bash
# Prepare one fresh Ubuntu 24.04 server for client instances (GRE-664,
# Option A: one Hetzner Cloud server per client). Run once as root, from a
# checkout of a stable-* tag; safe to run again. See doc/CLIENT-HOSTING.md.
#
#   setup-host.sh
#
# It does not make an instance, hold a client name, or read any token.
set -euo pipefail

die() { echo "setup-host: $*" >&2; exit 1; }
say() { echo "setup-host: $*"; }

[ "$(id -u)" -eq 0 ] || die "run as root"
. /etc/os-release
[ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = "24.04" ] || die "needs Ubuntu 24.04 (this is ${PRETTY_NAME:-unknown})"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_MAJOR=24

export DEBIAN_FRONTEND=noninteractive

say "packages"
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git lsof ufw restic unattended-upgrades debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]; then
  say "Node $NODE_MAJOR"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" >/etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get install -y -q nodejs
fi
# pnpm at the version the repo pins.
PNPM_VERSION="$(node -e 'process.stdout.write(require(process.argv[1]).packageManager.split("@")[1])' "$HERE/../../../package.json")"
corepack enable
corepack prepare "pnpm@$PNPM_VERSION" --activate

if ! command -v caddy >/dev/null; then
  say "Caddy"
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt >/etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi
# One site file per instance, written by public-url.sh.
install -d -m 0755 /etc/caddy/sites
cat >/etc/caddy/Caddyfile <<'EOF'
# Client instances: one file per instance in /etc/caddy/sites (public-url.sh).
import /etc/caddy/sites/*.caddy
EOF
systemctl enable --now caddy
systemctl reload caddy

say "user gsam and /srv/gsam"
id gsam >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/gsam --shell /usr/sbin/nologin gsam
install -d -o gsam -g gsam -m 0750 /srv/gsam /srv/gsam/instances /srv/gsam/releases
# corepack keeps pnpm per user; give gsam the same pinned version.
runuser -u gsam -- env HOME=/home/gsam COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack prepare "pnpm@$PNPM_VERSION" --activate >/dev/null

say "systemd unit"
install -d -m 0755 /usr/local/lib/gsam
install -m 0755 "$HERE/instance-ctl.sh" /usr/local/lib/gsam/instance-ctl.sh
install -m 0755 "$HERE/public-url.sh" /usr/local/lib/gsam/public-url.sh
install -m 0644 "$HERE/gsam-client@.service" /etc/systemd/system/gsam-client@.service
systemctl daemon-reload

say "reserve instance ports"
# Server ports start at 3300 and database ports at 55400 (client-instance.sh).
# Linux hands out 32768-60999 for outgoing connections, so a closed connection
# can hold a database port for a minute and a restart then fails.
echo "net.ipv4.ip_local_reserved_ports = 3300-3399,55400-55499" >/etc/sysctl.d/60-gsam-ports.conf
sysctl -q --load /etc/sysctl.d/60-gsam-ports.conf

say "firewall: SSH, HTTP (certificates), HTTPS only"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

say "SSH: keys only"
cat >/etc/ssh/sshd_config.d/10-gsam.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -t
systemctl reload ssh

say "security updates every day"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

say "done. Next: clone the stable tag as gsam and create the instance (doc/CLIENT-HOSTING.md)"
