// Pre-flight against real git repositories in a temp folder (GRE-121): an
// "origin" bare repo and a release repo cloned from it. Nothing under ~/GSAM
// is read or written; greatstone-preview.sh runs with GSAM_ROOT in the sandbox.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkReleaseRepo,
  checkReleaseTarget,
  clientNotesProblem,
  createStableTag,
  deleteUnpushedTag,
  nextCandidateTagName,
  nextStableTagName,
  prepareReleaseRepo,
  readReleaseTags,
  resolveReleaseRepo,
} from "../services/release-repo.ts";

const SCRIPTS_DIR = path.resolve(__dirname, "../../../scripts");
let root: string;
let origin: string;
let repo: string;

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function configure(dir: string) {
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"], ["tag.gpgsign", "false"]]) git(dir, "config", k, v);
}

function commit(dir: string, file: string, message: string) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), `${message}\n`);
  git(dir, "add", file);
  git(dir, "commit", "--quiet", "-m", message);
}

/** A clone of origin that pushes one more commit to main. */
function pushFromElsewhere(message: string) {
  const other = path.join(root, `other-${Math.random().toString(16).slice(2)}`);
  git(root, "clone", "--quiet", origin, other);
  configure(other);
  commit(other, `${message}.txt`, message);
  git(other, "push", "--quiet", "origin", "main");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "release-repo-"));
  origin = path.join(root, "origin.git");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  repo = path.join(root, "dev");
  git(root, "clone", "--quiet", origin, repo);
  git(repo, "checkout", "--quiet", "-b", "main");
  configure(repo);
  for (const file of ["greatstone-release.sh", "greatstone-live-release.sh", "greatstone-common.sh", "greatstone-candidate.mjs"]) {
    fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(repo, "scripts", file), "#!/bin/sh\n", { mode: 0o755 });
  }
  git(repo, "add", "scripts");
  git(repo, "commit", "--quiet", "-m", "start");
  git(repo, "tag", "-a", "live-2026-09-01.1", "-m", "Old release");
  git(repo, "tag", "live-2026-08-01.1"); // lightweight, like the oldest live tags
  commit(repo, "feature.txt", "feature");
  git(repo, "tag", "-a", "rc-2026-09-02.1", "-m", "Releases page\n\nFeatures\n- Releases page (#51, GRE-121)");
  git(repo, "tag", "rc-2026-09-02.2");
  git(repo, "tag", "-a", "rc-2026-09-02.3", "-m", "Release candidate rc-2026-09-02.3");
  git(repo, "push", "--quiet", "origin", "main", "--tags");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function timed<T>(work: () => Promise<T>) {
  const started = Date.now();
  const value = await work();
  expect(Date.now() - started).toBeLessThan(5_000);
  return value;
}

describe("prepareReleaseRepo", () => {
  it("fetches and fast-forwards a clean main to origin/main", async () => {
    pushFromElsewhere("merged-later");
    const before = git(repo, "rev-parse", "HEAD");
    const result = await timed(() => prepareReleaseRepo(repo));
    const after = git(repo, "rev-parse", "HEAD");
    expect(after).not.toBe(before);
    expect(result).toEqual({ ok: true, mainCommit: after });
  });

  it("refuses a repo with local changes and leaves it as it is", async () => {
    pushFromElsewhere("merged-later");
    fs.writeFileSync(path.join(repo, "feature.txt"), "edited\n");
    const before = git(repo, "rev-parse", "HEAD");
    const result = await timed(() => prepareReleaseRepo(repo));
    expect(result).toEqual({ ok: false, reason: `the release repo ${repo} has local changes (feature.txt); commit or discard them first` });
    expect(git(repo, "rev-parse", "HEAD")).toBe(before);
  });

  it("refuses a main that has diverged from origin/main (ff-only)", async () => {
    pushFromElsewhere("merged-later");
    commit(repo, "local.txt", "local only");
    const before = git(repo, "rev-parse", "HEAD");
    const result = await timed(() => prepareReleaseRepo(repo));
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/has commits that are not on origin\/main, so it cannot fast-forward/) });
    expect(git(repo, "rev-parse", "HEAD")).toBe(before);
  });

  it("refuses a branch other than main", async () => {
    git(repo, "checkout", "--quiet", "-b", "GRE-1-work");
    expect(await timed(() => prepareReleaseRepo(repo))).toMatchObject({ ok: false, reason: expect.stringMatching(/is on GRE-1-work, not main/) });
  });

  it("refuses a missing repo, a folder that is not git, and scripts that cannot run", async () => {
    expect(await prepareReleaseRepo(null)).toMatchObject({ ok: false, reason: expect.stringMatching(/^no release repo is set/) });
    expect(await prepareReleaseRepo(path.join(root, "nope"))).toMatchObject({ ok: false, reason: expect.stringMatching(/does not exist/) });
    fs.mkdirSync(path.join(root, "plain"));
    expect(await prepareReleaseRepo(path.join(root, "plain"))).toMatchObject({ ok: false, reason: expect.stringMatching(/is not a git repository/) });
    fs.chmodSync(path.join(repo, "scripts", "greatstone-live-release.sh"), 0o644);
    expect(await prepareReleaseRepo(repo)).toMatchObject({ ok: false, reason: "scripts/greatstone-live-release.sh in the release repo is not executable" });
  });

  it("answers within seconds when origin cannot be reached", async () => {
    git(repo, "remote", "set-url", "origin", path.join(root, "gone.git"));
    expect(await timed(() => prepareReleaseRepo(repo))).toMatchObject({ ok: false, reason: expect.stringMatching(/^could not fetch from origin/) });
  });
});

describe("checkReleaseTarget", () => {
  it("accepts an rc tag with a title on origin/main", async () => {
    await prepareReleaseRepo(repo);
    expect(await checkReleaseTarget({ repo, kind: "release", tag: "rc-2026-09-02.1", liveCommit: null })).toEqual({
      ok: true,
      targetCommit: git(repo, "rev-parse", "rc-2026-09-02.1^{commit}"),
      title: "Releases page",
    });
  });

  it("refuses an unknown tag, a tag without a title, and the live commit", async () => {
    const check = (tag: string, liveCommit: string | null = null) => checkReleaseTarget({ repo, kind: "release", tag, liveCommit });
    expect(await check("rc-2026-09-09.1")).toEqual({ ok: false, reason: "tag rc-2026-09-09.1 does not exist" });
    expect(await check("rc-2026-09-02.2")).toMatchObject({ ok: false, reason: expect.stringMatching(/lightweight tag/) });
    expect(await check("rc-2026-09-02.3")).toMatchObject({ ok: false, reason: expect.stringMatching(/has no title/) });
    expect(await check("rc-2026-09-02.1", git(repo, "rev-parse", "HEAD"))).toEqual({ ok: false, reason: "live is already on rc-2026-09-02.1; nothing to do" });
  });

  it("rolls back to any earlier live tag, lightweight ones too", async () => {
    const live = git(repo, "rev-parse", "HEAD");
    expect(await checkReleaseTarget({ repo, kind: "rollback", tag: "live-2026-08-01.1", liveCommit: live })).toMatchObject({ ok: true, title: null });
    expect(await checkReleaseRepo({ repo, kind: "rollback", tag: "live-2026-09-01.1", liveCommit: live })).toMatchObject({ ok: true, title: "Old release" });
  });

  it("names the next free rc tag of the day", async () => {
    expect(await nextCandidateTagName(repo, new Date(2026, 8, 2, 12))).toBe("rc-2026-09-02.4");
    expect(await nextCandidateTagName(repo, new Date(2026, 8, 3, 12))).toBe("rc-2026-09-03.1");
  });
});

describe("stable tags (GRE-127)", () => {
  it("adds an annotated stable tag on the live commit, with the notes as message, and pushes it", async () => {
    const liveCommit = git(repo, "rev-parse", "live-2026-09-01.1^{commit}");
    const tag = await nextStableTagName(repo, new Date(2026, 8, 29, 12));
    expect(tag).toBe("stable-2026-09-29.1");
    await createStableTag(repo, { tag, commit: liveCommit, notes: "  Faster board.\n\nClearer run history.  " });
    expect(git(repo, "cat-file", "-t", `refs/tags/${tag}`)).toBe("tag");
    expect(git(repo, "rev-parse", `${tag}^{commit}`)).toBe(liveCommit);
    expect(git(repo, "for-each-ref", "--format=%(contents)", `refs/tags/${tag}`)).toBe("Faster board.\n\nClearer run history.");
    expect(git(origin, "rev-parse", `${tag}^{commit}`)).toBe(liveCommit);
    const info = (await readReleaseTags(repo)).find((t) => t.tag === tag);
    expect(info).toMatchObject({ annotated: true, commit: liveCommit });
  });

  it("counts .N up for a second promote on the same day", async () => {
    const liveCommit = git(repo, "rev-parse", "live-2026-09-01.1^{commit}");
    const day = new Date(2026, 8, 29, 12);
    await createStableTag(repo, { tag: await nextStableTagName(repo, day), commit: liveCommit, notes: "One." });
    expect(await nextStableTagName(repo, day)).toBe("stable-2026-09-29.2");
    expect(await nextStableTagName(repo, new Date(2026, 8, 30, 12))).toBe("stable-2026-09-30.1");
  });

  it("removes the local tag again when the push fails", async () => {
    git(repo, "remote", "set-url", "origin", path.join(root, "gone.git"));
    await expect(createStableTag(repo, { tag: "stable-2026-09-29.1", commit: git(repo, "rev-parse", "HEAD"), notes: "One." })).rejects.toThrow(
      /could not push tag stable-2026-09-29.1.*nothing was changed/,
    );
    expect(git(repo, "tag", "--list", "stable-*")).toBe("");
  });

  it("refuses notes with a pull request or GRE number, or no notes", () => {
    expect(clientNotesProblem("Faster board. Clearer run history.")).toBeNull();
    expect(clientNotesProblem("Faster board (#123)")).toMatch(/pull request number/);
    expect(clientNotesProblem("Faster board, GRE-123")).toMatch(/issue number/);
    expect(clientNotesProblem("see gre-7")).toMatch(/issue number/);
    expect(clientNotesProblem("   ")).toMatch(/write the client notes/);
    expect(clientNotesProblem(undefined)).toMatch(/write the client notes/);
    expect(clientNotesProblem("x".repeat(4_001))).toMatch(/longer than/);
  });
});

describe("release repo resolution (GRE-71)", () => {
  it("uses GSAM_RELEASE_REPO, else release.conf, never the preview state", () => {
    const gsam = path.join(root, "GSAM");
    fs.mkdirSync(path.join(gsam, "preview"), { recursive: true });
    fs.writeFileSync(path.join(gsam, "preview", "preview.state"), `source_repo=${repo}\n`);
    expect(resolveReleaseRepo({}, gsam)).toBeNull();
    fs.writeFileSync(path.join(gsam, "release.conf"), `release_repo=${repo}\n`);
    expect(resolveReleaseRepo({}, gsam)).toBe(repo);
    expect(resolveReleaseRepo({ GSAM_RELEASE_REPO: "/elsewhere" }, gsam)).toBe("/elsewhere");
  });

  it("still resolves after greatstone-preview.sh stop", () => {
    const gsam = path.join(root, "GSAM");
    const env = { ...process.env, GSAM_ROOT: gsam, GSAM_PREVIEW_PORT: "39999" };
    // What `greatstone-preview.sh start` and `greatstone-release.sh` do.
    const record = spawnSync("bash", ["-c", `source "${SCRIPTS_DIR}/greatstone-common.sh" && record_release_repo "${repo}"`], { env, encoding: "utf8" });
    expect(record.status, record.stderr).toBe(0);
    fs.mkdirSync(path.join(gsam, "preview"), { recursive: true });
    fs.writeFileSync(path.join(gsam, "preview", "preview.state"), `pid=999999\nsource_repo=${repo}\n`);

    const stop = spawnSync("bash", [path.join(SCRIPTS_DIR, "greatstone-preview.sh"), "stop"], { env, encoding: "utf8" });
    expect(stop.status, stop.stderr).toBe(0);
    expect(fs.existsSync(path.join(gsam, "preview", "preview.state"))).toBe(false);
    expect(resolveReleaseRepo({}, gsam)).toBe(repo);
  });
});

describe("deleteUnpushedTag (GRE-239)", () => {
  it("deletes a local rc tag origin does not have, keeps a pushed one, and ignores other names", async () => {
    git(repo, "tag", "-a", "rc-2026-09-29.1", "-m", "Cut, then cancelled");
    await timed(() => deleteUnpushedTag(repo, "rc-2026-09-29.1"));
    expect(git(repo, "tag", "--list", "rc-2026-09-29.*")).toBe("");

    await timed(() => deleteUnpushedTag(repo, "rc-2026-09-02.1"));
    expect(git(repo, "tag", "--list", "rc-2026-09-02.1")).toBe("rc-2026-09-02.1");

    await deleteUnpushedTag(repo, "rc-2026-09-30.9"); // no such tag: nothing to do
    await expect(deleteUnpushedTag(repo, "stable-2026-09-29.1")).rejects.toThrow(/not an rc-\* or live-\* tag/);
  });
});
