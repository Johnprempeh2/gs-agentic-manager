// One-click release (GRE-39). When John accepts an "Update live?" card
// (a request_confirmation whose idempotencyKey is `live-release:<rc-tag>`),
// the live server releases the candidate itself:
//
//   1. It holds new agent runs (the task drain) and waits until no run is
//      running. The hold is also written to a file, so the server that starts
//      after the restart keeps holding until the release is reported.
//   2. It starts scripts/greatstone-live-release.sh from the dev checkout, in
//      the background and detached, so it survives this server stopping. That
//      launcher runs scripts/greatstone-release.sh (the same command John runs
//      by hand) and rolls back to the previous live-* tag if live does not come
//      up on the candidate. It writes the outcome to result.json.
//   3. A tick (on this server or the one after the restart) posts the outcome
//      on the release issue and lifts the hold.
//
// Rejecting the card does nothing: only an accepted card reaches this file.
// Every wait has a deadline, and the hold file has an expiry, so a lost
// launcher or a crashed server cannot hold agent runs forever.
//
// Live start record (GRE-50). However live moved (this card or John running
// greatstone-release.sh by hand), the live server that starts on a new commit
// records it in live.json (commit, tag, time) and announces it once: an
// activity entry per company, a wake for each issue waiting for a release, and
// the withdrawal of "is it released?" cards it now answers. A restart on the
// same commit does nothing. live.json is written only after the announcement,
// so a crash in between repeats it at the next start; each step is idempotent.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@greatstone/db";
import { LIVE_RELEASE_REF_PATTERN } from "@greatstone/shared";
import { logger } from "../middleware/logger.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { getServerInfoSnapshot } from "../server-info.js";
import { applyTaskDrain, getTaskDrainStatus, stopTaskDrain } from "./heartbeat.js";
import { issueService } from "./issues.js";
import { announceLiveRelease } from "./live-release-announce.js";

export const LIVE_RELEASE_KEY_PREFIX = "live-release:";
const RC_TAG_RE = /^rc-\d{4}-\d{2}-\d{2}\.\d+$/;
/** What an agent may ask about: a commit SHA, or an rc-* / live-* tag. */
export function isReleaseRef(ref: string | null | undefined): ref is string {
  return typeof ref === "string" && LIVE_RELEASE_REF_PATTERN.test(ref);
}

/** One live start on a new commit. */
export interface LiveReleaseEvent {
  commit: string;
  /** The live-* tag on the commit, if any. */
  tag: string | null;
  startedAt: string;
  previousCommit: string | null;
  previousTag: string | null;
}

export const LIVE_RELEASE_WAIT_FOR_RUNS_MS = 60 * 60 * 1000;
export const LIVE_RELEASE_SWITCH_MS = 30 * 60 * 1000;
export const LIVE_RELEASE_TICK_MS = 10 * 1000;
export const LIVE_RELEASE_RECORD_ATTEMPTS = 3;
export const LIVE_RELEASE_RECORD_RETRY_MS = 60 * 1000;

export type LiveReleaseOutcome = "released" | "not_released" | "rolled_back" | "rollback_failed";

export interface LiveReleaseResult {
  outcome: LiveReleaseOutcome;
  message?: string | null;
  liveTag?: string | null;
  previousTag?: string | null;
  commit?: string | null;
  backupFile?: string | null;
}

export interface LiveReleaseJob {
  id: string;
  issueId: string;
  interactionId: string;
  rcTag: string;
  acceptedByUserId: string;
  releaseRepo: string;
  state: "waiting_for_runs" | "switching" | "finished";
  createdAt: string;
  waitDeadline: string;
  switchDeadline: string | null;
  launcherStartedAt: string | null;
  finishedAt: string | null;
}

interface LiveReleaseHold {
  jobId: string;
  startedAt: string;
  expiresAt: string;
}

export interface LiveReleaseDeps {
  /** Folder for hold.json and jobs/<id>/ (inside the instance data folder). */
  stateDir: string;
  /** The live checkout (~/GSAM/live). Release is on only when this server runs from it. */
  liveDir: string;
  /** Top of the git checkout this server runs from, or null. */
  serverRepoRoot: string | null;
  /** The dev checkout that holds the rc-* tags and the release scripts, or null. */
  resolveReleaseRepo(): string | null;
  now(): Date;
  countRunningRuns(): Promise<number>;
  postComment(issueId: string, body: string): Promise<void>;
  applyHold(hold: { startedAt: Date; expiresAt: Date }): void;
  /** Lifts the task drain only if it is still the one this release started. */
  liftHold(startedAt: Date): void;
  /** Starts the launcher; it detaches itself and returns at once. */
  startLauncher(input: { launcher: string; jobDir: string; rcTag: string; releaseRepo: string }): void;
  isProcessAlive(pid: number): boolean;
  /** The commit this server runs, and its live-* tag. Null when unknown. */
  readRunningCommit(): { commit: string; tag: string | null } | null;
  /** Whether `ref` (checked with isReleaseRef) is contained in `commit`; null when git cannot tell. */
  containsRef(commit: string, ref: string): boolean | null;
  /** Records and announces a new live commit. Must be safe to repeat. */
  announce(event: LiveReleaseEvent, isRefLive: (ref: string) => boolean | null): Promise<void>;
}

export function parseLiveReleaseKey(idempotencyKey: string | null | undefined): string | null {
  if (!idempotencyKey?.startsWith(LIVE_RELEASE_KEY_PREFIX)) return null;
  const tag = idempotencyKey.slice(LIVE_RELEASE_KEY_PREFIX.length);
  return RC_TAG_RE.test(tag) ? tag : null;
}

function realpathOrNull(p: string | null) {
  if (!p) return null;
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function readKeyValueFile(file: string, key: string): string | null {
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim() || null;
    }
  } catch {
    // no file
  }
  return null;
}

function releaseRepoProblem(repo: string | null): string | null {
  if (!repo) {
    return "no dev checkout is known. Start the preview with the current scripts/greatstone-preview.sh (it records the dev checkout), or set GSAM_RELEASE_REPO on the live server";
  }
  for (const file of ["greatstone-release.sh", "greatstone-live-release.sh"]) {
    if (!fs.existsSync(path.join(repo, "scripts", file))) {
      return `the dev checkout ${repo} has no scripts/${file}; update it to the latest main`;
    }
  }
  return null;
}

export function describeLiveReleaseResult(job: LiveReleaseJob, result: LiveReleaseResult, jobDir: string): string {
  const previous = result.previousTag ?? "the previous live tag";
  const backup = result.backupFile ? ` Database backup from before the release: \`${result.backupFile}\`.` : "";
  const reason = result.message ? `: ${result.message}` : "";
  switch (result.outcome) {
    case "released":
      return `Released ${job.rcTag} as ${result.liveTag ?? "a new live tag"}. \`/api/health\` reports commit \`${result.commit ?? "?"}\`.${backup} Roll back with \`scripts/greatstone-release.sh ${previous}\`.`;
    case "not_released":
      return `Not released${reason}. Live is unchanged. Agent runs are back on.`;
    case "rolled_back":
      return `Release of ${job.rcTag} failed${reason}. Rolled back to ${previous} automatically.${backup} Logs: \`${jobDir}\`.`;
    case "rollback_failed":
      return `Release of ${job.rcTag} failed and the automatic rollback to ${previous} also failed${reason}. Live may be down. John: run \`scripts/greatstone-release.sh ${previous}\` from the dev checkout.${backup} Logs: \`${jobDir}\`.`;
  }
}

export function createLiveReleaseService(deps: LiveReleaseDeps) {
  const jobsDir = path.join(deps.stateDir, "jobs");
  const holdFile = path.join(deps.stateDir, "hold.json");
  const liveFile = path.join(deps.stateDir, "live.json");
  let queue: Promise<unknown> = Promise.resolve();
  // One step at a time, so an accept and a tick never act on the same job at once.
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const turn = queue.then(work, work);
    queue = turn.catch(() => undefined);
    return turn;
  };

  const jobDir = (id: string) => path.join(jobsDir, id);
  const saveJob = (job: LiveReleaseJob) => writeJson(path.join(jobDir(job.id), "job.json"), job);
  const listJobs = (): LiveReleaseJob[] => {
    if (!fs.existsSync(jobsDir)) return [];
    return fs
      .readdirSync(jobsDir)
      .map((id) => readJson<LiveReleaseJob>(path.join(jobsDir, id, "job.json")))
      .filter((job): job is LiveReleaseJob => job !== null);
  };

  const enabledProblem = (): string | null => {
    const live = realpathOrNull(deps.liveDir);
    const server = realpathOrNull(deps.serverRepoRoot);
    if (!live || !server || live !== server) {
      return `one-click release is off on this server: it does not run from ${deps.liveDir}`;
    }
    return null;
  };

  const readHold = () => readJson<LiveReleaseHold>(holdFile);

  const releaseHold = () => {
    const hold = readHold();
    fs.rmSync(holdFile, { force: true });
    if (hold) deps.liftHold(new Date(hold.startedAt));
  };

  const finish = async (job: LiveReleaseJob, body: string) => {
    job.state = "finished";
    job.finishedAt = deps.now().toISOString();
    saveJob(job);
    releaseHold();
    try {
      await deps.postComment(job.issueId, body);
    } catch (err) {
      logger.warn({ err, jobId: job.id, issueId: job.issueId }, "live release: failed to post the outcome");
    }
  };

  /**
   * Called after a request_confirmation is accepted. Does nothing unless the
   * card is an "Update live?" card and a person accepted it.
   */
  const onConfirmationAccepted = (input: {
    issueId: string;
    interaction: { id: string; kind: string; status: string; idempotencyKey?: string | null };
    actor: { actorType: string; actorId: string };
  }) =>
    serial(async () => {
      const { interaction, actor } = input;
      if (interaction.kind !== "request_confirmation" || interaction.status !== "accepted") return null;
      const rcTag = parseLiveReleaseKey(interaction.idempotencyKey);
      if (!rcTag) return null;
      if (actor.actorType !== "user") {
        await deps.postComment(input.issueId, `Not released: only a person can accept "Update live?". Live is unchanged.`);
        return null;
      }
      const off = enabledProblem();
      if (off) {
        await deps.postComment(input.issueId, `Not released: ${off}. Live is unchanged.`);
        return null;
      }
      const busy = listJobs().find((job) => job.state !== "finished");
      if (busy) {
        await deps.postComment(input.issueId, `Not released: the release of ${busy.rcTag} is still in progress. Live is unchanged by this card.`);
        return null;
      }
      const releaseRepo = deps.resolveReleaseRepo();
      const repoProblem = releaseRepoProblem(releaseRepo);
      if (repoProblem || !releaseRepo) {
        await deps.postComment(input.issueId, `Not released: ${repoProblem}. Live is unchanged.`);
        return null;
      }

      const now = deps.now();
      const job: LiveReleaseJob = {
        id: `${now.toISOString().replace(/[:.]/g, "")}-${randomUUID().slice(0, 8)}`,
        issueId: input.issueId,
        interactionId: interaction.id,
        rcTag,
        acceptedByUserId: actor.actorId,
        releaseRepo,
        state: "waiting_for_runs",
        createdAt: now.toISOString(),
        waitDeadline: new Date(now.getTime() + LIVE_RELEASE_WAIT_FOR_RUNS_MS).toISOString(),
        switchDeadline: null,
        launcherStartedAt: null,
        finishedAt: null,
      };
      fs.mkdirSync(jobDir(job.id), { recursive: true });
      saveJob(job);
      // The hold outlives the longest wait plus the longest switch, then lapses.
      const hold = {
        startedAt: now,
        expiresAt: new Date(now.getTime() + LIVE_RELEASE_WAIT_FOR_RUNS_MS + LIVE_RELEASE_SWITCH_MS),
      };
      writeJson(holdFile, { jobId: job.id, startedAt: hold.startedAt.toISOString(), expiresAt: hold.expiresAt.toISOString() });
      deps.applyHold(hold);
      const running = await deps.countRunningRuns();
      await deps.postComment(
        input.issueId,
        `Update live accepted for ${rcTag}. New agent runs are on hold. The switch starts when no agent run is running (${running} now, wait at most ${LIVE_RELEASE_WAIT_FOR_RUNS_MS / 60000} min).`,
      );
      await step(job);
      return job;
    });

  const step = async (job: LiveReleaseJob) => {
    const now = deps.now();
    const dir = jobDir(job.id);
    if (job.state === "waiting_for_runs") {
      const running = await deps.countRunningRuns();
      if (running > 0) {
        if (now.getTime() >= Date.parse(job.waitDeadline)) {
          await finish(job, `Not released: ${running} agent run(s) still running after ${LIVE_RELEASE_WAIT_FOR_RUNS_MS / 60000} min. Live is unchanged and agent runs are back on. Post a new "Update live?" card to try again.`);
        }
        return;
      }
      job.state = "switching";
      job.launcherStartedAt = now.toISOString();
      job.switchDeadline = new Date(now.getTime() + LIVE_RELEASE_SWITCH_MS).toISOString();
      saveJob(job);
      try {
        deps.startLauncher({
          launcher: path.join(job.releaseRepo, "scripts", "greatstone-live-release.sh"),
          jobDir: dir,
          rcTag: job.rcTag,
          releaseRepo: job.releaseRepo,
        });
      } catch (err) {
        await finish(job, `Not released: the release launcher did not start (${err instanceof Error ? err.message : String(err)}). Live is unchanged.`);
      }
      return;
    }
    if (job.state === "switching") {
      const result = readJson<LiveReleaseResult>(path.join(dir, "result.json"));
      if (result) {
        await finish(job, describeLiveReleaseResult(job, result, dir));
        return;
      }
      const pid = Number.parseInt(fs.existsSync(path.join(dir, "launcher.pid")) ? fs.readFileSync(path.join(dir, "launcher.pid"), "utf8") : "", 10);
      const pastDeadline = job.switchDeadline !== null && now.getTime() >= Date.parse(job.switchDeadline);
      // Give the launcher a moment to write its pid before calling it lost.
      const started = job.launcherStartedAt ? Date.parse(job.launcherStartedAt) : now.getTime();
      const launcherLost = now.getTime() - started > 60_000 && !(Number.isFinite(pid) && deps.isProcessAlive(pid));
      if (pastDeadline || launcherLost) {
        await finish(
          job,
          `The release of ${job.rcTag} gave no result (${pastDeadline ? "time limit reached" : "the launcher stopped"}). Check \`/api/health\` and the logs in \`${dir}\`; roll back with \`scripts/greatstone-release.sh <previous live tag>\` if live is wrong. Agent runs are back on.`,
        );
      }
    }
  };

  /** Advances every open release. Runs on an interval and once at start. */
  const tick = () =>
    serial(async () => {
      for (const job of listJobs()) {
        if (job.state === "finished") continue;
        try {
          await step(job);
        } catch (err) {
          logger.error({ err, jobId: job.id }, "live release: step failed");
        }
      }
    });

  /**
   * At server start: keep holding runs if a release is still switching (this
   * server may be the one the release just started). An expired or orphaned
   * hold file is removed.
   */
  const restoreHold = () => {
    const hold = readHold();
    if (!hold) return false;
    const expiresAt = new Date(hold.expiresAt);
    const job = readJson<LiveReleaseJob>(path.join(jobDir(hold.jobId), "job.json"));
    if (!job || job.state === "finished" || !(expiresAt.getTime() > deps.now().getTime())) {
      fs.rmSync(holdFile, { force: true });
      return false;
    }
    deps.applyHold({ startedAt: new Date(hold.startedAt), expiresAt });
    return true;
  };

  /** The last live start this server recorded, or null. */
  const lastLiveStart = () => readJson<LiveReleaseEvent>(liveFile);

  /**
   * At server start: when this is the live server and it runs a commit
   * live.json does not have yet, announce it, then record it.
   */
  const recordLiveStart = () =>
    serial(async () => {
      if (enabledProblem()) return null;
      const running = deps.readRunningCommit();
      if (!running) return null;
      const last = lastLiveStart();
      if (last?.commit === running.commit) return null;
      const event: LiveReleaseEvent = {
        commit: running.commit,
        tag: running.tag,
        startedAt: deps.now().toISOString(),
        previousCommit: last?.commit ?? null,
        previousTag: last?.tag ?? null,
      };
      await deps.announce(event, (ref) => (isReleaseRef(ref) ? deps.containsRef(event.commit, ref) : null));
      fs.mkdirSync(deps.stateDir, { recursive: true });
      writeJson(liveFile, event);
      return event;
    });

  /** "Is `ref` live?" against the commit this server runs. */
  const isLive = (ref: string | null) => {
    const running = deps.readRunningCommit();
    return {
      commit: running?.commit ?? null,
      tag: running?.tag ?? null,
      lastLiveStart: lastLiveStart(),
      ref,
      live: running && ref && isReleaseRef(ref) ? deps.containsRef(running.commit, ref) : null,
    };
  };

  return { onConfirmationAccepted, tick, restoreHold, listJobs, holdFile, recordLiveStart, lastLiveStart, isLive };
}

function serverRepoRoot(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function git(repo: string | null, args: string[]): string | null {
  if (!repo) return null;
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

/** git merge-base --is-ancestor: true / false, or null when git cannot tell (unknown ref, no repo). */
function repoContainsRef(repo: string | null, commit: string, ref: string): boolean | null {
  if (!repo || !isReleaseRef(ref)) return null;
  const sha = git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!sha) return null;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, commit], { cwd: repo, stdio: "ignore", timeout: 10_000 });
    return true;
  } catch (err) {
    return (err as { status?: number }).status === 1 ? false : null;
  }
}

function defaultDeps(db: Db, env: NodeJS.ProcessEnv = process.env): LiveReleaseDeps {
  // Same defaults as scripts/greatstone-common.sh.
  const gsamRoot = env.GSAM_ROOT?.trim() || path.join(os.homedir(), "GSAM");
  const liveDir = env.GSAM_LIVE_DIR?.trim() || path.join(gsamRoot, "live");
  const issues = issueService(db);
  const repoRoot = serverRepoRoot();
  return {
    stateDir: path.join(resolvePaperclipInstanceRoot(), "live-release"),
    liveDir,
    serverRepoRoot: repoRoot,
    resolveReleaseRepo: () =>
      env.GSAM_RELEASE_REPO?.trim() || readKeyValueFile(path.join(gsamRoot, "preview", "preview.state"), "source_repo"),
    now: () => new Date(),
    countRunningRuns: async () => {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.status, "running"));
      return row?.count ?? 0;
    },
    postComment: async (issueId, body) => {
      await issues.addComment(issueId, body, {}, { authorType: "system" });
    },
    applyHold: (hold) => applyTaskDrain(hold),
    liftHold: (startedAt) => {
      if (getTaskDrainStatus().startedAt?.getTime() === startedAt.getTime()) stopTaskDrain();
    },
    startLauncher: ({ launcher, jobDir, rcTag, releaseRepo }) => {
      // detached: a new session, so the live server's restart does not stop it.
      const child = spawn("bash", [launcher, jobDir, rcTag, releaseRepo], {
        cwd: releaseRepo,
        detached: true,
        stdio: "ignore",
        env: { ...env, GSAM_RELEASE_REPO: releaseRepo },
      });
      child.unref();
    },
    isProcessAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    readRunningCommit: () => {
      // The same commit /api/health reports.
      const info = getServerInfoSnapshot().git;
      if (!info.available) return null;
      const tags = git(repoRoot, ["tag", "--points-at", info.fullSha, "--list", "live-*", "--sort=-creatordate"]);
      return { commit: info.fullSha, tag: tags?.split("\n")[0]?.trim() || null };
    },
    containsRef: (commit, ref) => repoContainsRef(repoRoot, commit, ref),
    announce: async (event, isRefLive) => {
      const result = await announceLiveRelease(db, event, isRefLive);
      logger.info({ commit: event.commit, ...result }, "live release: announced");
    },
  };
}

let shared: ReturnType<typeof createLiveReleaseService> | null = null;

export function liveReleaseService(db: Db) {
  shared ??= createLiveReleaseService(defaultDeps(db));
  return shared;
}

/** Restores a pending hold and starts the tick. Returns a stop function. */
export function startLiveReleaseTicker(db: Db) {
  const svc = liveReleaseService(db);
  if (svc.restoreHold()) logger.info("live release: holding agent runs until the release in progress reports");
  let recordTimer: NodeJS.Timeout | null = null;
  const record = (attempt: number) => {
    svc
      .recordLiveStart()
      .then((event) => {
        if (event) logger.info({ commit: event.commit, tag: event.tag }, "live release: recorded a live start on a new commit");
      })
      .catch((err) => {
        const retry = attempt < LIVE_RELEASE_RECORD_ATTEMPTS;
        logger.error({ err, attempt }, `live release: failed to record the live start; ${retry ? "retrying" : "it repeats at the next start"}`);
        if (!retry) return;
        recordTimer = setTimeout(() => record(attempt + 1), LIVE_RELEASE_RECORD_RETRY_MS);
        recordTimer.unref?.();
      });
  };
  record(1);
  void svc.tick();
  const timer = setInterval(() => void svc.tick(), LIVE_RELEASE_TICK_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    if (recordTimer) clearTimeout(recordTimer);
  };
}
