// The release repo (GRE-121): the dev checkout that holds the rc-*/live-* tags
// and the release scripts. live-release.ts uses it to release from the app.
//
// Resolution: GSAM_RELEASE_REPO, else release_repo= in $GSAM_ROOT/release.conf.
// greatstone-preview.sh start and greatstone-release.sh write that file and
// nothing removes it, so it survives `greatstone-preview.sh stop` (GRE-71).
//
// Pre-flight: every check a release or rollback needs before any agent run is
// held (prepareReleaseRepo, then checkReleaseTarget). It answers in seconds; a failure is one plain sentence and changes
// nothing, except that a clean main may be fast-forwarded to origin/main.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ReleaseKind = "release" | "rollback";

export const RC_TAG_RE = /^rc-\d{4}-\d{2}-\d{2}\.\d+$/;
export const LIVE_TAG_RE = /^live-\d{4}-\d{2}-\d{2}\.\d+$/;
export const RELEASE_CONF_FILE = "release.conf";
/** Each git call; fetch talks to GitHub and gets longer. */
export const PREFLIGHT_GIT_TIMEOUT_MS = 5_000;
export const PREFLIGHT_FETCH_TIMEOUT_MS = 15_000;
export const RELEASE_SCRIPTS = ["greatstone-release.sh", "greatstone-live-release.sh"] as const;

export type PreflightResult =
  | { ok: true; targetCommit: string; title: string | null }
  | { ok: false; reason: string };

/** Null when `tag` suits `kind`, else why not. */
export function tagKindProblem(kind: ReleaseKind, tag: unknown): string | null {
  if (kind === "release") {
    return typeof tag === "string" && RC_TAG_RE.test(tag) ? null : "a release needs an rc-YYYY-MM-DD.N tag";
  }
  return typeof tag === "string" && LIVE_TAG_RE.test(tag) ? null : "a rollback needs a live-YYYY-MM-DD.N tag";
}

export function readKeyValueFile(file: string, key: string): string | null {
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim() || null;
    }
  } catch {
    // no file
  }
  return null;
}

/** GSAM_RELEASE_REPO, else $GSAM_ROOT/release.conf. Never the preview state. */
export function resolveReleaseRepo(env: NodeJS.ProcessEnv, gsamRoot: string): string | null {
  return env.GSAM_RELEASE_REPO?.trim() || readKeyValueFile(path.join(gsamRoot, RELEASE_CONF_FILE), "release_repo");
}

async function git(repo: string, args: string[], timeout = PREFLIGHT_GIT_TIMEOUT_MS) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repo,
    encoding: "utf8",
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

async function gitOk(repo: string, args: string[]) {
  try {
    await git(repo, args);
    return true;
  } catch {
    return false;
  }
}

function firstLine(err: unknown) {
  const e = err as { stderr?: string; message?: string; killed?: boolean };
  if (e.killed) return "timed out";
  return (e.stderr || e.message || String(err)).trim().split("\n")[0] ?? "";
}

/** Same rule as rc_tag_title in scripts/greatstone-common.sh. */
function isPlaceholderTitle(title: string, tag: string) {
  return !title || title === tag || /^(release candidate([^a-z0-9]|$)|rc-[0-9])/i.test(title);
}

/**
 * The repo half of pre-flight: the release repo exists, is a git repo on a
 * clean main with the release scripts, and fast-forwards to origin/main.
 * Returns the origin/main commit.
 */
export async function prepareReleaseRepo(repo: string | null): Promise<{ ok: true; mainCommit: string } | { ok: false; reason: string }> {
  const fail = (reason: string) => ({ ok: false as const, reason });
  if (!repo) {
    return fail(
      "no release repo is set. Set GSAM_RELEASE_REPO on the live server, or run scripts/greatstone-preview.sh start once from the dev checkout (it records it in ~/GSAM/release.conf)",
    );
  }
  if (!fs.existsSync(repo)) return fail(`the release repo ${repo} does not exist`);
  if (!(await gitOk(repo, ["rev-parse", "--show-toplevel"]))) return fail(`the release repo ${repo} is not a git repository`);
  for (const file of [...RELEASE_SCRIPTS, "greatstone-common.sh", "greatstone-candidate.mjs"]) {
    const script = path.join(repo, "scripts", file);
    if (!fs.existsSync(script)) return fail(`the release repo has no scripts/${file}; update it to the latest main`);
    if ((RELEASE_SCRIPTS as readonly string[]).includes(file)) {
      try {
        fs.accessSync(script, fs.constants.X_OK);
      } catch {
        return fail(`scripts/${file} in the release repo is not executable`);
      }
    }
  }

  let changed: string;
  let branch: string;
  try {
    changed = await git(repo, ["status", "--porcelain", "--untracked-files=no"]);
    branch = await git(repo, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "");
  } catch (err) {
    return fail(`git status failed in the release repo (${firstLine(err)})`);
  }
  if (changed) {
    // git() trims the output, so the first line may have lost its leading space.
    const files = changed.split("\n").slice(0, 3).map((l) => l.trim().replace(/^\S+\s+/, "")).join(", ");
    return fail(`the release repo ${repo} has local changes (${files}); commit or discard them first`);
  }
  if (branch !== "main") return fail(`the release repo ${repo} is on ${branch || "a detached HEAD"}, not main; switch it to main first`);

  try {
    await git(repo, ["fetch", "--quiet", "--tags", "origin"], PREFLIGHT_FETCH_TIMEOUT_MS);
    await git(repo, ["fetch", "--quiet", "origin", "main"], PREFLIGHT_FETCH_TIMEOUT_MS);
  } catch (err) {
    return fail(`could not fetch from origin (${firstLine(err)})`);
  }
  if (!(await gitOk(repo, ["merge-base", "--is-ancestor", "HEAD", "origin/main"]))) {
    return fail(`main in the release repo ${repo} has commits that are not on origin/main, so it cannot fast-forward; fix the dev checkout first`);
  }
  try {
    await git(repo, ["merge", "--ff-only", "--quiet", "origin/main"]);
  } catch (err) {
    return fail(`could not fast-forward the release repo to origin/main (${firstLine(err)})`);
  }
  return { ok: true, mainCommit: await git(repo, ["rev-parse", "origin/main^{commit}"]) };
}

/** The target half of pre-flight. Call after prepareReleaseRepo. */
export async function checkReleaseTarget(input: {
  repo: string;
  kind: ReleaseKind;
  tag: string;
  liveCommit: string | null;
}): Promise<PreflightResult> {
  const { repo, kind, tag } = input;
  const fail = (reason: string): PreflightResult => ({ ok: false, reason });
  let type: string;
  try {
    type = await git(repo, ["cat-file", "-t", `refs/tags/${tag}`]);
  } catch {
    return fail(`tag ${tag} does not exist`);
  }
  let title: string | null = null;
  if (type === "tag") title = (await git(repo, ["for-each-ref", "--format=%(contents:subject)", `refs/tags/${tag}`])).trim() || null;
  // A rollback must never wait for a title: old live tags may be lightweight.
  if (kind === "release") {
    if (type !== "tag") return fail(`${tag} has no title: it is a lightweight tag. Cut it with scripts/greatstone-candidate.mjs`);
    if (isPlaceholderTitle(title ?? "", tag)) return fail(`${tag} has no title (line 1 is "${title ?? ""}"). Cut it with scripts/greatstone-candidate.mjs --title "..."`);
  }
  const targetCommit = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
  if (kind === "release" && !(await gitOk(repo, ["merge-base", "--is-ancestor", targetCommit, "origin/main"]))) {
    return fail(`${tag} is not on origin/main; only merged code is released`);
  }
  if (input.liveCommit && input.liveCommit === targetCommit) return fail(`live is already on ${tag}; nothing to do`);
  return { ok: true, targetCommit, title };
}

/** Full pre-flight for an existing tag: repo, then target. */
export async function checkReleaseRepo(input: {
  repo: string | null;
  kind: ReleaseKind;
  tag: string;
  liveCommit: string | null;
}): Promise<PreflightResult> {
  const prepared = await prepareReleaseRepo(input.repo);
  if (!prepared.ok) return prepared;
  return checkReleaseTarget({ ...input, repo: input.repo! });
}

export interface NextChange {
  sha: string;
  pr: number | null;
  issue: string | null;
  kind: "feature" | "fix";
  /** The changelog line without "- ". */
  line: string;
}

export interface CandidateCut {
  tag: string;
  sha: string;
  since: string;
  message: string;
  changes: NextChange[];
}

export const NOTHING_MERGED_RE = /nothing merged since/;
const CANDIDATE_TIMEOUT_MS = 20_000;

/**
 * Runs scripts/greatstone-candidate.mjs in the release repo, the one place
 * that turns merges into a changelog. `print` makes no tag. Throws with the
 * script's reason; NOTHING_MERGED_RE matches "no change since live".
 */
export async function runCandidateScript(
  repo: string,
  input: { tag: string; title: string; since: string | null; ref?: string; print: boolean },
): Promise<CandidateCut> {
  const args = [path.join(repo, "scripts", "greatstone-candidate.mjs"), input.tag, "--title", input.title, "--ref", input.ref ?? "origin/main", "--json"];
  if (input.since) args.push("--since", input.since);
  if (input.print) args.push("--print");
  try {
    const { stdout } = await execFileAsync(process.execPath, args, { cwd: repo, encoding: "utf8", timeout: CANDIDATE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout) as CandidateCut;
  } catch (err) {
    throw new Error(firstLine(err).replace(/^candidate: /, ""));
  }
}

/** The next free <prefix>-YYYY-MM-DD.N name, on the local date (as the release script names live tags). */
async function nextTagName(repo: string, prefix: "rc" | "stable", now: Date): Promise<string> {
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const existing = new Set((await git(repo, ["tag", "--list", `${prefix}-${day}.*`])).split("\n").filter(Boolean));
  let n = 1;
  while (existing.has(`${prefix}-${day}.${n}`)) n += 1;
  return `${prefix}-${day}.${n}`;
}

export function nextCandidateTagName(repo: string, now: Date): Promise<string> {
  return nextTagName(repo, "rc", now);
}

/**
 * Deletes a local rc-* or live-* tag that origin does not have (GRE-239): one
 * this server cut for a release that was cancelled or stopped before the
 * switch. A pushed tag is kept. When origin cannot be asked the tag counts as
 * unpushed: the release pushes its tags only after live is healthy.
 */
export async function deleteUnpushedTag(repo: string, tag: string): Promise<void> {
  if (!/^(rc|live)-\d{4}-\d{2}-\d{2}\.\d+$/.test(tag)) throw new Error(`${tag} is not an rc-* or live-* tag`);
  const remote = await git(repo, ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], PREFLIGHT_FETCH_TIMEOUT_MS).catch(() => "");
  if (remote) return;
  if (!(await gitOk(repo, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]))) return;
  await git(repo, ["tag", "-d", tag]);
}

// Stable (GRE-127, design GRE-124 "Trimmed build"): a stable-* tag is an
// annotated tag on the commit of a live-* release. Its message is the client
// notes, which clients see as "What's new", so no internal numbers.
export const STABLE_TAG_RE = /^stable-\d{4}-\d{2}-\d{2}\.\d+$/;
export const CLIENT_NOTES_MAX_LENGTH = 4_000;

/** Null when `notes` may be a stable tag message, else why not. */
export function clientNotesProblem(notes: unknown): string | null {
  if (typeof notes !== "string" || !notes.trim()) return "write the client notes";
  if (notes.length > CLIENT_NOTES_MAX_LENGTH) return `the client notes are longer than ${CLIENT_NOTES_MAX_LENGTH} characters`;
  if (/#\d+/.test(notes)) return "the client notes contain a pull request number (#123); clients must not see internal numbers";
  if (/\bGRE-\d+/i.test(notes)) return "the client notes contain an issue number (GRE-123); clients must not see internal numbers";
  return null;
}

export function nextStableTagName(repo: string, now: Date): Promise<string> {
  return nextTagName(repo, "stable", now);
}

/**
 * Adds the annotated stable tag on `commit` and pushes it to origin, where
 * clients read it. If the push fails the local tag is removed again, so a
 * failure changes nothing and the same promote can be tried again.
 */
export async function createStableTag(repo: string, input: { tag: string; commit: string; notes: string }): Promise<void> {
  if (!STABLE_TAG_RE.test(input.tag)) throw new Error(`${input.tag} is not a stable-YYYY-MM-DD.N name`);
  try {
    await git(repo, ["tag", "-a", input.tag, input.commit, "-m", input.notes.trim()]);
  } catch (err) {
    throw new Error(`could not add tag ${input.tag} (${firstLine(err)})`);
  }
  try {
    // GSAM_RELEASE=1: the pre-push guard lets only release tooling push tags.
    await execFileAsync("git", ["push", "--quiet", "origin", `refs/tags/${input.tag}`], {
      cwd: repo,
      encoding: "utf8",
      timeout: PREFLIGHT_FETCH_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GSAM_RELEASE: "1" },
    });
  } catch (err) {
    await gitOk(repo, ["tag", "-d", input.tag]);
    throw new Error(`could not push tag ${input.tag} to origin (${firstLine(err)}); nothing was changed`);
  }
}

export type CiStatus = "passed" | "failed" | "pending" | "unknown";
export const FORK_CI_WORKFLOW = "fork-ci.yml";

/** Fork CI on `commit`, read with gh in the release repo. "unknown" when gh cannot tell. */
export async function readForkCi(repo: string, commit: string): Promise<{ status: CiStatus; url: string | null }> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["run", "list", "--workflow", FORK_CI_WORKFLOW, "--commit", commit, "--limit", "1", "--json", "status,conclusion,url"],
      { cwd: repo, encoding: "utf8", timeout: PREFLIGHT_FETCH_TIMEOUT_MS, env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
    );
    const [run] = JSON.parse(stdout) as Array<{ status?: string; conclusion?: string; url?: string }>;
    if (!run) return { status: "unknown", url: null };
    const url = run.url ?? null;
    if (run.status !== "completed") return { status: "pending", url };
    return { status: run.conclusion === "success" ? "passed" : "failed", url };
  } catch {
    return { status: "unknown", url: null };
  }
}

/** The Releases page fetches main at most this often, and waits this long for it (GRE-249). */
export const MAIN_FETCH_INTERVAL_MS = 30_000;
export const MAIN_FETCH_TIMEOUT_MS = 5_000;
const mainFetches = new Map<string, { at: number; pending: Promise<void> | null }>();

/**
 * The origin/main commit, after a short `git fetch origin main` so a new
 * merge shows within one refresh (GRE-249). One fetch per repo per interval;
 * page loads in between, or while a fetch runs, share it. A failed or
 * timed-out fetch falls back to the last fetched commit.
 */
export async function readReleaseMainCommit(repo: string, now = Date.now()): Promise<string | null> {
  let state = mainFetches.get(repo);
  if (!state || (!state.pending && now - state.at >= MAIN_FETCH_INTERVAL_MS)) {
    const next = { at: now, pending: null as Promise<void> | null };
    next.pending = git(repo, ["fetch", "--quiet", "origin", "main"], MAIN_FETCH_TIMEOUT_MS)
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        next.pending = null;
      });
    mainFetches.set(repo, next);
    state = next;
  }
  if (state.pending) await state.pending;
  return git(repo, ["rev-parse", "--verify", "--quiet", "origin/main^{commit}"]).catch(() => null);
}

/** Tests only: forget when each repo last fetched main. */
export function resetMainFetchesForTest() {
  mainFetches.clear();
}

export interface ReleaseTagInfo {
  tag: string;
  commit: string;
  date: string | null;
  annotated: boolean;
  message: string | null;
}

/** Every rc-*, live-* and stable-* tag, newest first, in one git call. */
export async function readReleaseTags(repo: string): Promise<ReleaseTagInfo[]> {
  const out = await git(repo, [
    "for-each-ref",
    "--sort=-creatordate",
    "--format=%(refname:short)%1f%(objecttype)%1f%(objectname)%1f%(*objectname)%1f%(creatordate:iso-strict)%1f%(contents)%1e",
    "refs/tags/rc-*",
    "refs/tags/live-*",
    "refs/tags/stable-*",
  ]);
  return out
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim())
    .map((record) => {
      const [tag = "", type = "", object = "", peeled = "", date = "", message = ""] = record.split("\x1f");
      const annotated = type === "tag";
      return { tag, commit: annotated ? peeled : object, date: date || null, annotated, message: annotated ? message : null };
    });
}
