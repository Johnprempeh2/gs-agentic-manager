#!/usr/bin/env bash
# Install GS Agentic Manager on a Mac from a GitHub Release of this repo.
#
# The release carries a prebuilt bundle (its own Node runtime, built server and
# runner), so the Mac needs no Node, pnpm, Xcode command line tools or Rust.
# This script only downloads the bundle, checks its SHA-256 and hands over to
# the bundle's own setup.sh, which sets GSAM to start on login, makes the
# desktop shortcut and opens the first-run screen.
set -euo pipefail

GSAM_REPO="Johnprempeh2/gs-agentic-manager"
RELEASES_URL="https://github.com/$GSAM_REPO/releases"
BUNDLE_ASSET="gsam-macos-arm64.tar.gz"

VERSION=""
BUNDLE_FILE=""
NO_PROMPT=0
DRY_RUN=0
TEMP_DIR=""

usage() {
  cat <<EOF
Install GS Agentic Manager on a Mac with Apple silicon.

Most people should download the installer package instead:
  $RELEASES_URL/latest

Usage:
  curl -fsSLO https://raw.githubusercontent.com/$GSAM_REPO/main/scripts/install.sh
  bash install.sh [options]

Options:
  --version <tag>          Install this release tag (default: the latest release)
  --file <path>            Install a bundle you already downloaded ($BUNDLE_ASSET)
  --no-prompt              Do not ask before running setup
  --dry-run                Print the plan without changing anything
  -h, --help               Show this help

To run GS Agentic Manager from a source checkout instead, see the README.
EOF
}

log() {
  printf '[gsam] %s\n' "$*"
}

fail() {
  printf '[gsam] error: %s\n' "$*" >&2
  exit 1
}

require_value() {
  [ -n "${2:-}" ] || fail "$1 requires a value"
}

cleanup() {
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
  fi
}

trap cleanup EXIT

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      require_value "$1" "${2:-}"
      VERSION="$2"
      shift 2
      ;;
    --file)
      require_value "$1" "${2:-}"
      BUNDLE_FILE="$2"
      shift 2
      ;;
    --no-prompt)
      NO_PROMPT=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

if [ -n "$VERSION" ] && [ -n "$BUNDLE_FILE" ]; then
  fail "--version and --file cannot be used together"
fi

OS="$(uname -s 2>/dev/null || true)"
ARCH="$(uname -m 2>/dev/null || true)"
[ "$OS" = "Darwin" ] || fail "this installer is for macOS only. On Linux or WSL2, run GS Agentic Manager from a source checkout (see the README)."
[ "$ARCH" = "arm64" ] || fail "this installer is for Macs with Apple silicon (arm64); this Mac is ${ARCH:-unknown}."

if [ -n "$VERSION" ]; then
  DOWNLOAD_BASE="$RELEASES_URL/download/$VERSION"
else
  DOWNLOAD_BASE="$RELEASES_URL/latest/download"
fi

if [ "$DRY_RUN" = "1" ]; then
  if [ -n "$BUNDLE_FILE" ]; then
    log "Would check and unpack $BUNDLE_FILE"
  else
    log "Would download $DOWNLOAD_BASE/$BUNDLE_ASSET and its .sha256"
  fi
  log "Would run setup.sh from the bundle"
  exit 0
fi

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gsam-install.XXXXXX")"

if [ -z "$BUNDLE_FILE" ]; then
  BUNDLE_FILE="$TEMP_DIR/$BUNDLE_ASSET"
  log "Downloading $DOWNLOAD_BASE/$BUNDLE_ASSET"
  curl --proto '=https' --tlsv1.2 -fL --progress-bar "$DOWNLOAD_BASE/$BUNDLE_ASSET" -o "$BUNDLE_FILE" ||
    fail "download failed. Check the release at $RELEASES_URL"
  curl --proto '=https' --tlsv1.2 -fsSL "$DOWNLOAD_BASE/$BUNDLE_ASSET.sha256" -o "$BUNDLE_FILE.sha256" ||
    fail "could not download the checksum for $BUNDLE_ASSET"
fi

[ -s "$BUNDLE_FILE" ] || fail "bundle not found or empty: $BUNDLE_FILE"

if [ -f "$BUNDLE_FILE.sha256" ]; then
  expected_sha256="$(awk '{print $1; exit}' "$BUNDLE_FILE.sha256")"
  actual_sha256="$(shasum -a 256 "$BUNDLE_FILE" | awk '{print $1}')"
  [ "$actual_sha256" = "$expected_sha256" ] || fail "checksum mismatch for $BUNDLE_FILE"
  log "Checksum OK"
else
  log "No $BUNDLE_FILE.sha256 next to the bundle; skipping the checksum"
fi

mkdir -p "$TEMP_DIR/bundle"
tar -xzf "$BUNDLE_FILE" -C "$TEMP_DIR/bundle"
SETUP="$(find "$TEMP_DIR/bundle" -maxdepth 2 -name setup.sh -type f | head -n 1)"
[ -n "$SETUP" ] || fail "the bundle has no setup.sh"

if [ "$NO_PROMPT" != "1" ]; then
  printf '[gsam] Install GS Agentic Manager for user %s? [y/N] ' "$(id -un)" >/dev/tty
  IFS= read -r answer </dev/tty || answer=""
  case "$answer" in
    y|Y|yes|YES|Yes) ;;
    *) fail "installation cancelled" ;;
  esac
fi

log "Running setup"
bash "$SETUP"
