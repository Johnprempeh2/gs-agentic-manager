import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { removeIdleUnrecordedWorktrees } from "../services/workspace-runtime.ts";

const execFileAsync = promisify(execFile);
const git = async (cwd: string, args: string[]) =>
  (await execFileAsync("git", args, { cwd })).stdout.trim();
const exists = (target: string) => fs.access(target).then(() => true, () => false);

describe("removeIdleUnrecordedWorktrees", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("removes only idle, clean, pushed worktrees that nothing records or uses", async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gsam-unrecorded-worktrees-")));
    dirs.push(base);
    const origin = path.join(base, "origin.git");
    const checkout = path.join(base, "checkout");
    await git(base, ["init", "-q", "--bare", "-b", "main", origin]);
    await git(base, ["clone", "-q", origin, checkout]);
    await git(checkout, ["config", "user.name", "GS Agentic Manager Test"]);
    await git(checkout, ["config", "user.email", "test@example.invalid"]);
    await git(checkout, ["commit", "-q", "--allow-empty", "-m", "Initial commit"]);
    await git(checkout, ["push", "-q", "origin", "HEAD:main"]);
    await git(checkout, ["fetch", "-q", "origin"]);

    const managed = path.join(checkout, ".gsam", "worktrees");
    const at = (name: string) => path.join(managed, name);
    const addDetached = (target: string) => git(checkout, ["worktree", "add", "-q", "--detach", target, "origin/main"]);
    const addBranchWithCommit = async (name: string, push: boolean) => {
      await git(checkout, ["worktree", "add", "-q", "-b", name, at(name), "origin/main"]);
      await git(at(name), ["commit", "-q", "--allow-empty", "-m", `${name} work`]);
      if (push) await git(at(name), ["push", "-q", "origin", name]);
    };

    await addDetached(at("flint-pr-check"));
    await addBranchWithCommit("GRE-1-pushed", true);
    await addBranchWithCommit("GRE-2-unpushed", false);
    await addDetached(at("dirty-check"));
    await fs.writeFile(path.join(at("dirty-check"), "notes.txt"), "keep me\n");
    await addDetached(at("GRE-3-recorded"));
    await addDetached(at("busy-check"));
    await addDetached(path.join(base, "elsewhere"));

    const threeDaysOn = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const sweep = (now: Date, listProcessCwds: () => Promise<string[] | null>) =>
      removeIdleUnrecordedWorktrees({
        checkoutPaths: [checkout],
        recordedPaths: [`${at("GRE-3-recorded")}/`],
        minIdleMs: 2 * 24 * 60 * 60 * 1000,
        now,
        listProcessCwds,
      });
    const busyProcess = async () => [path.join(at("busy-check"), "server")];

    // Fresh worktrees stay, and so does everything when process use is unknown.
    expect((await sweep(new Date(), busyProcess)).removed).toEqual([]);
    expect((await sweep(threeDaysOn, async () => null)).removed).toEqual([]);

    const result = await sweep(threeDaysOn, busyProcess);

    expect(result.removed.sort()).toEqual([at("GRE-1-pushed"), at("flint-pr-check")]);
    expect(result.kept).toBe(3);
    expect(await exists(at("flint-pr-check"))).toBe(false);
    expect(await exists(at("GRE-1-pushed"))).toBe(false);
    for (const kept of ["GRE-2-unpushed", "dirty-check", "GRE-3-recorded", "busy-check"]) {
      expect(await exists(at(kept))).toBe(true);
    }
    expect(await exists(path.join(base, "elsewhere"))).toBe(true);
    // Removing a worktree never deletes its branch.
    expect(await git(checkout, ["branch", "--list", "GRE-1-pushed"])).toContain("GRE-1-pushed");
  }, 30_000);
});
