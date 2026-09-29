#!/usr/bin/env bash
# The Docker image of a Stable release, for client installs (GRE-138). See
# "Stable image" in doc/GREATSTONE-WAY-OF-WORKING.md.
#
#   scripts/greatstone-stable-image.sh publish stable-YYYY-MM-DD.N   build, check and push (the one command)
#   scripts/greatstone-stable-image.sh build   stable-YYYY-MM-DD.N   build the image from the tag's commit
#   scripts/greatstone-stable-image.sh check   stable-YYYY-MM-DD.N   start it with Managed settings and check health
#   scripts/greatstone-stable-image.sh push    stable-YYYY-MM-DD.N   push it to the private registry
#
# Run from the dev checkout after Promote to Stable. The image is built from the
# tag's commit only (git archive), never from the working tree, and is tagged
# with the stable-* tag. The check starts it on 127.0.0.1 with a fresh auth
# secret and no volume, so nothing is kept; it never uses port 3100 or 3200 and
# never reads ~/GSAM. A Stable image is pushed once and never replaced.
#
# Settings (environment):
#   GSAM_IMAGE_REPO       image name       (default ghcr.io/johnprempeh2/gsam-stable)
#   GSAM_IMAGE_PLATFORM   build platform   (default this machine: linux/arm64 or linux/amd64)
#   GSAM_IMAGE_TARGET     Dockerfile stage (default production)
#   GSAM_IMAGE_CHECK_PORT host port for the check (default the first free port in 3300-3399)
#   GSAM_IMAGE_CHECK_TIMEOUT  seconds to wait for health (default 300)
#   GSAM_RELEASE_REPO     git repo that holds the stable-* tags (default: this checkout)
#
# Registry log-in is Docker's own (`docker login ghcr.io`, kept in the macOS
# keychain). No password or token is read or written by this script.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/greatstone-common.sh"

die() { printf 'stable-image: %s\n' "$*" >&2; exit 1; }
note() { printf 'stable-image: %s\n' "$*"; }

IMAGE_REPO="${GSAM_IMAGE_REPO:-ghcr.io/johnprempeh2/gsam-stable}"
IMAGE_TARGET="${GSAM_IMAGE_TARGET:-production}"
CHECK_TIMEOUT="${GSAM_IMAGE_CHECK_TIMEOUT:-300}"
FORBIDDEN_CHECK_PORTS=" 3100 3200 "

native_platform() {
  case "$(uname -m)" in
    arm64 | aarch64) printf 'linux/arm64' ;;
    *) printf 'linux/amd64' ;;
  esac
}
IMAGE_PLATFORM="${GSAM_IMAGE_PLATFORM:-$(native_platform)}"

usage() { die "usage: greatstone-stable-image.sh publish|build|check|push <stable-YYYY-MM-DD.N>"; }

COMMAND="${1:-}"
TAG="${2:-}"
case "$COMMAND" in publish | build | check | push) ;; *) usage ;; esac
[[ "$TAG" =~ ^stable-[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+$ ]] || die "\"$TAG\" is not a stable-YYYY-MM-DD.N tag; only a Stable release gets an image"
# A registry password must never ride in the image name (it would show in ps and logs).
case "$IMAGE_REPO" in *@* | *://*) die "GSAM_IMAGE_REPO must be a plain image name such as ghcr.io/owner/name, not $IMAGE_REPO" ;; esac
IMAGE="$IMAGE_REPO:$TAG"

# Removed on every exit: the build context copy, the check container and its env file.
BUILD_CTX=""
CHECK_CONTAINER=""
CHECK_ENV_FILE=""
cleanup() {
  [ -z "$CHECK_CONTAINER" ] || docker rm -f "$CHECK_CONTAINER" >/dev/null 2>&1 || true
  [ -z "$CHECK_ENV_FILE" ] || rm -f "$CHECK_ENV_FILE"
  [ -z "$BUILD_CTX" ] || rm -rf "$BUILD_CTX"
}
trap cleanup EXIT

# The tag's commit. It must be an annotated tag (made by Promote to Stable) and
# origin must have the same tag on the same commit: the image is what clients get.
tag_commit() {
  local type commit remote
  git -C "$RELEASE_REPO" fetch --quiet --tags origin || die "cannot fetch tags from origin in $RELEASE_REPO"
  type="$(git -C "$RELEASE_REPO" cat-file -t "refs/tags/$TAG" 2>/dev/null)" || die "unknown tag $TAG in $RELEASE_REPO"
  [ "$type" = tag ] || die "$TAG is a lightweight tag; a Stable tag is made by Promote to Stable"
  commit="$(git -C "$RELEASE_REPO" rev-parse --verify "refs/tags/$TAG^{commit}")"
  remote="$(git -C "$RELEASE_REPO" ls-remote --tags origin "refs/tags/$TAG^{}" | cut -f1)"
  [ "$remote" = "$commit" ] || die "origin has $TAG on ${remote:-no commit}, not on $commit; push the tag first"
  printf '%s' "$commit"
}

cmd_build() {
  local commit="$1"
  BUILD_CTX="$(mktemp -d "${GSAM_SCRATCH_DIR:-${TMPDIR:-/tmp}}/gs-stable-image.XXXXXX")"
  git -C "$RELEASE_REPO" archive --format=tar "$commit" | tar -x -C "$BUILD_CTX"
  note "building $IMAGE ($IMAGE_PLATFORM, stage $IMAGE_TARGET) from $TAG ($commit)"
  # No org.opencontainers.image.source label: it links the package to the
  # source repository on GitHub, and a package can take on that repository's
  # visibility. The image stays private whatever the repository is.
  docker buildx build \
    --platform "$IMAGE_PLATFORM" \
    --target "$IMAGE_TARGET" \
    --build-arg "GSAM_BUILD_COMMIT=$commit" \
    --build-arg "GSAM_BUILD_VERSION=$TAG" \
    --label "org.opencontainers.image.revision=$commit" \
    --label "org.opencontainers.image.version=$TAG" \
    --label "org.opencontainers.image.title=GS Agentic Manager (Stable)" \
    --tag "$IMAGE" \
    --load \
    "$BUILD_CTX" || die "the image build failed"
  rm -rf "$BUILD_CTX"
  BUILD_CTX=""
  note "built $IMAGE"
}

# The image on this machine must be the tag's commit, whatever built it.
local_image_commit() {
  docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$IMAGE" 2>/dev/null \
    || die "no local image $IMAGE; run: scripts/greatstone-stable-image.sh build $TAG"
}

# Free when nothing answers on 127.0.0.1:<port>.
port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

check_port() {
  local port="${GSAM_IMAGE_CHECK_PORT:-}"
  if [ -n "$port" ]; then
    [[ "$port" =~ ^[0-9]+$ ]] || die "GSAM_IMAGE_CHECK_PORT $port is not a port"
    [[ "$FORBIDDEN_CHECK_PORTS" != *" $port "* ]] || die "port $port is the live app or its preview; pick another GSAM_IMAGE_CHECK_PORT"
    port_free "$port" || die "port $port is in use"
    printf '%s' "$port"
    return
  fi
  for port in $(seq 3300 3399); do
    if port_free "$port"; then printf '%s' "$port"; return; fi
  done
  die "no free port between 3300 and 3399"
}

cmd_check() {
  local commit="$1" port name envfile health got
  got="$(local_image_commit)"
  [ "$got" = "$commit" ] || die "the local $IMAGE is commit ${got:-unknown}, not $TAG ($commit); build it again"
  port="$(check_port)"
  name="gs-stable-check-${TAG//./-}"
  envfile="$(umask 077; mktemp "${GSAM_SCRATCH_DIR:-${TMPDIR:-/tmp}}/gs-stable-env.XXXXXX")"
  CHECK_ENV_FILE="$envfile"
  "$GS_TOOLS_ROOT/scripts/client-instance.sh" edition-env --edition managed >"$envfile" \
    || die "cannot make the Managed settings (client-instance.sh edition-env)"
  {
    printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)"
    printf 'GSAM_PUBLIC_URL=http://localhost:%s\n' "$port"
    printf 'GSAM_TELEMETRY_DISABLED=1\n'
  } >>"$envfile"
  docker rm -f "$name" >/dev/null 2>&1 || true
  CHECK_CONTAINER="$name"
  note "starting $IMAGE with Managed settings on http://127.0.0.1:$port (container $name, no volume)"
  docker run --detach --name "$name" --publish "127.0.0.1:$port:3100" --env-file "$envfile" "$IMAGE" >/dev/null \
    || die "the image did not start"

  local waited=0
  health=""
  while [ "$waited" -lt "$CHECK_TIMEOUT" ]; do
    [ "$(docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null)" = true ] || {
      docker logs --tail 50 "$name" >&2 || true
      die "the container stopped before it was healthy (last log lines above)"
    }
    health="$(curl -fsS --max-time 3 "http://127.0.0.1:$port/api/health" 2>/dev/null || true)"
    if [ -n "$health" ] && [ "$(node -e 'try { console.log(JSON.parse(process.argv[1]).status) } catch { console.log("") }' "$health")" = ok ]; then
      break
    fi
    health=""
    sleep 2
    waited=$((waited + 2))
  done
  if [ -z "$health" ]; then
    docker logs --tail 50 "$name" >&2 || true
    die "no ok health within ${CHECK_TIMEOUT}s (last log lines above)"
  fi

  # Health is ok; now it must be this commit, in login mode, with the Managed hidden settings.
  local hidden
  hidden="$(sed -n 's/^GSAM_HIDDEN_SETTINGS=//p' "$envfile")"
  node -e '
    const [body, commit, hidden] = process.argv.slice(1);
    const h = JSON.parse(body);
    const problems = [];
    if (h.commit !== commit) problems.push(`commit is ${h.commit}, not ${commit}`);
    if (h.deploymentMode !== undefined && h.deploymentMode !== "authenticated") problems.push(`mode is ${h.deploymentMode}, not authenticated`);
    const shown = new Set(Array.isArray(h.hiddenSettings) ? h.hiddenSettings : []);
    const missing = hidden.split(",").filter((key) => key && !key.endsWith(".*") && !shown.has(key));
    if (missing.length) problems.push(`hidden settings missing: ${missing.join(", ")}`);
    if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
    console.log(`health ok: commit ${h.commit}, mode ${h.deploymentMode ?? "(not shown)"}, ${shown.size} hidden settings`);
  ' "$health" "$commit" "$hidden" || die "the health answer does not match the Managed settings (see above)"
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -f "$envfile"
  CHECK_CONTAINER=""
  CHECK_ENV_FILE=""
  note "check passed for $IMAGE"
}

# ghcr.io only: the package visibility, or "" when it cannot be read (no
# package yet, or gh has no read:packages scope).
ghcr_visibility() {
  case "$IMAGE_REPO" in ghcr.io/*/*) ;; *) return 0 ;; esac
  local rest owner package
  rest="${IMAGE_REPO#ghcr.io/}"
  owner="${rest%%/*}"
  package="${rest#*/}"
  gh api "/users/$owner/packages/container/${package//\//%2F}" --jq .visibility 2>/dev/null || true
}

cmd_push() {
  local commit="$1" got visibility
  got="$(local_image_commit)"
  [ "$got" = "$commit" ] || die "the local $IMAGE is commit ${got:-unknown}, not $TAG ($commit); build and check it again"
  if docker manifest inspect "$IMAGE" >/dev/null 2>&1; then
    die "$IMAGE is already in the registry; a Stable image is never replaced"
  fi
  visibility="$(ghcr_visibility)"
  [ "$visibility" != public ] || die "the package $IMAGE_REPO is PUBLIC; make it private on GitHub (Package settings, Change visibility) before any push"
  note "pushing $IMAGE"
  docker push "$IMAGE" || die "the push failed; log in once with: docker login ${IMAGE_REPO%%/*}"
  visibility="$(ghcr_visibility)"
  case "$visibility" in
    private) note "the package $IMAGE_REPO is private" ;;
    public) die "the package $IMAGE_REPO is PUBLIC; make it private on GitHub now (Package settings, Change visibility)" ;;
    *) note "could not read the package visibility (gh needs the read:packages scope: gh auth refresh -s read:packages); confirm on GitHub that $IMAGE_REPO is private" ;;
  esac
  note "pushed $IMAGE"
}

command -v docker >/dev/null 2>&1 || die "docker is not installed"
docker info >/dev/null 2>&1 || die "Docker is not running; start Docker Desktop and run this again"
COMMIT="$(tag_commit)"
case "$COMMAND" in
  build) cmd_build "$COMMIT" ;;
  check) cmd_check "$COMMIT" ;;
  push) cmd_push "$COMMIT" ;;
  publish)
    cmd_build "$COMMIT"
    cmd_check "$COMMIT"
    cmd_push "$COMMIT"
    ;;
esac
