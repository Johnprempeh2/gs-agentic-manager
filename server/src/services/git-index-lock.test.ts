import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeGitIndexLockHolder, waitForGitIndexLock, type GitIndexLockHolderProbe } from "./git-index-lock.js";

const MINUTE = 60_000;

describe("waitForGitIndexLock (GRE-383)", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-index-lock-"));
    lockPath = path.join(dir, "index.lock");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function writeLock(ageMs: number, clockMs: number) {
    await fs.writeFile(lockPath, "", "utf8");
    const mtime = new Date(clockMs - ageMs);
    await fs.utimes(lockPath, mtime, mtime);
  }

  // A fake clock: each sleep advances it, so a 2-minute wait runs instantly.
  function fakeClock(startMs: number) {
    let current = startMs;
    return {
      now: () => current,
      sleep: async (ms: number) => {
        current += ms;
      },
    };
  }

  it("returns absent when there is no lock", async () => {
    const clock = fakeClock(Date.now());
    const outcome = await waitForGitIndexLock({ lockPath, worktreePath: dir, probe: async () => false, ...clock });
    expect(outcome).toEqual({ status: "absent" });
  });

  it("removes a stale lock that no git process holds", async () => {
    const clock = fakeClock(Date.now());
    await writeLock(3 * MINUTE, clock.now());

    const outcome = await waitForGitIndexLock({ lockPath, worktreePath: dir, probe: async () => false, ...clock });

    expect(outcome.status).toBe("removed_stale");
    expect(outcome).toMatchObject({ waitedMs: 0 });
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never removes a stale lock that a live git process holds", async () => {
    const clock = fakeClock(Date.now());
    await writeLock(10 * MINUTE, clock.now());

    const outcome = await waitForGitIndexLock({ lockPath, worktreePath: dir, probe: async () => true, ...clock });

    expect(outcome).toMatchObject({ status: "held", heldByProcess: true });
    expect((outcome as { waitedMs: number }).waitedMs).toBe(2 * MINUTE);
    await expect(fs.stat(lockPath)).resolves.toBeTruthy();
  });

  it("waits for a held lock and continues once git releases it", async () => {
    const clock = fakeClock(Date.now());
    await writeLock(0, clock.now());
    let probes = 0;
    const probe: GitIndexLockHolderProbe = async () => {
      probes += 1;
      // The git process finishes and removes its lock after the third check.
      if (probes === 3) await fs.rm(lockPath);
      return true;
    };

    const outcome = await waitForGitIndexLock({ lockPath, worktreePath: dir, probe, pollMs: 2_000, ...clock });

    expect(outcome).toEqual({ status: "cleared", waitedMs: 6_000 });
  });

  it("waits for a young unheld lock to age, then removes it inside the budget", async () => {
    const clock = fakeClock(Date.now());
    await writeLock(30_000, clock.now());

    const outcome = await waitForGitIndexLock({ lockPath, worktreePath: dir, probe: async () => false, ...clock });

    expect(outcome.status).toBe("removed_stale");
    expect((outcome as { waitedMs: number }).waitedMs).toBe(90_000);
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not remove a stale lock when the holder check is unavailable", async () => {
    const clock = fakeClock(Date.now());
    await writeLock(10 * MINUTE, clock.now());

    const outcome = await waitForGitIndexLock({ lockPath, worktreePath: dir, probe: async () => null, ...clock });

    expect(outcome).toMatchObject({ status: "held", heldByProcess: null });
    await expect(fs.stat(lockPath)).resolves.toBeTruthy();
  });
});

describe("probeGitIndexLockHolder (GRE-383)", () => {
  it("reports a lock as held while a process has it open, and free after", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-index-lock-probe-"));
    const lockPath = path.join(dir, "index.lock");
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        const held = await probeGitIndexLockHolder({ lockPath, worktreePath: dir });
        // null only when lsof is not installed on the test host.
        if (held === null) return;
        expect(held).toBe(true);
      } finally {
        await handle.close();
      }
      expect(await probeGitIndexLockHolder({ lockPath, worktreePath: dir })).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
