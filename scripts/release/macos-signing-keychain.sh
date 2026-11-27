#!/bin/bash
# Puts a Developer ID certificate into a throwaway keychain so codesign can use it, and prints
# the identity (its SHA-1) on stdout. CI (release-assets.yml, macOS runner) and local tests.
#   MACOS_CERT_P12        base64 of the .p12 (certificate, private key and Apple's intermediate)
#   MACOS_CERT_PASSWORD   the .p12 password
#   scripts/release/macos-signing-keychain.sh <keychain path> [name to match, default "Developer ID Application"]
# The keychain's own password is random and thrown away: it only has to stay unlocked for this job.
set -euo pipefail
keychain=$1; match=${2:-Developer ID Application}
: "${MACOS_CERT_P12:?MACOS_CERT_P12 is not set}" "${MACOS_CERT_PASSWORD:?MACOS_CERT_PASSWORD is not set}"
pass=$(openssl rand -hex 24)
p12=$(mktemp); trap 'rm -f "$p12"' EXIT
printf '%s' "$MACOS_CERT_P12" | base64 --decode > "$p12"
security create-keychain -p "$pass" "$keychain" >&2
security set-keychain-settings -lut 21600 "$keychain" >&2
security unlock-keychain -p "$pass" "$keychain" >&2
security import "$p12" -P "$MACOS_CERT_PASSWORD" -f pkcs12 -k "$keychain" -T /usr/bin/codesign >&2
security set-key-partition-list -S apple-tool:,apple: -s -k "$pass" "$keychain" >/dev/null
# codesign only looks in keychains on the search list: add ours, keep the others.
security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"') >&2
# No -v: a self-signed test certificate is not "valid" to macOS but still signs.
id=$(security find-identity -p codesigning "$keychain" | grep "$match" | head -1 | awk '{print $2}')
[ -n "$id" ] || { echo "no \"$match\" identity in the certificate" >&2; exit 1; }
echo "$id"
