import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGitWriteInProgress, migrationInProcessTree, waitForCorrectionSafePoint } from "./correction-safe-point.js";

describe("correction safe-point wait", () => {
  it("waits until the protected operation ends", async () => {
    let time = 0;
    const protectedState = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
    const result = await waitForCorrectionSafePoint({
      isProtected: protectedState,
      now: () => time,
      sleep: async (ms) => { time += ms; },
    });
    expect(result).toBe("safe");
    expect(time).toBe(2_000);
    expect(protectedState).toHaveBeenCalledTimes(3);
  });

  it("stops waiting after two minutes", async () => {
    let time = 0;
    const result = await waitForCorrectionSafePoint({
      isProtected: () => true,
      now: () => time,
      sleep: async (ms) => { time += ms; },
    });
    expect(result).toBe("timed_out");
    expect(time).toBe(120_000);
  });

  it("observes git locks in a worktree and waits for their removal", async () => {
    const root = await mkdtemp(join(tmpdir(), "correction-safe-point-"));
    const gitDir = join(root, "metadata");
    try {
      await mkdir(gitDir);
      await writeFile(join(root, ".git"), "gitdir: metadata\n");
      expect(await isGitWriteInProgress(root)).toBe(false);
      await writeFile(join(gitDir, "index.lock"), "");
      expect(await isGitWriteInProgress(root)).toBe(true);
      await rm(join(gitDir, "index.lock"));
      expect(await isGitWriteInProgress(root)).toBe(false);
      await mkdir(join(gitDir, "rebase-merge"));
      expect(await isGitWriteInProgress(root)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects migration commands only in the run process tree", () => {
    const processes = "100 1 agent\n101 100 shell\n102 101 pnpm db:migrate\n200 1 pnpm db:migrate\n";
    expect(migrationInProcessTree(processes, 100)).toBe(true);
    expect(migrationInProcessTree(processes, 101)).toBe(true);
    expect(migrationInProcessTree(processes, 300)).toBe(false);
  });
});
