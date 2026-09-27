import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LIVE_RELEASE_SWITCH_MS,
  LIVE_RELEASE_WAIT_FOR_RUNS_MS,
  createLiveReleaseService,
  parseLiveReleaseKey,
  type LiveReleaseDeps,
} from "../services/live-release.ts";

// Everything runs in a temp sandbox: no ~/GSAM path is read or written.
let root: string;
let clock: Date;
let running: number;
let comments: string[];
let holds: Array<{ startedAt: Date; expiresAt: Date }>;
let lifted: Date[];
let launches: Array<{ jobDir: string; rcTag: string }>;

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
