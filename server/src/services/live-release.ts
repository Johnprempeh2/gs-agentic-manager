// One-click release (GRE-39, GRE-121). John releases or rolls back from the
// Releases page, or accepts an "Update live?" card (a request_confirmation
// whose idempotencyKey is `live-release:<rc-tag>`). Both call start():
//
//   0. checking: pre-flight (release-repo.ts), before any run is held. It
//      answers in seconds; a failure changes nothing. A release with no tag
//      cuts an rc-* tag from origin/main (title and changelog) once Fork CI on
//      that commit is green.
//   1. holding: new agent runs are held (the task drain) and the release waits
//      only for running runs flagged "finish before update" (run-update-flags.ts),
//      unless the board overrides. John can cancel here; live is unchanged.
//      The hold is also written to a file, so the server that starts after the
//      restart keeps holding until the release is reported.
//   2. switching / restarting: scripts/greatstone-live-release.sh runs from the
//      release repo, detached, so it survives this server stopping. It runs
//      scripts/greatstone-release.sh, whose restart is a hot restart (running
//      runs are adopted or checkpointed and resumed), and rolls back to the
//      previous live-* tag if live does not come up on the target. It writes
//      the phase to `phase` and the outcome to result.json.
//   3. healthy | rolled_back | failed | cancelled: a tick (on this server or
//      the one after the restart) records the outcome and the hot-restart
//      report, lifts the hold, and posts on the card's issue if there is one.
//
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
import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, heartbeatRuns, issues as issuesTable, type Db } from "@greatstone/db";
import { LIVE_RELEASE_REF_PATTERN } from "@greatstone/shared";
import { logger } from "../middleware/logger.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { getServerInfoSnapshot } from "../server-info.js";
import { applyTaskDrain, getTaskDrainStatus, stopTaskDrain } from "./heartbeat.js";
import { issueService } from "./issues.js";
import { announceLiveRelease } from "./live-release-announce.js";
import { readHotRestartReportSync, type HotRestartReport } from "./hot-restart.js";
import { getStartupRecoveryState } from "../startup-recovery-state.js";
import { hasOwnReleaseNotes, parseReleaseNotes, type ReleaseNotes } from "./release-notes.js";
import {
  LIVE_TAG_RE,
  NOTHING_MERGED_RE,
  RC_TAG_RE,
  STABLE_TAG_RE,
  checkReleaseTarget,
  clientNotesProblem,
  createStableTag,
  deleteUnpushedTag,
  nextCandidateTagName,
  nextStableTagName,
  prepareReleaseRepo,
  readForkCi,
  readReleaseTags,
  resolveReleaseRepo as resolveReleaseRepoFrom,
  runCandidateScript,
  tagKindProblem,
  type CandidateCut,
  type CiStatus,
  type PreflightResult,
  type ReleaseKind,
  type ReleaseTagInfo,
} from "./release-repo.js";
import { createRunUpdateFlagStore, type RunUpdateFlag } from "./run-update-flags.js";

export const LIVE_RELEASE_KEY_PREFIX = "live-release:";
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
/** GET /releases is polled every 2 s; git and gh answers are reused this long. */
export const LIVE_RELEASE_OVERVIEW_CACHE_MS = 60 * 1000;
export const NEXT_TITLE_MAX_LENGTH = 120;

export type LiveReleaseOutcome = "released" | "not_released" | "rolled_back" | "rollback_failed";

export interface LiveReleaseResult {
  outcome: LiveReleaseOutcome;
  message?: string | null;
  liveTag?: string | null;
  previousTag?: string | null;
  commit?: string | null;
  backupFile?: string | null;
}

export type ReleaseState =
  | "checking"
  | "holding"
  | "switching"
  | "restarting"
  | "healthy"
  | "rolled_back"
  | "failed"
  | "cancelled";
export const FINAL_RELEASE_STATES: ReadonlySet<ReleaseState> = new Set(["healthy", "rolled_back", "failed", "cancelled"]);

/** What hot-restart-report.json says about the runs across the switch. */
export interface RestartReportSummary {
  completedAt: string;
  /** Runs that go on: adopted, or ended during the switch and resumed. */
  resumedRunIds: string[];
  /** Kept running through the restart. */
  adoptedRunIds: string[];
  /** Ended during the switch; checkpointed ACP runs are here and continue as a conversation retry. */
  finishedWhileDownRunIds: string[];
  /** Running before, unaccounted for after. Needs recovery. */
  lostRunIds: string[];
}

export interface LiveReleaseJob {
  id: string;
  kind: ReleaseKind;
  /** rc-* for a release, live-* for a rollback. */
  tag: string;
  title: string | null;
  commit: string | null;
  /** The card's issue, when the job came from an "Update live?" card. */
  issueId: string | null;
  interactionId: string | null;
  startedBy: string | null;
  releaseRepo: string;
  state: ReleaseState;
  reason: string | null;
  previousTag: string | null;
  liveTag: string | null;
  waitingForFlaggedRuns: number | null;
  overridden: boolean;
  restartReport: RestartReportSummary | null;
  createdAt: string;
  updatedAt: string;
  waitDeadline: string;
  switchDeadline: string | null;
  launcherStartedAt: string | null;
  finishedAt: string | null;
  /** This job cut `tag` from origin/main; a job that stops before the switch deletes it (GRE-239). */
  cutTag: boolean;
}

/** The progress the Releases page shows (agreed with Mica on GRE-121/GRE-122). */
export interface ReleaseProgress {
  id: string;
  kind: ReleaseKind;
  targetTag: string | null;
  targetTitle: string | null;
  state: ReleaseState;
  waitingForFlaggedRuns: number | null;
  overridden: boolean;
  reason: string | null;
  previousTag: string | null;
  liveTag: string | null;
  restartReport: RestartReportSummary | null;
  startedAt: string;
  updatedAt: string;
  startedBy: string | null;
}

export interface Changelog {
  features: string[];
  fixes: string[];
}

export interface NextVersion {
  baseTag: string | null;
  commit: string;
  proposedTitle: string;
  titleEditedBy: string | null;
  titleEditedAt: string | null;
  changelog: Changelog;
  changes: Array<{ pr: number | null; issue: string | null; title: string; kind: "feature" | "fix"; commit: string }>;
  forkCi: { status: CiStatus; url: string | null };
}

export interface FlaggedRunView extends RunUpdateFlag {
  runId: string;
  agentName: string | null;
  issueIdentifier: string | null;
}

export interface ReleasesOverview {
  live: {
    tag: string | null;
    title: string | null;
    date: string | null;
    commit: string;
    health: "healthy" | "unhealthy" | "unknown";
    releasedBy: string | null;
    changelog: Changelog;
  } | null;
  history: Array<{
    tag: string;
    title: string;
    date: string | null;
    commit: string;
    releasedBy: string | null;
    changelog: Changelog;
    candidateTag: string | null;
    /** The stable-* tag on this release's commit, once promoted (GRE-127). */
    stableTag: string | null;
    restartReport: RestartReportSummary | null;
    /** The release to this tag failed and live never ran it (GRE-239); it offers no rollback. */
    neverRan: boolean;
  }>;
  next: NextVersion | null;
  flaggedRuns: FlaggedRunView[];
  progress: ReleaseProgress | null;
  /** Why release is off on this server, or null. */
  disabledReason: string | null;
}

export type StartReleaseResult =
  | { ok: true; job: LiveReleaseJob; progress: ReleaseProgress }
  | { ok: false; status: 403 | 409 | 422; error: string };

export type PromoteResult =
  | { ok: true; stable: { tag: string; commit: string; liveTag: string } }
  | { ok: false; status: 403 | 409 | 422 | 502; error: string };

interface LiveReleaseHold {
  jobId: string;
  startedAt: string;
  expiresAt: string;
}

interface StoredNextTitle {
  title: string;
  /** The live tag the title was written against; a new live release drops it. */
  baseTag: string | null;
  editedBy: string | null;
  editedAt: string;
}

export interface LiveReleaseDeps {
  /** Folder for hold.json, jobs/<id>/, next-title.json and run-flags.json (inside the instance data folder). */
  stateDir: string;
  /** The live checkout (~/GSAM/live). Release is on only when this server runs from it. */
  liveDir: string;
  /** Top of the git checkout this server runs from, or null. */
  serverRepoRoot: string | null;
  /** The dev checkout that holds the rc-* tags and the release scripts, or null. */
  resolveReleaseRepo(): string | null;
  now(): Date;
  /** Running runs among `runIds` (the flagged ones). */
  runningRunIds(runIds: string[]): Promise<string[]>;
  postComment(issueId: string, body: string): Promise<void>;
  applyHold(hold: { startedAt: Date; expiresAt: Date }): void;
  /** Lifts the task drain only if it is still the one this release started. */
  liftHold(startedAt: Date): void;
  /** Starts the launcher; it detaches itself and returns at once. */
  startLauncher(input: { launcher: string; jobDir: string; tag: string; releaseRepo: string }): void;
  isProcessAlive(pid: number): boolean;
  /** The commit this server runs, and its live-* tag. Null when unknown. */
  readRunningCommit(): { commit: string; tag: string | null } | null;
  /** Whether `ref` (checked with isReleaseRef) is contained in `commit`; null when git cannot tell. */
  containsRef(commit: string, ref: string): boolean | null;
  /** Records and announces a new live commit. Must be safe to repeat. */
  announce(event: LiveReleaseEvent, isRefLive: (ref: string) => boolean | null): Promise<void>;
  // Release repo access (release-repo.ts); injected so tests need no git or gh.
  prepareRepo(repo: string | null): Promise<{ ok: true; mainCommit: string } | { ok: false; reason: string }>;
  checkTarget(input: { repo: string; kind: ReleaseKind; tag: string; liveCommit: string | null }): Promise<PreflightResult>;
  /** scripts/greatstone-candidate.mjs; `print` makes no tag. */
  runCandidate(repo: string, input: { tag: string; title: string; since: string | null; print: boolean }): Promise<CandidateCut>;
  nextTagName(repo: string): Promise<string>;
  /** Deletes `tag` in the release repo when origin does not have it. */
  deleteUnpushedTag(repo: string, tag: string): Promise<void>;
  /** The next free stable-YYYY-MM-DD.N name (GRE-127). */
  nextStableTagName(repo: string): Promise<string>;
  /** Adds the annotated stable tag and pushes it; a failure changes nothing. */
  createStableTag(repo: string, input: { tag: string; commit: string; notes: string }): Promise<void>;
  readForkCi(repo: string, commit: string): Promise<{ status: CiStatus; url: string | null }>;
  readTags(repo: string): Promise<ReleaseTagInfo[]>;
  /** The main commit last fetched (origin/main), without fetching. */
  readMainCommit(repo: string): Promise<string | null>;
  readRestartReport(): HotRestartReport | null;
  /** True once this server finished startup recovery (hot-restart adoption writes its report before that). */
  startupRecoveryReady(): boolean;
  /** Agent names and issue identifiers for the flagged-run list. */
  describeRuns(runIds: string[]): Promise<Map<string, { agentName: string | null; issueIdentifier: string | null }>>;
  findRun(runId: string): Promise<{ companyId: string; agentId: string; status: string } | null>;
  findAgent(agentId: string): Promise<{ companyId: string; title: string | null } | null>;
  /** Agent ids that may edit the next title besides the board (GSAM_RELEASE_MANAGER_AGENT_IDS). */
  releaseManagerAgentIds: string[];
}

/** The agent titled "Release Manager" (Keystone), or one named in GSAM_RELEASE_MANAGER_AGENT_IDS. */
export const RELEASE_MANAGER_TITLE_RE = /^release manager$/i;

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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Jobs written by the GRE-39 version (rcTag, waiting_for_runs, finished) read as today's shape. */
function normalizeJob(raw: Record<string, unknown>, result: LiveReleaseResult | null): LiveReleaseJob {
  const job = { ...raw } as unknown as LiveReleaseJob & { rcTag?: string };
  job.kind ??= "release";
  job.tag ??= job.rcTag ?? "";
  job.title ??= null;
  job.commit ??= null;
  job.issueId ??= null;
  job.interactionId ??= null;
  job.startedBy ??= (raw.acceptedByUserId as string | undefined) ?? null;
  job.reason ??= null;
  job.previousTag ??= null;
  job.liveTag ??= null;
  job.waitingForFlaggedRuns ??= null;
  job.overridden ??= false;
  job.restartReport ??= null;
  job.cutTag ??= false;
  job.updatedAt ??= job.finishedAt ?? job.createdAt;
  const state = raw.state as string;
  if (state === "waiting_for_runs") job.state = "holding";
  if (state === "finished") {
    job.state = result?.outcome === "released" ? "healthy" : result?.outcome === "rolled_back" ? "rolled_back" : "failed";
  }
  delete job.rcTag;
  return job;
}

export function summarizeRestartReport(report: HotRestartReport): RestartReportSummary {
  return {
    completedAt: report.completedAt,
    resumedRunIds: [...new Set([...report.adoptedRunIds, ...report.finalizedWhileDownRunIds])],
    adoptedRunIds: report.adoptedRunIds,
    finishedWhileDownRunIds: report.finalizedWhileDownRunIds,
    lostRunIds: report.lostRunIds,
  };
}

/** Same rule as titleProblem in scripts/greatstone-candidate.mjs, plus a length limit. */
export function nextTitleProblem(title: unknown): string | null {
  if (typeof title !== "string" || !title.trim()) return "a title is required";
  const t = title.trim();
  if (t.includes("\n")) return "the title must be one line";
  if (t.length > NEXT_TITLE_MAX_LENGTH) return `the title must be at most ${NEXT_TITLE_MAX_LENGTH} characters`;
  if (/^release candidate\b/i.test(t) || /^(rc|live)-\d/.test(t)) return `"${t}" is not a title; say in plain words what this release brings`;
  return null;
}

/** A title from the changes: the first two lines, features first. */
export function proposeTitle(changes: Array<{ kind: "feature" | "fix"; title: string }>): string {
  const ordered = [...changes.filter((c) => c.kind === "feature"), ...changes.filter((c) => c.kind === "fix")];
  const heads = ordered.slice(0, 2).map((c) => c.title);
  const more = ordered.length - heads.length;
  const title = `${heads.join("; ")}${more > 0 ? ` and ${more} more` : ""}`;
  return title.length > NEXT_TITLE_MAX_LENGTH ? `${title.slice(0, NEXT_TITLE_MAX_LENGTH - 1)}…` : title;
}

function changelogOf(message: string | ReleaseNotes | null, tag: string): { title: string; changelog: Changelog } {
  const notes = typeof message === "object" && message !== null ? message : parseReleaseNotes(message, tag);
  const line = (e: { summary: string; pr: number | null; issue: string | null }) => {
    const refs = [e.pr ? `#${e.pr}` : null, e.issue].filter(Boolean);
    return refs.length ? `${e.summary} (${refs.join(", ")})` : e.summary;
  };
  return { title: notes.title, changelog: { features: notes.features.map(line), fixes: notes.fixes.map(line) } };
}

export function describeLiveReleaseResult(job: LiveReleaseJob, result: LiveReleaseResult, jobDir: string): string {
  const previous = result.previousTag ?? "the previous live tag";
  const backup = result.backupFile ? ` Database backup from before the release: \`${result.backupFile}\`.` : "";
  const reason = result.message ? `: ${result.message}` : "";
  const what = job.kind === "rollback" ? `Rollback to ${job.tag}` : `Release of ${job.tag}`;
  switch (result.outcome) {
    case "released":
      return job.kind === "rollback"
        ? `Rolled back to ${job.tag}. \`/api/health\` reports commit \`${result.commit ?? "?"}\`.${backup}`
        : `Released ${job.tag} as ${result.liveTag ?? "a new live tag"}. \`/api/health\` reports commit \`${result.commit ?? "?"}\`.${backup} Roll back from the Releases page to ${previous}.`;
    case "not_released":
      return `Not released${reason}. Live is unchanged. Agent runs are back on.`;
    case "rolled_back":
      return `${what} failed${reason}. Rolled back to ${previous} automatically.${backup} Logs: \`${jobDir}\`.`;
    case "rollback_failed":
      return `${what} failed and the automatic rollback to ${previous} also failed${reason}. Live may be down. John: run \`scripts/greatstone-release.sh ${previous}\` from the dev checkout.${backup} Logs: \`${jobDir}\`.`;
  }
}

function stateOfResult(result: LiveReleaseResult): ReleaseState {
  switch (result.outcome) {
    case "released":
      return "healthy";
    case "rolled_back":
      return "rolled_back";
    default:
      return "failed";
  }
}

export function createLiveReleaseService(deps: LiveReleaseDeps) {
  const jobsDir = path.join(deps.stateDir, "jobs");
  const holdFile = path.join(deps.stateDir, "hold.json");
  const liveFile = path.join(deps.stateDir, "live.json");
  const nextTitleFile = path.join(deps.stateDir, "next-title.json");
  const flags = createRunUpdateFlagStore(path.join(deps.stateDir, "run-flags.json"));
  let queue: Promise<unknown> = Promise.resolve();
  // One step at a time, so a start, a cancel and a tick never act on the same job at once.
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const turn = queue.then(work, work);
    queue = turn.catch(() => undefined);
    return turn;
  };
  /** The pre-flight in progress; never stored, since a failed one changes nothing. */
  let checking: ReleaseProgress | null = null;
  const cache = new Map<string, { at: number; value: unknown }>();
  /** Bumped when this server adds a tag, so the page sees it at once. */
  let tagsVersion = 0;
  const cached = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key);
    const now = deps.now().getTime();
    if (hit && now - hit.at < LIVE_RELEASE_OVERVIEW_CACHE_MS) return hit.value as T;
    const value = await load();
    cache.set(key, { at: now, value });
    return value;
  };

  const jobDir = (id: string) => path.join(jobsDir, id);
  const saveJob = (job: LiveReleaseJob) => {
    job.updatedAt = deps.now().toISOString();
    writeJson(path.join(jobDir(job.id), "job.json"), job);
  };
  const listJobs = (): LiveReleaseJob[] => {
    if (!fs.existsSync(jobsDir)) return [];
    return fs
      .readdirSync(jobsDir)
      .map((id) => {
        const raw = readJson<Record<string, unknown>>(path.join(jobsDir, id, "job.json"));
        return raw ? normalizeJob(raw, readJson<LiveReleaseResult>(path.join(jobsDir, id, "result.json"))) : null;
      })
      .filter((job): job is LiveReleaseJob => job !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  };
  const activeJob = () => listJobs().find((job) => !FINAL_RELEASE_STATES.has(job.state)) ?? null;

  const toProgress = (job: LiveReleaseJob): ReleaseProgress => ({
    id: job.id,
    kind: job.kind,
    targetTag: job.tag,
    targetTitle: job.title,
    state: job.state,
    waitingForFlaggedRuns: job.state === "holding" ? job.waitingForFlaggedRuns : null,
    overridden: job.overridden,
    reason: job.reason,
    previousTag: job.previousTag,
    liveTag: job.liveTag,
    restartReport: job.restartReport,
    startedAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedBy: job.startedBy,
  });

  const enabledProblem = (): string | null => {
    const live = realpathOrNull(deps.liveDir);
    const server = realpathOrNull(deps.serverRepoRoot);
    if (!live || !server || live !== server) {
      return `release is off on this server: it does not run from ${deps.liveDir}`;
    }
    return null;
  };

  const readHold = () => readJson<LiveReleaseHold>(holdFile);

  const releaseHold = () => {
    const hold = readHold();
    fs.rmSync(holdFile, { force: true });
    if (hold) deps.liftHold(new Date(hold.startedAt));
  };

  const comment = async (job: LiveReleaseJob, body: string) => {
    if (!job.issueId) return;
    try {
      await deps.postComment(job.issueId, body);
    } catch (err) {
      logger.warn({ err, jobId: job.id, issueId: job.issueId }, "live release: failed to post on the issue");
    }
  };

  /** An rc-* tag this server cut and never released stays out of the release repo (GRE-239). */
  const dropCutTag = async (repo: string, tag: string) => {
    try {
      await deps.deleteUnpushedTag(repo, tag);
      tagsVersion += 1;
    } catch (err) {
      logger.warn({ err, tag }, "live release: could not delete an unreleased candidate tag");
    }
  };

  const finish = async (job: LiveReleaseJob, state: ReleaseState, reason: string | null, body: string) => {
    job.state = state;
    job.reason = reason;
    job.finishedAt = deps.now().toISOString();
    saveJob(job);
    releaseHold();
    // Stopped before the launcher started: the release script never saw the tag.
    if (job.cutTag && !job.launcherStartedAt) await dropCutTag(job.releaseRepo, job.tag);
    await comment(job, body);
  };

  const flaggedRunningRunIds = async () => {
    const all = flags.list();
    if (all.length === 0) return [];
    const running = new Set(await deps.runningRunIds(all.map((f) => f.runId)));
    // A flag only matters while its run runs; drop the others.
    for (const f of all) if (!running.has(f.runId)) flags.clear(f.runId);
    return [...running];
  };

  const storedNextTitle = (baseTag: string | null) => {
    const stored = readJson<StoredNextTitle>(nextTitleFile);
    return stored && stored.baseTag === baseTag ? stored : null;
  };

  /**
   * Release (an rc-* tag, or origin/main when `tag` is empty) or roll back (a
   * live-* tag). The "Update live?" card and the Releases page both call this.
   * Pre-flight runs before any run is held; a failure changes nothing.
   */
  const start = (input: {
    kind: ReleaseKind;
    tag?: string | null;
    title?: string | null;
    actor: { actorType: string; actorId: string };
    issueId?: string | null;
    interactionId?: string | null;
  }): Promise<StartReleaseResult> =>
    serial(async () => {
      const fail = (status: 403 | 409 | 422, error: string): StartReleaseResult => ({ ok: false, status, error });
      if (input.actor.actorType !== "user") return fail(403, "only a person can release or roll back");
      const fromMain = input.kind === "release" && !input.tag;
      if (!fromMain) {
        const problem = tagKindProblem(input.kind, input.tag);
        if (problem) return fail(422, problem);
      }
      if (fromMain && input.title != null) {
        const problem = nextTitleProblem(input.title);
        if (problem) return fail(422, problem);
      }
      const off = enabledProblem();
      if (off) return fail(409, off);
      const busy = activeJob();
      if (busy) return fail(409, `the ${busy.kind} to ${busy.tag} is still in progress`);

      const now = deps.now();
      checking = {
        id: "checking",
        kind: input.kind,
        targetTag: input.tag ?? null,
        targetTitle: null,
        state: "checking",
        waitingForFlaggedRuns: null,
        overridden: false,
        reason: null,
        previousTag: null,
        liveTag: null,
        restartReport: null,
        startedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        startedBy: input.actor.actorId,
      };
      try {
        const repo = deps.resolveReleaseRepo();
        const prepared = await deps.prepareRepo(repo);
        if (!prepared.ok) return fail(409, prepared.reason);
        const releaseRepo = repo!;
        const live = deps.readRunningCommit();
        let tag = input.tag ?? "";
        if (fromMain) {
          if (live?.commit === prepared.mainCommit) return fail(409, "live already runs origin/main; nothing to release");
          const ci = await deps.readForkCi(releaseRepo, prepared.mainCommit);
          if (ci.status !== "passed") {
            return fail(409, `Fork CI on main (${prepared.mainCommit.slice(0, 9)}) is ${ci.status === "unknown" ? "not known (gh could not read it)" : ci.status}; release when it has passed`);
          }
          let title = input.title?.trim() || storedNextTitle(live?.tag ?? null)?.title || null;
          try {
            if (!title) {
              const preview = await deps.runCandidate(releaseRepo, { tag: "rc-0000-00-00.0", title: "Next", since: live?.tag ?? null, print: true });
              title = proposeTitle(preview.changes.map((c) => ({ kind: c.kind, title: c.line.replace(/\s*\([^()]*\)\s*$/, "") })));
            }
            tag = await deps.nextTagName(releaseRepo);
            await deps.runCandidate(releaseRepo, { tag, title, since: live?.tag ?? null, print: false });
          } catch (err) {
            return fail(409, `could not cut a candidate from origin/main: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        const target = await deps.checkTarget({ repo: releaseRepo, kind: input.kind, tag, liveCommit: live?.commit ?? null });
        if (!target.ok) {
          if (fromMain) await dropCutTag(releaseRepo, tag);
          return fail(409, target.reason);
        }

        const job: LiveReleaseJob = {
          id: `${now.toISOString().replace(/[:.]/g, "")}-${randomUUID().slice(0, 8)}`,
          kind: input.kind,
          tag,
          title: target.title,
          commit: target.targetCommit,
          issueId: input.issueId ?? null,
          interactionId: input.interactionId ?? null,
          startedBy: input.actor.actorId,
          releaseRepo,
          state: "holding",
          reason: null,
          previousTag: live?.tag ?? null,
          liveTag: null,
          waitingForFlaggedRuns: null,
          overridden: false,
          restartReport: null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          waitDeadline: new Date(now.getTime() + LIVE_RELEASE_WAIT_FOR_RUNS_MS).toISOString(),
          switchDeadline: null,
          launcherStartedAt: null,
          finishedAt: null,
          cutTag: fromMain,
        };
        saveJob(job);
        // The hold outlives the longest wait plus the longest switch, then lapses.
        const hold = {
          startedAt: now,
          expiresAt: new Date(now.getTime() + LIVE_RELEASE_WAIT_FOR_RUNS_MS + LIVE_RELEASE_SWITCH_MS),
        };
        writeJson(holdFile, { jobId: job.id, startedAt: hold.startedAt.toISOString(), expiresAt: hold.expiresAt.toISOString() });
        deps.applyHold(hold);
        await step(job);
        const what = job.kind === "rollback" ? `Rollback to ${tag}` : `Update live to ${tag}`;
        await comment(job, `${what} started. New agent runs are on hold. Running runs continue through a hot restart; the switch waits only for runs flagged "finish before update" (${job.waitingForFlaggedRuns ?? 0} now, at most ${LIVE_RELEASE_WAIT_FOR_RUNS_MS / 60000} min).`);
        return { ok: true, job, progress: toProgress(job) };
      } finally {
        checking = null;
      }
    });

  const step = async (job: LiveReleaseJob) => {
    const now = deps.now();
    const dir = jobDir(job.id);
    if (job.state === "holding") {
      const flagged = (await flaggedRunningRunIds()).length;
      job.waitingForFlaggedRuns = flagged;
      if (flagged > 0 && !job.overridden) {
        if (now.getTime() >= Date.parse(job.waitDeadline)) {
          const reason = `${flagged} run(s) flagged "finish before update" still running after ${LIVE_RELEASE_WAIT_FOR_RUNS_MS / 60000} min`;
          await finish(job, "failed", reason, `Not released: ${reason}. Live is unchanged and agent runs are back on.`);
          return;
        }
        saveJob(job);
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
          tag: job.tag,
          releaseRepo: job.releaseRepo,
        });
      } catch (err) {
        const reason = `the release launcher did not start (${err instanceof Error ? err.message : String(err)})`;
        await finish(job, "failed", reason, `Not released: ${reason}. Live is unchanged.`);
      }
      return;
    }
    if (job.state === "switching" || job.state === "restarting") {
      const result = readJson<LiveReleaseResult>(path.join(dir, "result.json"));
      if (result) {
        const report = deps.readRestartReport();
        const fresh = report && job.launcherStartedAt && Date.parse(report.requestedAt) >= Date.parse(job.launcherStartedAt);
        // The launcher writes result.json once health shows the new process,
        // which can be before this server's startup recovery has adopted the
        // runs and written the report (GRE-242). Wait for it; the next tick records.
        if (!fresh && !deps.startupRecoveryReady()) return;
        if (fresh) job.restartReport = summarizeRestartReport(report);
        job.liveTag = result.outcome === "released" ? (result.liveTag ?? (job.kind === "rollback" ? job.tag : null)) : null;
        job.previousTag = result.previousTag ?? job.previousTag;
        const state = stateOfResult(result);
        const lost = job.restartReport?.lostRunIds.length ? ` ${job.restartReport.lostRunIds.length} run(s) were lost in the restart: ${job.restartReport.lostRunIds.join(", ")}.` : "";
        await finish(job, state, state === "healthy" ? null : (result.message ?? result.outcome), `${describeLiveReleaseResult(job, result, dir)}${lost}`);
        return;
      }
      const phase = fs.existsSync(path.join(dir, "phase")) ? fs.readFileSync(path.join(dir, "phase"), "utf8").trim() : "";
      if (phase === "restarting" && job.state === "switching") {
        job.state = "restarting";
        saveJob(job);
      }
      const pid = Number.parseInt(fs.existsSync(path.join(dir, "launcher.pid")) ? fs.readFileSync(path.join(dir, "launcher.pid"), "utf8") : "", 10);
      const pastDeadline = job.switchDeadline !== null && now.getTime() >= Date.parse(job.switchDeadline);
      // Give the launcher a moment to write its pid before calling it lost.
      const started = job.launcherStartedAt ? Date.parse(job.launcherStartedAt) : now.getTime();
      const launcherLost = now.getTime() - started > 60_000 && !(Number.isFinite(pid) && deps.isProcessAlive(pid));
      if (pastDeadline || launcherLost) {
        const reason = `the ${job.kind} gave no result (${pastDeadline ? "time limit reached" : "the launcher stopped"})`;
        await finish(
          job,
          "failed",
          reason,
          `The ${job.kind} to ${job.tag} gave no result (${pastDeadline ? "time limit reached" : "the launcher stopped"}). Check \`/api/health\` and the logs in \`${dir}\`; roll back from the Releases page if live is wrong. Agent runs are back on.`,
        );
      }
    }
  };

  /** Stops a job that is still holding; live stays as it is. */
  const cancel = (actor: { actorType: string; actorId: string }) =>
    serial(async (): Promise<StartReleaseResult> => {
      const job = activeJob();
      if (!job || job.state !== "holding") {
        return { ok: false, status: 409, error: job ? `the ${job.kind} to ${job.tag} is ${job.state}; only a holding one can be cancelled` : "no release is in progress" };
      }
      await finish(job, "cancelled", `cancelled by ${actor.actorId}`, `The ${job.kind} to ${job.tag} was cancelled. Live is unchanged and agent runs are back on.`);
      return { ok: true, job, progress: toProgress(job) };
    });

  /** The board releases without waiting for flagged runs. */
  const override = (actor: { actorType: string; actorId: string }) =>
    serial(async (): Promise<StartReleaseResult> => {
      const job = activeJob();
      if (!job || job.state !== "holding") {
        return { ok: false, status: 409, error: job ? `the ${job.kind} to ${job.tag} is ${job.state}; only a holding one waits for flagged runs` : "no release is in progress" };
      }
      job.overridden = true;
      saveJob(job);
      await comment(job, `${actor.actorId} chose not to wait for flagged runs.`);
      await step(job);
      return { ok: true, job, progress: toProgress(job) };
    });

  /**
   * Called after a request_confirmation is accepted. Does nothing unless the
   * card is an "Update live?" card. Uses start(), the same path as the page.
   */
  const onConfirmationAccepted = async (input: {
    issueId: string;
    interaction: { id: string; kind: string; status: string; idempotencyKey?: string | null };
    actor: { actorType: string; actorId: string };
  }) => {
    const { interaction } = input;
    if (interaction.kind !== "request_confirmation" || interaction.status !== "accepted") return null;
    const rcTag = parseLiveReleaseKey(interaction.idempotencyKey);
    if (!rcTag) return null;
    const result = await start({ kind: "release", tag: rcTag, actor: input.actor, issueId: input.issueId, interactionId: interaction.id });
    if (!result.ok) {
      await deps.postComment(input.issueId, `Not released: ${result.error}. Live is unchanged.`);
      return null;
    }
    return result.job;
  };

  /** Advances every open release. Runs on an interval and once at start. */
  const tick = () =>
    serial(async () => {
      for (const job of listJobs()) {
        if (FINAL_RELEASE_STATES.has(job.state)) continue;
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
    const job = listJobs().find((j) => j.id === hold.jobId);
    if (!job || FINAL_RELEASE_STATES.has(job.state) || !(expiresAt.getTime() > deps.now().getTime())) {
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

  /** What would ship from origin/main now, or null when main is live (or unknown). */
  const readNext = async (repo: string, live: { commit: string; tag: string | null } | null): Promise<NextVersion | null> => {
    const mainCommit = await deps.readMainCommit(repo);
    if (!mainCommit || mainCommit === live?.commit) return null;
    const preview = await cached(`next:${mainCommit}:${live?.tag ?? ""}`, async () => {
      try {
        return await deps.runCandidate(repo, { tag: "rc-0000-00-00.0", title: "Next", since: live?.tag ?? null, print: true });
      } catch (err) {
        if (err instanceof Error && NOTHING_MERGED_RE.test(err.message)) return null;
        throw err;
      }
    });
    if (!preview) return null;
    const changes = preview.changes.map((c) => ({
      pr: c.pr,
      issue: c.issue,
      title: c.line.replace(/\s*\([^()]*\)\s*$/, ""),
      kind: c.kind,
      commit: c.sha,
    }));
    const stored = storedNextTitle(live?.tag ?? null);
    return {
      baseTag: live?.tag ?? preview.since ?? null,
      commit: mainCommit,
      proposedTitle: stored?.title ?? proposeTitle(changes),
      titleEditedBy: stored?.editedBy ?? null,
      titleEditedAt: stored?.editedAt ?? null,
      changelog: {
        features: preview.changes.filter((c) => c.kind === "feature").map((c) => c.line),
        fixes: preview.changes.filter((c) => c.kind === "fix").map((c) => c.line),
      },
      changes,
      forkCi: await cached(`ci:${mainCommit}`, () => deps.readForkCi(repo, mainCommit)),
    };
  };

  /** Stores the title for the next release. The route checks who may. */
  const setNextTitle = async (input: { title: unknown; editedBy: string }) => {
    const problem = nextTitleProblem(input.title);
    if (problem) return { ok: false as const, status: 422 as const, error: problem };
    const live = deps.readRunningCommit();
    const stored: StoredNextTitle = {
      title: (input.title as string).trim(),
      baseTag: live?.tag ?? null,
      editedBy: input.editedBy,
      editedAt: deps.now().toISOString(),
    };
    writeJson(nextTitleFile, stored);
    const repo = deps.resolveReleaseRepo();
    return { ok: true as const, next: repo ? await readNext(repo, live).catch(() => null) : null };
  };

  const listFlaggedRuns = async (companyId: string): Promise<FlaggedRunView[]> => {
    const running = new Set(await flaggedRunningRunIds());
    const mine = flags.list().filter((f) => f.companyId === companyId && running.has(f.runId));
    const names = await deps.describeRuns(mine.map((f) => f.runId));
    return mine.map((f) => ({ ...f, agentName: names.get(f.runId)?.agentName ?? null, issueIdentifier: names.get(f.runId)?.issueIdentifier ?? null }));
  };

  /** GET /api/companies/:companyId/releases. */
  const overview = async (companyId: string): Promise<ReleasesOverview> => {
    const jobs = listJobs();
    const latest = jobs[0] ?? null;
    const disabledReason = enabledProblem();
    const running = deps.readRunningCommit();
    const repo = deps.resolveReleaseRepo();
    const tags = repo ? await cached(`tags:${tagsVersion}:${jobs.length}:${latest?.updatedAt ?? ""}`, () => deps.readTags(repo).catch(() => [])) : [];
    // A failure is moot once live runs the version it names, by a later card or by hand (GRE-179).
    const failedTarget = latest && (latest.state === "failed" || latest.state === "rolled_back")
      ? (latest.commit ?? tags.find((t) => t.tag === latest.tag)?.commit ?? null)
      : null;
    const failureMoot = failedTarget !== null && failedTarget === running?.commit;
    const progress = checking ?? (latest && !failureMoot ? toProgress(latest) : null);
    const releasedBy = (tag: string | null) => (tag ? (jobs.find((j) => j.liveTag === tag && j.state === "healthy")?.startedBy ?? null) : null);
    const reportOf = (tag: string) => jobs.find((j) => j.liveTag === tag)?.restartReport ?? null;
    // Before GRE-239 a release that failed after the switch still pushed its
    // live-* tag. Such a tag never ran: a job to its commit failed after the
    // launcher started, no job made it healthy, and live does not run it now.
    const neverRan = (tag: string, commit: string) =>
      running?.commit !== commit &&
      !jobs.some((j) => j.liveTag === tag && j.state === "healthy") &&
      jobs.some((j) => j.kind === "release" && j.commit === commit && j.launcherStartedAt !== null && (j.state === "failed" || j.state === "rolled_back"));

    const liveTags = tags.filter((t) => LIVE_TAG_RE.test(t.tag));
    const rcTags = tags.filter((t) => RC_TAG_RE.test(t.tag));
    const stableTags = tags.filter((t) => STABLE_TAG_RE.test(t.tag));
    // A live tag with no notes of its own shows those of the rc tag on its commit
    // (GRE-178). The tag itself is never moved or re-written.
    const liveNotes = (message: string | null, tag: string, commit: string | null): ReleaseNotes => {
      const own = parseReleaseNotes(message, tag);
      if (hasOwnReleaseNotes(own) || !commit) return own;
      for (const rc of rcTags) {
        if (rc.commit !== commit) continue;
        const notes = parseReleaseNotes(rc.message, rc.tag);
        if (hasOwnReleaseNotes(notes)) return notes;
      }
      return own;
    };
    const history = liveTags.map((t) => {
      const { title, changelog } = changelogOf(liveNotes(t.message, t.tag, t.commit), t.tag);
      return {
        tag: t.tag,
        title,
        date: t.date,
        commit: t.commit,
        releasedBy: releasedBy(t.tag),
        changelog,
        candidateTag: rcTags.find((rc) => rc.commit === t.commit)?.tag ?? null,
        stableTag: stableTags.find((st) => st.commit === t.commit)?.tag ?? null,
        restartReport: reportOf(t.tag),
        neverRan: neverRan(t.tag, t.commit),
      };
    });

    let live: ReleasesOverview["live"] = null;
    if (running) {
      const tagInfo = running.tag ? tags.find((t) => t.tag === running.tag) : undefined;
      const notes = running.tag ? changelogOf(liveNotes(tagInfo?.message ?? null, running.tag, tagInfo?.commit ?? running.commit), running.tag) : null;
      live = {
        tag: running.tag,
        title: notes?.title ?? null,
        date: tagInfo?.date ?? lastLiveStart()?.startedAt ?? null,
        commit: running.commit,
        health: disabledReason ? "unknown" : "healthy",
        releasedBy: releasedBy(running.tag),
        changelog: notes?.changelog ?? { features: [], fixes: [] },
      };
    }

    let next: NextVersion | null = null;
    if (repo) {
      try {
        next = await readNext(repo, running);
      } catch (err) {
        logger.warn({ err }, "live release: could not read the next version");
      }
    }

    return { live, history, next, flaggedRuns: await listFlaggedRuns(companyId), progress, disabledReason };
  };

  /**
   * "Finish before update" on a run. The route checks who may. Only a running
   * run can be flagged; clearing is always allowed.
   */
  const setRunFlag = async (input: { runId: string; companyId: string; agentId: string; enabled: boolean; reason?: string | null; by: string }) => {
    if (!input.enabled) {
      flags.clear(input.runId);
      return { ok: true as const, flag: null };
    }
    const [running] = await deps.runningRunIds([input.runId]);
    if (!running) return { ok: false as const, status: 409 as const, error: "only a running run can be flagged" };
    const flag = flags.set(input.runId, {
      companyId: input.companyId,
      agentId: input.agentId,
      reason: input.reason?.trim() || null,
      flaggedAt: deps.now().toISOString(),
      flaggedBy: input.by,
    });
    return { ok: true as const, flag };
  };

  /**
   * "Promote to Stable" (GRE-127): an annotated stable-YYYY-MM-DD.N tag on the
   * commit of a live-* release, with the client notes as its message. The
   * route checks who may (board, and the password again in login mode).
   */
  const promote = (input: { liveTag: unknown; notes: unknown }): Promise<PromoteResult> =>
    serial(async () => {
      const off = enabledProblem();
      if (off) return { ok: false, status: 409, error: off.replace(/^release is off/, "promote is off") };
      if (typeof input.liveTag !== "string" || !LIVE_TAG_RE.test(input.liveTag)) {
        return { ok: false, status: 422, error: "promote needs a live-YYYY-MM-DD.N tag" };
      }
      const liveTag = input.liveTag;
      const problem = clientNotesProblem(input.notes);
      if (problem) return { ok: false, status: 422, error: problem };
      const notes = (input.notes as string).trim();
      const repo = deps.resolveReleaseRepo();
      // Fetches tags, so the .N counter and the "already promoted" check see origin.
      const prepared = await deps.prepareRepo(repo);
      if (!prepared.ok) return { ok: false, status: 409, error: prepared.reason };
      const tags = await deps.readTags(repo!);
      const live = tags.find((t) => t.tag === liveTag);
      if (!live) return { ok: false, status: 422, error: `tag ${liveTag} does not exist` };
      const already = tags.find((t) => STABLE_TAG_RE.test(t.tag) && t.commit === live.commit);
      if (already) return { ok: false, status: 409, error: `${liveTag} is already on Stable as ${already.tag}` };
      const tag = await deps.nextStableTagName(repo!);
      try {
        await deps.createStableTag(repo!, { tag, commit: live.commit, notes });
      } catch (err) {
        return { ok: false, status: 502, error: err instanceof Error ? err.message : String(err) };
      }
      tagsVersion += 1;
      return { ok: true, stable: { tag, commit: live.commit, liveTag } };
    });

  /** Board, or the release manager agent of this company, may edit the next title. */
  const isReleaseManagerAgent = async (companyId: string, agentId: string) => {
    const agent = await deps.findAgent(agentId);
    if (!agent || agent.companyId !== companyId) return false;
    return deps.releaseManagerAgentIds.includes(agentId) || RELEASE_MANAGER_TITLE_RE.test(agent.title?.trim() ?? "");
  };

  return {
    start,
    cancel,
    isReleaseManagerAgent,
    findRun: deps.findRun,
    override,
    overview,
    promote,
    setNextTitle,
    setRunFlag,
    onConfirmationAccepted,
    tick,
    restoreHold,
    listJobs,
    holdFile,
    recordLiveStart,
    lastLiveStart,
    isLive,
  };
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
  return repoIsAncestor(repo, sha, commit);
}

/** git merge-base --is-ancestor: true / false, or null when git cannot tell. */
function repoIsAncestor(repo: string, ancestor: string, commit: string): boolean | null {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, commit], { cwd: repo, stdio: "ignore", timeout: 10_000 });
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
    // GSAM_RELEASE_REPO or ~/GSAM/release.conf; never the preview state (GRE-71).
    resolveReleaseRepo: () => resolveReleaseRepoFrom(env, gsamRoot),
    now: () => new Date(),
    runningRunIds: async (runIds) => {
      if (runIds.length === 0) return [];
      const rows = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(inArray(heartbeatRuns.id, runIds), eq(heartbeatRuns.status, "running")));
      return rows.map((row) => row.id);
    },
    postComment: async (issueId, body) => {
      await issues.addComment(issueId, body, {}, { authorType: "system" });
    },
    applyHold: (hold) => applyTaskDrain(hold),
    liftHold: (startedAt) => {
      if (getTaskDrainStatus().startedAt?.getTime() === startedAt.getTime()) stopTaskDrain();
    },
    startLauncher: ({ launcher, jobDir, tag, releaseRepo }) => {
      // detached: a new session, so the live server's restart does not stop it.
      const child = spawn("bash", [launcher, jobDir, tag, releaseRepo], {
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
    prepareRepo: prepareReleaseRepo,
    checkTarget: checkReleaseTarget,
    runCandidate: runCandidateScript,
    nextTagName: (repo) => nextCandidateTagName(repo, new Date()),
    deleteUnpushedTag,
    nextStableTagName: (repo) => nextStableTagName(repo, new Date()),
    createStableTag,
    readForkCi,
    readTags: readReleaseTags,
    readMainCommit: async (repo) => git(repo, ["rev-parse", "--verify", "--quiet", "origin/main^{commit}"]),
    readRestartReport: () => readHotRestartReportSync(),
    startupRecoveryReady: () => getStartupRecoveryState().phase === "ready",
    describeRuns: async (runIds) => {
      const out = new Map<string, { agentName: string | null; issueIdentifier: string | null }>();
      if (runIds.length === 0) return out;
      const rows = await db
        .select({ id: heartbeatRuns.id, agentName: agents.name, context: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .leftJoin(agents, eq(agents.id, heartbeatRuns.agentId))
        .where(inArray(heartbeatRuns.id, runIds));
      const issueIds = rows.map((r) => r.context?.issueId).filter((v): v is string => typeof v === "string");
      const identifiers = issueIds.length
        ? new Map(
            (await db.select({ id: issuesTable.id, identifier: issuesTable.identifier }).from(issuesTable).where(inArray(issuesTable.id, issueIds))).map(
              (r) => [r.id, r.identifier],
            ),
          )
        : new Map<string, string | null>();
      for (const r of rows) {
        const issueId = typeof r.context?.issueId === "string" ? r.context.issueId : null;
        out.set(r.id, { agentName: r.agentName ?? null, issueIdentifier: issueId ? (identifiers.get(issueId) ?? null) : null });
      }
      return out;
    },
    findRun: async (runId) => {
      const [row] = await db
        .select({ companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      return row ?? null;
    },
    findAgent: async (agentId) => {
      const [row] = await db.select({ companyId: agents.companyId, title: agents.title }).from(agents).where(eq(agents.id, agentId));
      return row ?? null;
    },
    releaseManagerAgentIds: (env.GSAM_RELEASE_MANAGER_AGENT_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean),
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
