#!/usr/bin/env bash
# Builds the Aura macOS install package (GRE-6097). See doc/AURA-MAC-INSTALL.md.
#
# Runs on a Mac (the GitHub Actions macOS runner): the embedded database and
# the Claude and Codex sign-in tools are native, so the package is built on
# the CPU it is for. Run from the repository root after
# `pnpm install --frozen-lockfile`:
#
#   scripts/aura-macos/build-package.sh <out dir>
#
# Env: AURA_FEATURE_REQUEST_ADDRESS (written into John's instructions),
# NODE_VERSION (default: the Node running this script).
#
# The package holds code and tools only: no data, no log-ins, no keys.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$(mkdir -p "${1:?usage: build-package.sh <out dir>}" && cd "$1" && pwd)"
[ "$(uname -s)" = "Darwin" ] || { echo "build-package: build on macOS (the native parts must match the Mac)" >&2; exit 1; }
case "$(uname -m)" in
  arm64) NODE_ARCH=arm64 ;;
  x86_64) NODE_ARCH=x64 ;;
  *) echo "build-package: unknown CPU $(uname -m)" >&2; exit 1 ;;
esac
NODE_VERSION="${NODE_VERSION:-$(node -p process.versions.node)}"
NAME="gsam-aura-macos-${NODE_ARCH}"
STAGE="$OUT/$NAME"
WORK="$OUT/.work"
rm -rf "$STAGE" "$WORK"
mkdir -p "$STAGE/app/bin" "$WORK"
cd "$ROOT"

echo "==> 1/7 CLI and server build"
bash scripts/build-npm.sh --skip-checks --skip-typecheck
pnpm -r --filter "@greatstone/server..." --if-present run build
# The server is packed as a bundled package, so its prepack hook (which
# copies the web UI into server/ui-dist) does not run. Do it here, and copy
# the bundled skills in, as scripts/release.sh does.
SKILL_PKGS="server packages/adapters/claude-local packages/adapters/codex-local"
bash scripts/prepare-server-ui-dist.sh
for pkg_dir in $SKILL_PKGS; do
  rm -rf "$pkg_dir/skills"
  cp -R skills "$pkg_dir/skills"
done

echo "==> 2/7 app payload"
node scripts/aura-macos/pack-payload.mjs "$STAGE/app/payload" "$WORK/pack"
rm -rf server/ui-dist
for pkg_dir in $SKILL_PKGS; do rm -rf "$pkg_dir/skills"; done

echo "==> 3/7 Node $NODE_VERSION ($NODE_ARCH)"
NODE_TGZ="node-v${NODE_VERSION}-darwin-${NODE_ARCH}.tar.gz"
curl -fsSL -o "$WORK/$NODE_TGZ" "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TGZ}"
curl -fsSL -o "$WORK/SHASUMS256.txt" "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
(cd "$WORK" && grep " ${NODE_TGZ}\$" SHASUMS256.txt | shasum -a 256 -c -)
mkdir -p "$STAGE/app/node"
tar -xzf "$WORK/$NODE_TGZ" -C "$STAGE/app/node" --strip-components=1
rm -rf "$STAGE/app/node/include" "$STAGE/app/node/share"

echo "==> 4/7 sign-in tools (Claude Code, Codex)"
# The app runs `claude setup-token` and `codex login --device-auth` when the
# owner links their own subscriptions. Nothing is signed in here.
mkdir -p "$STAGE/app/tools"
PATH="$STAGE/app/node/bin:$PATH" npm install --prefix "$STAGE/app/tools" --no-audit --no-fund \
  @anthropic-ai/claude-code@latest @openai/codex@latest
for tool in claude codex; do
  ln -sf "../tools/node_modules/.bin/$tool" "$STAGE/app/bin/$tool"
  PATH="$STAGE/app/node/bin:$PATH" "$STAGE/app/bin/$tool" --version
done

echo "==> 5/7 Aura template"
ADDRESS="${AURA_FEATURE_REQUEST_ADDRESS:-}"
if [ -d scripts/client-instance/templates/aura ]; then
  [ -n "$ADDRESS" ] || { echo "build-package: set AURA_FEATURE_REQUEST_ADDRESS (GRE-6099)" >&2; exit 1; }
  node cli/node_modules/tsx/dist/cli.mjs scripts/aura-macos/prepare-template.ts "$STAGE/app/template/aura" "$ADDRESS"
else
  echo "no template in this checkout: the installer makes an empty company \"Aura\""
fi

echo "==> 6/7 installer files"
cp scripts/aura-macos/package/install.sh scripts/aura-macos/package/uninstall.sh "$STAGE/"
cp scripts/aura-macos/package/gsam-aura "$STAGE/app/bin/gsam-aura"
cp scripts/aura-macos/package/restore-db.mjs "$STAGE/app/bin/restore-db.mjs"
cp scripts/aura-macos/package/uninstall.sh "$STAGE/app/bin/uninstall.sh"
cp scripts/aura-macos/package/README.txt "$STAGE/README.txt"
chmod 755 "$STAGE/install.sh" "$STAGE/uninstall.sh" "$STAGE/app/bin/gsam-aura" "$STAGE/app/bin/uninstall.sh"
GSAM_VERSION="$(node -p 'require("./cli/package.json").version')"
tool_version() { node -p "require('$STAGE/app/tools/node_modules/$1/package.json').version"; }
cat > "$STAGE/manifest.json" <<EOF
{
  "package": "$NAME",
  "gsamVersion": "$GSAM_VERSION",
  "commit": "$(git rev-parse HEAD)",
  "node": "$NODE_VERSION",
  "cpu": "$NODE_ARCH",
  "claudeCode": "$(tool_version @anthropic-ai/claude-code)",
  "codex": "$(tool_version @openai/codex)",
  "template": $([ -d "$STAGE/app/template/aura" ] && echo '"aura"' || echo null),
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo "==> 7/7 contents check and file list"
bash scripts/aura-macos/check-package.sh "$STAGE" "$ADDRESS"
(cd "$OUT" && find "$NAME" -type f -o -type l | LC_ALL=C sort > "$OUT/$NAME-FILES.txt")
(cd "$STAGE" && du -sk app/node app/payload app/tools app/template app/bin 2>/dev/null) > "$OUT/$NAME-SIZES.txt"
(cd "$OUT" && tar -czf "$NAME.tar.gz" "$NAME" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
rm -rf "$WORK"
echo "package: $OUT/$NAME.tar.gz ($(wc -l < "$OUT/$NAME-FILES.txt" | tr -d ' ') files)"
