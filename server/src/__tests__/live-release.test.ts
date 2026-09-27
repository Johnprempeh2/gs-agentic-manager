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
  type LiveReleaseDeps,
  type LiveReleaseEvent,
} from "../services/live-release.ts";
import { parseReleaseQuestionRef } from "../services/live-release-announce.ts";

// Everything runs in a temp sandbox: no ~/GSAM path is read or written.
let root: string;
let clock: Date;
let running: number;
let comments: string[];
let holds: Array<{ startedAt: Date; expiresAt: Date }>;
let lifted: Date[];
let launches: Array<{ jobDir: string; rcTag: string }>;
let runningCommit: { commit: string; tag: string | null } | null;
let announced: LiveReleaseEvent[];

function deps(overrides: Partial<LiveReleaseDeps> = {}): LiveReleaseDeps {
  return {
    stateDir: path.join(root, "instance", "live-release"),
    liveDir: path.join(root, "live"),
    serverRepoRoot: path.join(root, "live"),
    resolveReleaseRepo: () => path.join(root, "dev"),
    now: () => clock,
    countRunningRuns: async () => running,
    postComment: async (_issueId, body) => {
      comments.push(body);
    },
    applyHold: (hold) => holds.push(hold),
    liftHold: (startedAt) => lifted.push(startedAt),
    startLauncher: ({ jobDir, rcTag }) => {
      launches.push({ jobDir, rcTag });
      fs.writeFileSync(path.join(jobDir, "launcher.pid"), `${process.pid}\n`);
    },
    isProcessAlive: () => true,
    readRunningCommit: () => runningCommit,
    containsRef: (_commit, ref) => ref === "aaaaaaa",
    announce: async (event) => {
      announced.push(event);
    },
    ...overrides,
  };
}

const accepted = (idempotencyKey = "live-release:rc-2026-09-27.2", status = "accepted") => ({
  issueId: "issue-1",
  interaction: { id: "interaction-1", kind: "request_confirmation", status, idempotencyKey },
  actor: { actorType: "user", actorId: "john" },
});

function advance(ms: number) {
  clock = new Date(clock.getTime() + ms);
}

function writeResult(jobDir: string, result: Record<string, unknown>) {
  fs.writeFileSync(path.join(jobDir, "result.json"), JSON.stringify(result));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "live-release-"));
  for (const dir of ["live", "dev/scripts"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const file of ["greatstone-release.sh", "greatstone-live-release.sh"]) {
    fs.writeFileSync(path.join(root, "dev", "scripts", file), "#!/bin/sh\n");
  }
  clock = new Date("2026-09-27T12:00:00Z");
  running = 0;
  comments = [];
  holds = [];
  lifted = [];
  launches = [];
  runningCommit = { commit: "a".repeat(40), tag: "live-2026-09-28.1" };
  announced = [];
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

describe("one-click release", () => {
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
    expect(comments[0]).toMatch(/one-click release is off/);
  });

  it("holds new runs and waits for active runs before it switches", async () => {
    running = 2;
    const svc = createLiveReleaseService(deps());
    const job = await svc.onConfirmationAccepted(accepted());
    expect(job?.state).toBe("waiting_for_runs");
    expect(holds).toHaveLength(1);
    expect(fs.existsSync(svc.holdFile)).toBe(true);
    expect(launches).toEqual([]);
    expect(comments[0]).toMatch(/on hold.*2 now/);

    advance(30 * 60 * 1000);
    await svc.tick();
    expect(launches).toEqual([]);

    running = 0;
    await svc.tick();
    expect(launches).toEqual([{ jobDir: expect.stringContaining(job!.id), rcTag: "rc-2026-09-27.2" }]);
    expect(svc.listJobs()[0].state).toBe("switching");
    // The hold stays on during the switch.
    expect(lifted).toEqual([]);
  });

  it("gives up after the wait limit, leaves live alone and lifts the hold", async () => {
    running = 1;
    const svc = createLiveReleaseService(deps());
    await svc.onConfirmationAccepted(accepted());
    advance(LIVE_RELEASE_WAIT_FOR_RUNS_MS);
    await svc.tick();
    expect(launches).toEqual([]);
    expect(comments.at(-1)).toMatch(/^Not released: 1 agent run\(s\) still running/);
    expect(lifted).toHaveLength(1);
    expect(fs.existsSync(svc.holdFile)).toBe(false);
  });

  it("reports a failed health check and the automatic rollback with the backup path", async () => {
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
    expect(lifted).toHaveLength(1);
    expect(svc.listJobs()[0].state).toBe("finished");
    // Reported once only.
    await svc.tick();
    expect(comments).toHaveLength(2);
  });

  it("keeps the hold across the live restart until the outcome is reported", async () => {
    const before = createLiveReleaseService(deps());
    await before.onConfirmationAccepted(accepted());
    const { jobDir } = launches[0];

    // The new server process starts with no drain in memory.
    holds = [];
    const after = createLiveReleaseService(deps());
    expect(after.restoreHold()).toBe(true);
    expect(holds).toHaveLength(1);

    writeResult(jobDir, { outcome: "released", liveTag: "live-2026-09-27.1", commit: "abc123", previousTag: "live-2026-09-20.1", backupFile: "/b.sql.gz" });
    await after.tick();
    expect(comments.at(-1)).toMatch(/^Released rc-2026-09-27.2 as live-2026-09-27.1\. `\/api\/health` reports commit `abc123`/);
    expect(lifted).toHaveLength(1);
    expect(after.restoreHold()).toBe(false);
  });

  it("drops an expired hold at start", async () => {
    const svc = createLiveReleaseService(deps());
    await svc.onConfirmationAccepted(accepted());
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
    expect(lifted).toHaveLength(1);
  });

  it("refuses a second release while one is in progress", async () => {
    running = 1;
    const svc = createLiveReleaseService(deps());
    await svc.onConfirmationAccepted(accepted());
    await svc.onConfirmationAccepted({ ...accepted("live-release:rc-2026-09-27.3"), interaction: { ...accepted().interaction, id: "interaction-2", idempotencyKey: "live-release:rc-2026-09-27.3" } });
    expect(comments.at(-1)).toMatch(/release of rc-2026-09-27.2 is still in progress/);
    expect(holds).toHaveLength(1);
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
