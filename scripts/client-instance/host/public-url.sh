#!/usr/bin/env bash
# Put one client instance on its public HTTPS address (GRE-664).
# Run as root on a hosted server after `create`; see doc/CLIENT-HOSTING.md.
#
#   public-url.sh <code> <hostname>
#
# 1. Sets an explicit base URL https://<hostname> and allows that hostname.
#    Exposure stays "private": the app's "public" exposure is for the shared
#    cloud and refuses the embedded database this install uses. The server
#    still listens on loopback only; Caddy is the one way in. 127.0.0.1 stays
#    allowed, so `verify` and the host watch still work over loopback.
# 2. Writes the Caddy site /etc/caddy/sites/<code>.caddy (HTTPS from Let's
#    Encrypt, proxy to the instance's loopback port) and reloads Caddy.
# 3. Restarts the instance under systemd.
set -euo pipefail

GSAM_HOSTED_ROOT="${GSAM_HOSTED_ROOT:-/srv/gsam}"
die() { echo "public-url: $*" >&2; exit 1; }

[ $# -eq 2 ] || die "usage: public-url.sh <code> <hostname>"
code="$1"
host="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
[[ "$code" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "bad instance code: $code"
[[ "$host" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] || die "bad hostname: $host"
[ "$(id -u)" -eq 0 ] || die "run as root"

root="$GSAM_HOSTED_ROOT/instances/$code"
state="$root/client-instance.json"
config="$root/instances/default/config.json"
[ -f "$state" ] && [ -f "$config" ] || die "no instance at $root"

port="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).port))' "$state")"
[[ "$port" =~ ^[0-9]+$ ]] || die "no port in $state"

# Same owner and mode as create wrote (600, user gsam).
runuser -u gsam -- node -e '
  const fs = require("fs");
  const [file, host] = process.argv.slice(1);
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  c.server.exposure = "private";
  c.server.bind = "loopback";
  c.server.host = "127.0.0.1";
  c.server.allowedHostnames = [host, "127.0.0.1"];
  c.auth = { ...c.auth, baseUrlMode: "explicit", publicBaseUrl: `https://${host}` };
  c.$meta = { ...c.$meta, updatedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
' "$config" "$host"

mkdir -p /etc/caddy/sites
cat >"/etc/caddy/sites/$code.caddy" <<EOF
# Client instance $code (written by public-url.sh)
$host {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$port
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl reload caddy

systemctl enable "gsam-client@$code" >/dev/null 2>&1
systemctl restart "gsam-client@$code"
echo "public-url: $code is on https://$host (loopback port $port)"
