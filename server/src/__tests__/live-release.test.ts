import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LIVE_RELEASE_SWITCH_MS,
  LIVE_RELEASE_WAIT_FOR_RUNS_MS,
  createLiveReleaseService,
  isReleaseRef,
  parseLiveReleaseKey,
  proposeTitle,
  type LiveReleaseDeps,
  type LiveReleaseEvent,
} from "../services/live-release.ts";
import { parseReleaseQuestionRef } from "../services/live-release-announce.ts";
import type { HotRestartReport } from "../services/hot-restart.ts";
import type { CandidateCut, ReleaseTagInfo } from "../services/release-repo.ts";

// Everything runs in a temp sandbox: no ~/GSAM path is read or written, and
// git and gh are replaced by fakes (release-repo.test.ts covers the real ones).
let root: string;
let clock: Date;
let runningRuns: Set<string>;
let comments: string[];
let holds: Array<{ startedAt: Date; expiresAt: Date }>;
let lifted: Date[];
let launches: Array<{ jobDir: string; tag: string }>;
let runningCommit: { commit: string; tag: string | null } | null;
let announced: LiveReleaseEvent[];
let prepareProblem: string | null;
let targetProblem: string | null;
let targetChecks: Array<{ kind: string; tag: string }>;
let mainCommit: string;
let forkCi: "passed" | "failed" | "pending" | "unknown";
let candidates: Array<{ tag: string; title: string; since: string | null; print: boolean }>;
let restartReport: HotRestartReport | null;
let tags: ReleaseTagInfo[];

const CUT: CandidateCut = {
  tag: "rc-x",
  sha: "c".repeat(40),
  since: "live-2026-09-28.1",
  message: "Next\n",
  changes: [
    { sha: "1".repeat(40), pr: 51, issue: "GRE-121", kind: "feature", line: "Release from the app (#51, GRE-121)" },
    { sha: "2".repeat(40), pr: 52, issue: "GRE-71", kind: "fix", line: "Card works after preview stop (#52, GRE-71)" },
  ],
};

function deps(overrides: Partial<LiveReleaseDeps> = {}): LiveReleaseDeps {
  return {
    stateDir: path.join(root, "instance", "live-release"),
    liveDir: path.join(root, "live"),
    serverRepoRoot: path.join(root, "live"),
    resolveReleaseRepo: () => path.join(root, "dev"),
    now: () => clock,
    runningRunIds: async (ids) => ids.filter((id) => runningRuns.has(id)),
    postComment: async (_issueId, body) => {
      comments.push(body);
    },
    applyHold: (hold) => holds.push(hold),
    liftHold: (startedAt) => lifted.push(startedAt),
    startLauncher: ({ jobDir, tag }) => {
      launches.push({ jobDir, tag });
      fs.writeFileSync(path.join(jobDir, "launcher.pid"), `${process.pid}\n`);
    },
    isProcessAlive: () => true,
    readRunningCommit: () => runningCommit,
    containsRef: (_commit, ref) => ref === "aaaaaaa",
    announce: async (event) => {
      announced.push(event);
    },
    prepareRepo: async (repo) => (prepareProblem ? { ok: false, reason: prepareProblem } : repo ? { ok: true, mainCommit } : { ok: false, reason: "no release repo is set" }),
    checkTarget: async ({ kind, tag }) => {
      targetChecks.push({ kind, tag });
      return targetProblem ? { ok: false, reason: targetProblem } : { ok: true, targetCommit: "b".repeat(40), title: `Title of ${tag}` };
    },
    runCandidate: async (_repo, input) => {
      candidates.push(input);
      return { ...CUT, tag: input.tag };
    },
    nextTagName: async () => "rc-2026-09-28.3",
    readForkCi: async () => ({ status: forkCi, url: "https://ci/run/1" }),
    readTags: async () => tags,
    readMainCommit: async () => mainCommit,
    readRestartReport: () => restartReport,
    describeRuns: async (ids) => new Map(ids.map((id) => [id, { agentName: "Ridge", issueIdentifier: "GRE-99" }])),
    findRun: async () => null,
    findAgent: async () => null,
    releaseManagerAgentIds: [],
    ...overrides,
  };
}

const JOHN = { actorType: "user", actorId: "john" };

const accepted = (idempotencyKey = "live-release:rc-2026-09-27.2", status = "accepted") => ({
  issueId: "issue-1",
  interaction: { id: "interaction-1", kind: "request_confirmation", status, idempotencyKey },
  actor: JOHN,
});

function advance(ms: number) {
  clock = new Date(clock.getTime() + ms);
}

function writeResult(jobDir: string, result: Record<string, unknown>) {
  fs.writeFileSync(path.join(jobDir, "result.json"), JSON.stringify(result));
}

async function flagRun(svc: ReturnType<typeof createLiveReleaseService>, runId: string) {
  runningRuns.add(runId);
  const result = await svc.setRunFlag({ runId, companyId: "co-1", agentId: "agent-1", enabled: true, reason: "mid-migration", by: "agent:agent-1" });
  expect(result.ok).toBe(true);
}

function report(overrides: Partial<HotRestartReport> = {}): HotRestartReport {
  return {
    version: 1,
    requestedAt: clock.toISOString(),
    completedAt: clock.toISOString(),
    drainRequired: true,
    drainReason: "active_acp_run",
    previousServerPid: 1,
    newServerPid: 2,
    previousServerVersion: "a",
    newServerVersion: "b",
    adoptedRunIds: ["run-adopted"],
    finalizedWhileDownRunIds: ["run-acp"],
    lostRunIds: [],
    skippedRunIds: [],
    runs: [],
    ...overrides,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "live-release-"));
  for (const dir of ["live", "dev/scripts"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  clock = new Date("2026-09-27T12:00:00Z");
  runningRuns = new Set(["run-unflagged"]);
  comments = [];
  holds = [];
  lifted = [];
  launches = [];
  runningCommit = { commit: "a".repeat(40), tag: "live-2026-09-28.1" };
  announced = [];
  prepareProblem = null;
  targetProblem = null;
  targetChecks = [];
  mainCommit = "c".repeat(40);
  forkCi = "passed";
  candidates = [];
  restartReport = null;
  tags = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("parseLiveReleaseKey", () => {
  it("accepts only live-release:<rc-tag>", () => {
    expect(parseLiveReleaseKey("live-release:rc-2026-09-27.2")).toBe("rc-2026-09-27.2");
    expect(parseLiveReleaseKey("live-release:rc-2026-09-27.2; rm -rf /")).toBeNull();
    expect(parseLiveReleaseKey("live-release:live-2026-09-27.1")).toBeNull();
    expect(parseLiveReleaseKey("confirmation:x:plan:y")).toBeNull();
    expect(parseLiveReleaseKey(null)).toBeNull();
  });
});

describe("\"Update live?\" card", () => {
  it("rejecting the card changes nothing", async () => {
    const svc = createLiveReleaseService(deps());
    expect(await svc.onConfirmationAccepted(accepted(undefined, "rejected"))).toBeNull();
    await svc.tick();
    expect(comments).toEqual([]);
    expect(holds).toEqual([]);
    expect(launches).toEqual([]);
    expect(svc.listJobs()).toEqual([]);
    expect(fs.existsSync(svc.holdFile)).toBe(false);
  });

  it("ignores other confirmation cards", async () => {
    const svc = createLiveReleaseService(deps());
    expect(await svc.onConfirmationAccepted(accepted("confirmation:issue-1:plan:rev-1"))).toBeNull();
    expect(comments).toEqual([]);
    expect(holds).toEqual([]);
  });

  it("does not release when an agent accepts the card", async () => {
    const svc = createLiveReleaseService(deps());
    await svc.onConfirmationAccepted({ ...accepted(), actor: { actorType: "agent", actorId: "keystone" } });
    expect(holds).toEqual([]);
    expect(launches).toEqual([]);
    expect(comments[0]).toMatch(/only a person/);
  });

  it("is off unless the server runs from the live checkout", async () => {
    fs.mkdirSync(path.join(root, "worktree"));
    const svc = createLiveReleaseService(deps({ serverRepoRoot: path.join(root, "worktree") }));
    await svc.onConfirmationAccepted(accepted());
    expect(holds).toEqual([]);
    expect(launches).toEqual([]);
    expect(comments[0]).toMatch(/release is off on this server/);
  });

  it("goes through start(), the same path as the Releases page", async () => {
    const svc = createLiveReleaseService(deps());
    const job = await svc.onConfirmationAccepted(accepted());
    expect(job).toMatchObject({ kind: "release", tag: "rc-2026-09-27.2", issueId: "issue-1", interactionId: "interaction-1", startedBy: "john" });
    expect(targetChecks).toEqual([{ kind: "release", tag: "rc-2026-09-27.2" }]);
    // A card after it is refused with the same reason the page gets.
    const page = await svc.start({ kind: "release", tag: "rc-2026-09-27.3", actor: JOHN });
    await svc.onConfirmationAccepted({ ...accepted("live-release:rc-2026-09-27.3"), interaction: { ...accepted().interaction, id: "interaction-2", idempotencyKey: "live-release:rc-2026-09-27.3" } });
    expect(page).toMatchObject({ ok: false, status: 409 });
    expect(comments.at(-1)).toBe(`Not released: ${(page as { error: string }).error}. Live is unchanged.`);
  });
});

describe("pre-flight", () => {
  it("returns each failure at once, holds no run and stores no job", async () => {
    const cases: Array<() => void> = [
      () => (prepareProblem = "the release repo /dev has local changes (x.ts); commit or discard them first"),
      () => (prepareProblem = "main in the release repo /dev has commits that are not on origin/main, so it cannot fast-forward; fix the dev checkout first"),
      () => (targetProblem = "tag rc-2026-09-27.2 does not exist"),
      () => (targetProblem = "rc-2026-09-27.2 has no title: it is a lightweight tag"),
      () => (targetProblem = "live is already on rc-2026-09-27.2; nothing to do"),
    ];
    for (const arrange of cases) {
      prepareProblem = null;
      targetProblem = null;
      arrange();
      const svc = createLiveReleaseService(deps());
      const started = Date.now();
      const result = await svc.start({ kind: "release", tag: "rc-2026-09-27.2", actor: JOHN });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result).toEqual({ ok: false, status: 409, error: prepareProblem ?? targetProblem });
      expect(holds).toEqual([]);
      expect(launches).toEqual([]);
      expect(svc.listJobs()).toEqual([]);
      expect((await svc.overview("co-1")).progress).toBeNull();
    }
  });

  it("refuses a tag of the wrong kind with 422", async () => {
    const svc = createLiveReleaseService(deps());
    expect(await svc.start({ kind: "release", tag: "live-2026-09-20.1", actor: JOHN })).toMatchObject({ ok: false, status: 422 });
    expect(await svc.start({ kind: "rollback", tag: "rc-2026-09-27.2", actor: JOHN })).toMatchObject({ ok: false, status: 422 });
    expect(await svc.start({ kind: "rollback", tag: null, actor: JOHN })).toMatchObject({ ok: false, status: 422 });
    expect(await svc.start({ kind: "release", tag: "rc-2026-09-27.2; rm -rf /", actor: JOHN })).toMatchObject({ ok: false, status: 422 });
    expect(holds).toEqual([]);
  });

  it("refuses a second release while one is in progress", async () => {
    const svc = createLiveReleaseService(deps());
    await flagRun(svc, "run-flagged");
    expect((await svc.start({ kind: "release", tag: "rc-2026-09-27.2", actor: JOHN })).ok).toBe(true);
    const second = await svc.start({ kind: "rollback", tag: "live-2026-09-20.1", actor: JOHN });
    expect(second).toEqual({ ok: false, status: 409, error: "the release to rc-2026-09-27.2 is still in progress" });
    expect(holds).toHaveLength(1);
  });
});

describe("holding: hot restart, flagged runs, cancel, override", () => {
  it("does not wait for running runs that are not flagged: the hot restart keeps them", async () => {
    runningRuns.add("run-2");
    const svc = createLiveReleaseService(deps());
    const result = await svc.start({ kind: "release", tag: "rc-2026-09-27.2", actor: JOHN });
    expect(result.ok && result.progress.state).toBe("switching");
    expect(holds).toHaveLength(1);
    expect(launches).toEqual([{ jobDir: expect.any(String), tag: "rc-2026-09-27.2" }]);
    // The hold stays on during the switch.
    expect(lifted).toEqual([]);
  });

  it("waits only for runs flagged finish-before-update", async () => {
    const svc = createLiveReleaseService(deps());
    await flagRun(svc, "run-flagged");
    const result = await svc.start({ kind: "release", tag: "rc-2026-09-27.2", actor: JOHN });
    expect(result.ok && result.progress).toMatchObject({ state: "holding", waitingForFlaggedRuns: 1 });
    expect(fs.existsSync(svc.holdFile)).toBe(true);
    expect((await svc.overview("co-1")).flaggedRuns).toEqual([
      expect.objectContaining({ runId: "run-flagged", agentName: "Ridge", issueIdentifier: "GRE-99", reason: "mid-migration" }),
    ]);

    advance(30 * 60 * 1000);
    await svc.tick();
    expect(launches).toEqual([]);

    runningRuns.delete("run-flagged");
    await svc.tick();
    expect(launches).toHaveLength(1);
    expect(svc.listJobs()[0].state).toBe("switching");
    // The finished run's flag is gone.
    expect((await svc.overview("co-1")).flaggedRuns).toEqual([]);
  });

  it("lets the board release without waiting (override)", async () => {
    const svc = createLiveReleaseService(deps());
    await flagRun(svc, "run-flagged");
    await svc.start({ kind: "release", tag: "rc-2026-09-27.2", actor: JOHN });
    const result = await svc.override(JOHN);
    expect(result.ok && result.progress).toMatchObject({ state: "switching", overridden: true });
    expect(launches).toHaveLength(1);
    expect(await svc.override(JOHN)).toMatchObject({ ok: false, status: 409 });
  });

  it("cancel while holding lifts the hold and leaves live unchanged", async () => {
    const svc = createLiveReleaseService(deps());
    await flagRun(svc, "run-flagged");
    await svc.start({ kind: "release", tag: "rc-2026-09-27.2", actor: JOHN });
    const result = await svc.cancel(JOHN);
    expect(result.ok && result.progress).toMatchObject({ state: "cancelled", reason: "cancelled by john" });
    expect(lifted).toHaveLength(1);
    expect(fs.existsSync(svc.holdFile)).toBe(false);
    runningRuns.delete("run-flagged");
    await svc.tick();
    expect(launches).toEqual([]);
    // A new release may start after a cancel.
    expect((await svc.start({ kind: "release", tag: "rc-2026-09-27.2", actor: JOHN })).ok).toBe(true);
  });

  it("cannot cancel once live is switching", async () => {
    const svc = createLiveReleaseService(deps());
    await svc.start({ kind: "release", tag: "rc-2026-09-27.2", actor: JOHN });
    expect(await svc.cancel(JOHN)).toEqual({ ok: false, status: 409, error: "the release to rc-2026-09-27.2 is switching; only a holding one can be cancelled" });
    const empty = createLiveReleaseService(deps({ stateDir: path.join(root, "other-instance") }));
    expect(await empty.cancel(JOHN)).toMatchObject({ ok: false, error: "no release is in progress" });
  });

  it("gives up after the wait limit, leaves live alone and lifts the hold", async () => {
    const svc = createLiveReleaseService(deps());
    await flagRun(svc, "run-flagged");
    await svc.start({ kind: "release", tag: "rc-2026-09-27.2", actor: JOHN });
    advance(LIVE_RELEASE_WAIT_FOR_RUNS_MS);
    await svc.tick();
    expect(launches).toEqual([]);
    expect(svc.listJobs()[0]).toMatchObject({ state: "failed", reason: expect.stringMatching(/^1 run\(s\) flagged "finish before update" still running/) });
    expect(lifted).toHaveLength(1);
    expect(fs.existsSync(svc.holdFile)).toBe(false);
  });

  it("only a running run can be flagged, and a flag can be cleared", async () => {
    const svc = createLiveReleaseService(deps());
    expect(await svc.setRunFlag({ runId: "run-done", companyId: "co-1", agentId: "a", enabled: true, by: "agent:a" })).toMatchObject({ ok: false, status: 409 });
    await flagRun(svc, "run-flagged");
    await svc.setRunFlag({ runId: "run-flagged", companyId: "co-1", agentId: "a", enabled: false, by: "user:john" });
    expect((await svc.overview("co-1")).flaggedRuns).toEqual([]);
  });
});

describe("progress after the switch", () => {
  it("goes switching → restarting → healthy and keeps the hot-restart report", async () => {
    const svc = createLiveReleaseService(deps());
    await svc.start({ kind: "release", tag: "rc-2026-09-27.2", actor: JOHN });
    const { jobDir } = launches[0];
    fs.writeFileSync(path.join(jobDir, "phase"), "restarting\n");
    await svc.tick();
    expect(svc.listJobs()[0].state).toBe("restarting");

    advance(60_000);
    restartReport = report({ lostRunIds: ["run-lost"] });
    writeResult(jobDir, { outcome: "released", liveTag: "live-2026-09-27.1", commit: "abc123", previousTag: "live-2026-09-20.1" });
    await svc.tick();
    const [job] = svc.listJobs();
    expect(job).toMatchObject({ state: "healthy", liveTag: "live-2026-09-27.1", previousTag: "live-2026-09-20.1", reason: null });
    expect(job.restartReport).toEqual({
      completedAt: clock.toISOString(),
      resumedRunIds: ["run-adopted", "run-acp"],
      adoptedRunIds: ["run-adopted"],
      finishedWhileDownRunIds: ["run-acp"],
      lostRunIds: ["run-lost"],
    });
    expect(lifted).toHaveLength(1);

    tags = [{ tag: "live-2026-09-27.1", commit: "b".repeat(40), date: clock.toISOString(), annotated: true, message: "Title\n\nFeatures\n- A (#1, GRE-1)\n" }];
    const overview = await createLiveReleaseService(deps()).overview("co-1");
    expect(overview.history[0]).toMatchObject({ tag: "live-2026-09-27.1", title: "Title", releasedBy: "john", changelog: { features: ["A (#1, GRE-1)"], fixes: [] } });
    expect(overview.history[0].restartReport?.lostRunIds).toEqual(["run-lost"]);
  });

  it("ignores a hot-restart report from before this release", async () => {
    restartReport = report({ requestedAt: "2026-09-01T00:00:00Z" });
    const svc = createLiveReleaseService(deps());
    await svc.start({ kind: "release", tag: "rc-2026-09-27.2", actor: JOHN });
    writeResult(launches[0].jobDir, { outcome: "released", liveTag: "live-2026-09-27.1" });
    await svc.tick();
    expect(svc.listJobs()[0].restartReport).toBeNull();
  });

  it("reports rolled_back with the reason and the backup path", async () => {
    const svc = createLiveReleaseService(deps());
    await svc.onConfirmationAccepted(accepted());
    const { jobDir } = launches[0];
    writeResult(jobDir, {
      outcome: "rolled_back",
      message: "the live app did not report live-2026-09-27.1 within 3 minutes",
      previousTag: "live-2026-09-20.1",
      backupFile: "/backups/release-x/before-rc.sql.gz",
    });
    await svc.tick();
    expect(comments.at(-1)).toBe(
      `Release of rc-2026-09-27.2 failed: the live app did not report live-2026-09-27.1 within 3 minutes. Rolled back to live-2026-09-20.1 automatically. Database backup from before the release: \`/backups/release-x/before-rc.sql.gz\`. Logs: \`${jobDir}\`.`,
    );
    expect(svc.listJobs()[0]).toMatchObject({ state: "rolled_back", reason: "the live app did not report live-2026-09-27.1 within 3 minutes" });
    expect(lifted).toHaveLength(1);
    // Reported once only.
    await svc.tick();
    expect(comments).toHaveLength(2);
  });

  it("reports failed when live did not move", async () => {
    const svc = createLiveReleaseService(deps());
    await svc.start({ kind: "release", tag: "rc-2026-09-27.2", actor: JOHN });
    writeResult(launches[0].jobDir, { outcome: "not_released", message: "the database backup failed; nothing was changed." });
    await svc.tick();
    expect(svc.listJobs()[0]).toMatchObject({ state: "failed", reason: "the database backup failed; nothing was changed." });
  });

  it("keeps the hold across the live restart until the outcome is reported", async () => {
    const before = createLiveReleaseService(deps());
    await before.start({ kind: "release", tag: "rc-2026-09-27.2", actor: JOHN });
    const { jobDir } = launches[0];

    // The new server process starts with no drain in memory.
    holds = [];
    const after = createLiveReleaseService(deps());
    expect(after.restoreHold()).toBe(true);
    expect(holds).toHaveLength(1);

    writeResult(jobDir, { outcome: "released", liveTag: "live-2026-09-27.1", commit: "abc123", previousTag: "live-2026-09-20.1" });
    await after.tick();
    expect(lifted).toHaveLength(1);
    expect(after.restoreHold()).toBe(false);
  });

  it("drops an expired hold at start", async () => {
    const svc = createLiveReleaseService(deps());
    await svc.start({ kind: "release", tag: "rc-2026-09-27.2", actor: JOHN });
    holds = [];
    advance(LIVE_RELEASE_WAIT_FOR_RUNS_MS + LIVE_RELEASE_SWITCH_MS);
    expect(createLiveReleaseService(deps()).restoreHold()).toBe(false);
    expect(holds).toEqual([]);
    expect(fs.existsSync(svc.holdFile)).toBe(false);
  });

  it("reports a lost launcher and lifts the hold", async () => {
    let alive = true;
    const svc = createLiveReleaseService(deps({ isProcessAlive: () => alive }));
    await svc.onConfirmationAccepted(accepted());
    advance(2 * 60 * 1000);
    await svc.tick();
    expect(lifted).toEqual([]);
    alive = false;
    await svc.tick();
    expect(comments.at(-1)).toMatch(/gave no result \(the launcher stopped\)/);
    expect(svc.listJobs()[0].state).toBe("failed");
    expect(lifted).toHaveLength(1);
  });

  it("reads a job the GRE-39 version left on disk", async () => {
    const dir = path.join(root, "instance", "live-release", "jobs", "old");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({ id: "old", issueId: "i", interactionId: "x", rcTag: "rc-2026-09-26.1", acceptedByUserId: "john", releaseRepo: "/dev", state: "switching", createdAt: clock.toISOString(), waitDeadline: clock.toISOString(), switchDeadline: new Date(clock.getTime() + LIVE_RELEASE_SWITCH_MS).toISOString(), launcherStartedAt: clock.toISOString(), finishedAt: null }));
    writeResult(dir, { outcome: "released", liveTag: "live-2026-09-26.1" });
    const svc = createLiveReleaseService(deps());
    await svc.tick();
    expect(svc.listJobs()[0]).toMatchObject({ kind: "release", tag: "rc-2026-09-26.1", state: "healthy", startedBy: "john", liveTag: "live-2026-09-26.1" });
  });
});

describe("rollback", () => {
  it("rolls back to an earlier live-* tag through the same path", async () => {
    const svc = createLiveReleaseService(deps());
    await flagRun(svc, "run-flagged");
    const result = await svc.start({ kind: "rollback", tag: "live-2026-09-20.1", actor: JOHN });
    expect(result.ok && result.progress).toMatchObject({ kind: "rollback", targetTag: "live-2026-09-20.1", state: "holding", previousTag: "live-2026-09-28.1" });
    expect(targetChecks).toEqual([{ kind: "rollback", tag: "live-2026-09-20.1" }]);
    runningRuns.delete("run-flagged");
    await svc.tick();
    expect(launches).toEqual([{ jobDir: expect.any(String), tag: "live-2026-09-20.1" }]);
    writeResult(launches[0].jobDir, { outcome: "released", previousTag: "live-2026-09-28.1" });
    await svc.tick();
    expect(svc.listJobs()[0]).toMatchObject({ state: "healthy", liveTag: "live-2026-09-20.1" });
  });

  it("runs the same pre-flight as a release", async () => {
    targetProblem = "tag live-2026-09-01.1 does not exist";
    const svc = createLiveReleaseService(deps());
    expect(await svc.start({ kind: "rollback", tag: "live-2026-09-01.1", actor: JOHN })).toEqual({ ok: false, status: 409, error: targetProblem });
    expect(holds).toEqual([]);
  });
});

describe("release now from origin/main", () => {
  it("cuts an rc tag from origin/main with the title and changelog, then releases it", async () => {
    const svc = createLiveReleaseService(deps());
    const result = await svc.start({ kind: "release", tag: null, title: "Release from the app", actor: JOHN });
    expect(result.ok && result.progress).toMatchObject({ targetTag: "rc-2026-09-28.3", state: "switching" });
    expect(candidates).toEqual([{ tag: "rc-2026-09-28.3", title: "Release from the app", since: "live-2026-09-28.1", print: false }]);
    expect(targetChecks).toEqual([{ kind: "release", tag: "rc-2026-09-28.3" }]);
    expect(launches[0].tag).toBe("rc-2026-09-28.3");
  });

  it("uses the stored title, else proposes one from the changes", async () => {
    const svc = createLiveReleaseService(deps());
    expect(await svc.setNextTitle({ title: "Keystone's title", editedBy: "agent:keystone" })).toMatchObject({ ok: true });
    await svc.start({ kind: "release", tag: null, actor: JOHN });
    expect(candidates.at(-1)).toMatchObject({ title: "Keystone's title", print: false });

    fs.rmSync(path.join(root, "instance"), { recursive: true, force: true });
    candidates = [];
    await createLiveReleaseService(deps()).start({ kind: "release", tag: null, actor: JOHN });
    expect(candidates.map((c) => [c.print, c.title])).toEqual([
      [true, "Next"],
      [false, "Release from the app; Card works after preview stop"],
    ]);
  });

  it.each(["failed", "pending", "unknown"] as const)("refuses when Fork CI on main is %s", async (status) => {
    forkCi = status;
    const svc = createLiveReleaseService(deps());
    const result = await svc.start({ kind: "release", tag: null, actor: JOHN });
    expect(result).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/^Fork CI on main \(ccccccccc\) is /) });
    expect(candidates).toEqual([]);
    expect(holds).toEqual([]);
  });

  it("refuses when live already runs origin/main", async () => {
    mainCommit = "a".repeat(40);
    const result = await createLiveReleaseService(deps()).start({ kind: "release", tag: null, actor: JOHN });
    expect(result).toEqual({ ok: false, status: 409, error: "live already runs origin/main; nothing to release" });
  });
});

describe("next version", () => {
  it("lists the changes merged since live, a proposed title and Fork CI", async () => {
    const next = (await createLiveReleaseService(deps()).overview("co-1")).next;
    expect(next).toEqual({
      baseTag: "live-2026-09-28.1",
      commit: "c".repeat(40),
      proposedTitle: "Release from the app; Card works after preview stop",
      titleEditedBy: null,
      titleEditedAt: null,
      changelog: { features: ["Release from the app (#51, GRE-121)"], fixes: ["Card works after preview stop (#52, GRE-71)"] },
      changes: [
        { pr: 51, issue: "GRE-121", title: "Release from the app", kind: "feature", commit: "1".repeat(40) },
        { pr: 52, issue: "GRE-71", title: "Card works after preview stop", kind: "fix", commit: "2".repeat(40) },
      ],
      forkCi: { status: "passed", url: "https://ci/run/1" },
    });
  });

  it("is null when main is live", async () => {
    mainCommit = "a".repeat(40);
    expect((await createLiveReleaseService(deps()).overview("co-1")).next).toBeNull();
  });

  it("stores an edited title until live moves", async () => {
    const svc = createLiveReleaseService(deps());
    expect(await svc.setNextTitle({ title: "  Releases page  ", editedBy: "agent:keystone" })).toMatchObject({
      ok: true,
      next: { proposedTitle: "Releases page", titleEditedBy: "agent:keystone" },
    });
    runningCommit = { commit: "d".repeat(40), tag: "live-2026-09-29.1" };
    expect((await createLiveReleaseService(deps()).overview("co-1")).next?.proposedTitle).toBe("Release from the app; Card works after preview stop");
  });

  it("refuses a title that is not a title", async () => {
    const svc = createLiveReleaseService(deps());
    for (const title of ["", "a\nb", "rc-2026-09-28.1", "Release candidate 3", "x".repeat(200), 42]) {
      expect(await svc.setNextTitle({ title, editedBy: "user:john" })).toMatchObject({ ok: false, status: 422 });
    }
  });

  it("proposes a title from the changes, features first", () => {
    expect(proposeTitle([{ kind: "fix", title: "F" }, { kind: "feature", title: "A" }, { kind: "feature", title: "B" }])).toBe("A; B and 1 more");
  });
});

describe("live start record (GRE-50)", () => {
  it("records one release event when live starts on a new commit", async () => {
    const svc = createLiveReleaseService(deps());
    const event = await svc.recordLiveStart();
    expect(event).toEqual({
      commit: "a".repeat(40),
      tag: "live-2026-09-28.1",
      startedAt: clock.toISOString(),
      previousCommit: null,
      previousTag: null,
    });
    expect(announced).toEqual([event]);
    expect(svc.lastLiveStart()).toEqual(event);
  });

  it("does nothing on a restart on the same commit", async () => {
    await createLiveReleaseService(deps()).recordLiveStart();
    advance(60_000);
    // A new service object is what a restarted server builds.
    const restarted = createLiveReleaseService(deps());
    expect(await restarted.recordLiveStart()).toBeNull();
    expect(announced).toHaveLength(1);
  });

  it("records the next commit with the one before it", async () => {
    await createLiveReleaseService(deps()).recordLiveStart();
    runningCommit = { commit: "b".repeat(40), tag: null };
    const event = await createLiveReleaseService(deps()).recordLiveStart();
    expect(event).toMatchObject({ commit: "b".repeat(40), previousCommit: "a".repeat(40), previousTag: "live-2026-09-28.1" });
    expect(announced).toHaveLength(2);
  });

  it("records nothing unless the server runs from the live checkout", async () => {
    fs.mkdirSync(path.join(root, "worktree"));
    const svc = createLiveReleaseService(deps({ serverRepoRoot: path.join(root, "worktree") }));
    expect(await svc.recordLiveStart()).toBeNull();
    expect(announced).toEqual([]);
  });

  it("repeats the announcement at the next start when it failed", async () => {
    const failing = createLiveReleaseService(deps({ announce: async () => { throw new Error("db down"); } }));
    await expect(failing.recordLiveStart()).rejects.toThrow("db down");
    expect(failing.lastLiveStart()).toBeNull();
    expect(await createLiveReleaseService(deps()).recordLiveStart()).not.toBeNull();
    expect(announced).toHaveLength(1);
  });

  it("answers 'is ref live?' only for commit SHAs and release tags", async () => {
    let asked: string[] = [];
    const svc = createLiveReleaseService(deps({ containsRef: (_c, ref) => (asked.push(ref), ref === "aaaaaaa") }));
    expect(svc.isLive("aaaaaaa")).toMatchObject({ commit: "a".repeat(40), live: true });
    expect(svc.isLive("bbbbbbb").live).toBe(false);
    expect(svc.isLive("HEAD; rm -rf /").live).toBeNull();
    expect(svc.isLive(null).live).toBeNull();
    expect(asked).toEqual(["aaaaaaa", "bbbbbbb"]);
    expect(isReleaseRef("rc-2026-09-27.3")).toBe(true);
    expect(isReleaseRef("--output=x")).toBe(false);
  });

  it("reads the ref an 'is it released?' card asks about from its key", () => {
    expect(parseReleaseQuestionRef("confirmation:ec25d65d:release:f70ae74dc")).toBe("f70ae74dc");
    expect(parseReleaseQuestionRef("confirmation:465d8346:release:rc-2026-09-27.3")).toBe("rc-2026-09-27.3");
    expect(parseReleaseQuestionRef("live-release:rc-2026-09-27.2")).toBe("rc-2026-09-27.2");
    expect(parseReleaseQuestionRef("confirmation:x:pr6-released")).toBeNull();
    expect(parseReleaseQuestionRef("confirmation:ec25d65d:release-go:after-hold-1")).toBeNull();
    expect(parseReleaseQuestionRef(null)).toBeNull();
  });
});
