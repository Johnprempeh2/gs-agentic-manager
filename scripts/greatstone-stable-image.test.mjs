// Tests for scripts/greatstone-stable-image.sh (GRE-138). docker, curl and gh
// are fakes on PATH that log their arguments; the stable-* tags live in a temp
// git repo with a bare "origin". No image is built and nothing under ~/GSAM is
// read or written.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scriptsDir = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const script = join(scriptsDir, "greatstone-stable-image.sh");
const TAG = "stable-2026-09-29.1";

const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$FAKE_DIR/docker.log"
case "$1" in
  info) exit 0 ;;
  buildx)
    ctx="\${@: -1}"
    [ -f "$ctx/marker.txt" ] && cp "$ctx/marker.txt" "$FAKE_DIR/built-marker.txt"
    for arg in "$@"; do case "$arg" in org.opencontainers.image.revision=*) printf '%s' "\${arg#*=}" >"$FAKE_DIR/image-commit" ;; esac; done
    exit "\${FAKE_BUILD_EXIT:-0}" ;;
  image) [ -f "$FAKE_DIR/image-commit" ] || exit 1; cat "$FAKE_DIR/image-commit"; echo ;;
  run)
    while [ $# -gt 0 ]; do [ "$1" = --env-file ] && cp "$2" "$FAKE_DIR/env-file-copy" && stat -f %Lp "$2" >"$FAKE_DIR/env-file-mode"; shift; done
    echo container-id ;;
  inspect) echo "\${FAKE_RUNNING:-true}" ;;
  logs) echo "fake log line" ;;
  manifest) exit "\${FAKE_MANIFEST_EXIT:-1}" ;;
  push) exit "\${FAKE_PUSH_EXIT:-0}" ;;
  rm) exit 0 ;;
esac
`;
const FAKE_CURL = `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$FAKE_DIR/curl.log"
printf '%s' "$FAKE_HEALTH"
`;
const FAKE_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$FAKE_DIR/gh.log"
[ -n "\${FAKE_VISIBILITY:-}" ] || exit 1
printf '%s\\n' "$FAKE_VISIBILITY"
`;

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "tag.gpgSign=false", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8" }).trim();
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "gs-stable-image-"));
  const fake = join(root, "fake");
  const bin = join(root, "bin");
  const scratch = join(root, "scratch");
  for (const dir of [fake, bin, scratch]) mkdirSync(dir);
  for (const [name, body] of [["docker", FAKE_DOCKER], ["curl", FAKE_CURL], ["gh", FAKE_GH]]) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  execFileSync("git", ["init", "--quiet", "--bare", origin]);
  execFileSync("git", ["init", "--quiet", repo]);
  writeFileSync(join(repo, "marker.txt"), "tagged content\n");
  git(repo, "add", "marker.txt");
  git(repo, "commit", "--quiet", "-m", "first");
  const commit = git(repo, "rev-parse", "HEAD");
  git(repo, "tag", "-a", TAG, "-m", "Client notes");
  git(repo, "tag", "stable-2026-09-29.2");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "--quiet", "origin", "HEAD:refs/heads/main", "--tags");
  // The working tree differs from the tag: the image must not see this.
  writeFileSync(join(repo, "marker.txt"), "uncommitted edit\n");
  return { root, fake, bin, scratch, repo, commit };
}

function run(ctx, args, env = {}) {
  const res = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${ctx.bin}:${process.env.PATH}`,
      HOME: ctx.root,
      FAKE_DIR: ctx.fake,
      GSAM_RELEASE_REPO: ctx.repo,
      GSAM_SCRATCH_DIR: ctx.scratch,
      ...env,
    },
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

const read = (ctx, name) => (existsSync(join(ctx.fake, name)) ? readFileSync(join(ctx.fake, name), "utf8") : "");
const okHealth = (commit) => JSON.stringify({
  status: "ok",
  deploymentMode: "authenticated",
  commit,
  hiddenSettings: ["instance.experimental", "instance.adapters", "instance.plugins", "instance.releases", "instance.access", "instance.environments", "company.secrets", "company.import", "company.export", "company.invites", "instance.general.backupRetention", "instance.general.feedbackDataSharingPreference"],
});

function withRepo(fn) {
  return () => {
    const ctx = setup();
    try {
      fn(ctx);
    } finally {
      rmSync(ctx.root, { recursive: true, force: true });
    }
  };
}

test("refuses anything that is not a stable-* tag", withRepo((ctx) => {
  for (const tag of ["live-2026-09-29.1", "rc-2026-09-29.1", "stable-latest", ""]) {
    const res = run(ctx, ["build", tag]);
    assert.notEqual(res.status, 0, tag);
  }
  assert.match(run(ctx, ["build", "live-2026-09-29.1"]).out, /not a stable-YYYY-MM-DD\.N tag/);
  assert.equal(read(ctx, "docker.log"), "");
}));

test("refuses a lightweight tag and an unknown tag", withRepo((ctx) => {
  assert.match(run(ctx, ["build", "stable-2026-09-29.2"]).out, /lightweight tag/);
  assert.match(run(ctx, ["build", "stable-2026-09-29.9"]).out, /unknown tag/);
}));

test("refuses a tag that origin does not have on the same commit", withRepo((ctx) => {
  git(ctx.repo, "tag", "-a", "stable-2026-09-30.1", "-m", "not pushed");
  assert.match(run(ctx, ["build", "stable-2026-09-30.1"]).out, /origin has stable-2026-09-30\.1 on no commit/);
}));

test("refuses a registry name with a password or a scheme in it", withRepo((ctx) => {
  assert.match(run(ctx, ["build", TAG], { GSAM_IMAGE_REPO: "user:secret@ghcr.io/x/y" }).out, /plain image name/);
  assert.match(run(ctx, ["build", TAG], { GSAM_IMAGE_REPO: "https://ghcr.io/x/y" }).out, /plain image name/);
}));

test("build uses the tag's commit, not the working tree, and tags the image with the stable tag", withRepo((ctx) => {
  const res = run(ctx, ["build", TAG], { GSAM_IMAGE_PLATFORM: "linux/amd64" });
  assert.equal(res.status, 0, res.out);
  const build = read(ctx, "docker.log").split("\n").find((line) => line.startsWith("buildx build"));
  assert.ok(build, read(ctx, "docker.log"));
  assert.match(build, new RegExp(`--tag ghcr\\.io/johnprempeh2/gsam-stable:${TAG.replace(".", "\\.")} `));
  assert.match(build, /--platform linux\/amd64 /);
  assert.match(build, /--target production /);
  assert.match(build, new RegExp(`--build-arg GSAM_BUILD_COMMIT=${ctx.commit} `));
  assert.match(build, new RegExp(`--build-arg GSAM_BUILD_VERSION=${TAG.replace(".", "\\.")} `));
  assert.doesNotMatch(build, /image\.source/, "no source label: it could link the package to the public repo");
  assert.equal(read(ctx, "built-marker.txt"), "tagged content\n");
  assert.deepEqual(readdirSync(ctx.scratch), [], "the build context copy is removed");
}));

test("check starts the image with the Managed settings on 127.0.0.1 and passes on an ok health", withRepo((ctx) => {
  assert.equal(run(ctx, ["build", TAG]).status, 0);
  const res = run(ctx, ["check", TAG], { FAKE_HEALTH: okHealth(ctx.commit), GSAM_IMAGE_CHECK_PORT: "3391" });
  assert.equal(res.status, 0, res.out);
  assert.match(res.out, /check passed/);
  const log = read(ctx, "docker.log");
  assert.match(log, /run --detach --name gs-stable-check-stable-2026-09-29-1 --publish 127\.0\.0\.1:3391:3100 --env-file /);
  assert.match(log, /rm -f gs-stable-check-stable-2026-09-29-1\n[^]*$/, "the container is removed");
  const env = read(ctx, "env-file-copy");
  assert.match(env, /^GSAM_MANAGED_CONFIG=\{"v":1,"mode":"cloud",/m);
  assert.match(env, /^GSAM_HIDDEN_SETTINGS=instance\.experimental,/m);
  assert.match(env, /^BETTER_AUTH_SECRET=[0-9a-f]{64}$/m);
  assert.match(env, /^GSAM_PUBLIC_URL=http:\/\/localhost:3391$/m);
  assert.equal(read(ctx, "env-file-mode").trim(), "600");
  assert.deepEqual(readdirSync(ctx.scratch), [], "the env file with the auth secret is removed");
  assert.match(read(ctx, "curl.log"), /http:\/\/127\.0\.0\.1:3391\/api\/health/);
}));

test("check fails when health reports another commit or misses a hidden setting", withRepo((ctx) => {
  assert.equal(run(ctx, ["build", TAG]).status, 0);
  const wrongCommit = run(ctx, ["check", TAG], { FAKE_HEALTH: okHealth("0".repeat(40)), GSAM_IMAGE_CHECK_PORT: "3392" });
  assert.notEqual(wrongCommit.status, 0);
  assert.match(wrongCommit.out, /commit is 0{40}/);
  const health = JSON.parse(okHealth(ctx.commit));
  health.hiddenSettings = health.hiddenSettings.filter((key) => key !== "instance.releases");
  const missing = run(ctx, ["check", TAG], { FAKE_HEALTH: JSON.stringify(health), GSAM_IMAGE_CHECK_PORT: "3392" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.out, /hidden settings missing: instance\.releases/);
  assert.deepEqual(readdirSync(ctx.scratch), [], "a failed check still removes the env file");
}));

test("check fails with the logs when the container stops", withRepo((ctx) => {
  assert.equal(run(ctx, ["build", TAG]).status, 0);
  const res = run(ctx, ["check", TAG], { FAKE_RUNNING: "false", GSAM_IMAGE_CHECK_PORT: "3393" });
  assert.notEqual(res.status, 0);
  assert.match(res.out, /fake log line[^]*container stopped/);
}));

test("check never uses the live or preview port", withRepo((ctx) => {
  assert.equal(run(ctx, ["build", TAG]).status, 0);
  for (const port of ["3100", "3200"]) {
    assert.match(run(ctx, ["check", TAG], { GSAM_IMAGE_CHECK_PORT: port }).out, /live app or its preview/);
  }
}));

test("check and push refuse an image of another commit", withRepo((ctx) => {
  writeFileSync(join(ctx.fake, "image-commit"), "f".repeat(40));
  assert.match(run(ctx, ["check", TAG]).out, /is commit f{40}, not/);
  assert.match(run(ctx, ["push", TAG]).out, /is commit f{40}, not/);
  assert.doesNotMatch(read(ctx, "docker.log"), /^push /m);
}));

test("push refuses to replace a Stable image already in the registry", withRepo((ctx) => {
  assert.equal(run(ctx, ["build", TAG]).status, 0);
  const res = run(ctx, ["push", TAG], { FAKE_MANIFEST_EXIT: "0" });
  assert.notEqual(res.status, 0);
  assert.match(res.out, /never replaced/);
  assert.doesNotMatch(read(ctx, "docker.log"), /^push /m);
}));

test("push refuses when the package is public, and confirms a private one", withRepo((ctx) => {
  assert.equal(run(ctx, ["build", TAG]).status, 0);
  const pub = run(ctx, ["push", TAG], { FAKE_VISIBILITY: "public" });
  assert.notEqual(pub.status, 0);
  assert.match(pub.out, /PUBLIC/);
  assert.doesNotMatch(read(ctx, "docker.log"), /^push /m);
  const priv = run(ctx, ["push", TAG], { FAKE_VISIBILITY: "private" });
  assert.equal(priv.status, 0, priv.out);
  assert.match(read(ctx, "docker.log"), new RegExp(`^push ghcr\\.io/johnprempeh2/gsam-stable:${TAG.replace(".", "\\.")}$`, "m"));
  assert.match(read(ctx, "gh.log"), /packages\/container\/gsam-stable/);
  assert.match(priv.out, /is private/);
}));

test("push says how to log in when the registry refuses", withRepo((ctx) => {
  assert.equal(run(ctx, ["build", TAG]).status, 0);
  const res = run(ctx, ["push", TAG], { FAKE_PUSH_EXIT: "1" });
  assert.notEqual(res.status, 0);
  assert.match(res.out, /docker login ghcr\.io/);
}));

test("publish builds, checks, then pushes, in that order", withRepo((ctx) => {
  const res = run(ctx, ["publish", TAG], { FAKE_HEALTH: okHealth(ctx.commit), FAKE_VISIBILITY: "private", GSAM_IMAGE_CHECK_PORT: "3394" });
  assert.equal(res.status, 0, res.out);
  const steps = read(ctx, "docker.log").split("\n").map((line) => line.split(" ")[0]).filter((cmd) => ["buildx", "run", "push"].includes(cmd));
  assert.deepEqual(steps, ["buildx", "run", "push"]);
}));

test("publish pushes nothing when the check fails", withRepo((ctx) => {
  const res = run(ctx, ["publish", TAG], { FAKE_RUNNING: "false", GSAM_IMAGE_CHECK_PORT: "3395" });
  assert.notEqual(res.status, 0);
  assert.doesNotMatch(read(ctx, "docker.log"), /^push /m);
}));
