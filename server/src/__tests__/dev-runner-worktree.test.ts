import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapDevRunnerWorktreeEnv,
  isWorktreeSeedPending,
  isLinkedGitWorktreeCheckout,
  resolveWorktreeEnvFilePath,
} from "../dev-runner-worktree.ts";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

describe("dev-runner worktree env bootstrap", () => {
  it("guards seed-pending worktrees until a seed-complete marker exists", () => {
    const root = createTempRoot("paperclip-dev-runner-seed-pending-");
    fs.mkdirSync(path.join(root, ".gsam"), { recursive: true });
    fs.writeFileSync(path.join(root, ".gsam", "seed-pending"), "{}\n", "utf8");

    expect(isWorktreeSeedPending(root)).toBe(true);

    fs.writeFileSync(path.join(root, ".gsam", "seed-complete"), "{}\n", "utf8");
    expect(isWorktreeSeedPending(root)).toBe(false);
  });

  it("guards every manifest state except a complete verified manifest", () => {
    const root = createTempRoot("paperclip-dev-runner-seed-manifest-");
    const manifestPath = path.join(root, ".gsam", "seed-manifest.json");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({ version: 2, state: "failed" }), "utf8");
    expect(isWorktreeSeedPending(root)).toBe(true);

    fs.writeFileSync(manifestPath, JSON.stringify({ version: 2, state: "verified" }), "utf8");
    expect(isWorktreeSeedPending(root)).toBe(true);

    fs.writeFileSync(manifestPath, JSON.stringify({
      version: 2,
      source: { instanceId: "source", configPath: "/source/config.json" },
      snapshotAt: "2026-08-18T00:00:00.000Z",
      seedMode: "minimal",
      migrationRevision: "0001",
      targetInstanceId: "target",
      phase: "complete",
      state: "verified",
      attemptId: "attempt",
      startedAt: "2026-08-18T00:00:00.000Z",
      finishedAt: "2026-08-18T00:01:00.000Z",
      diagnostics: [{ phase: "complete", status: "succeeded", at: "2026-08-18T00:01:00.000Z" }],
    }), "utf8");
    expect(isWorktreeSeedPending(root)).toBe(false);

    fs.writeFileSync(manifestPath, "not-json", "utf8");
    expect(isWorktreeSeedPending(root)).toBe(true);
  });

  it("detects linked git worktrees from .git files", () => {
    const root = createTempRoot("paperclip-dev-runner-worktree-");
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/paperclip/.git/worktrees/feature\n", "utf8");

    expect(isLinkedGitWorktreeCheckout(root)).toBe(true);
  });

  it("loads repo-local GS Agentic Manager env for initialized worktrees without overriding explicit env", () => {
    const root = createTempRoot("paperclip-dev-runner-worktree-env-");
    fs.mkdirSync(path.join(root, ".gsam"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/paperclip/.git/worktrees/feature\n", "utf8");
    fs.writeFileSync(
      resolveWorktreeEnvFilePath(root),
      [
        "GSAM_HOME=/tmp/paperclip-worktrees",
        "GSAM_INSTANCE_ID=feature-worktree",
        "GSAM_IN_WORKTREE=true",
        "GSAM_WORKTREE_NAME=feature-worktree",
        "GSAM_OPTIONAL= # comment-only value",
        "",
      ].join("\n"),
      "utf8",
    );

    const env: NodeJS.ProcessEnv = {
      GSAM_INSTANCE_ID: "already-set",
    };
    const result = bootstrapDevRunnerWorktreeEnv(root, env);

    expect(result).toEqual({
      envPath: resolveWorktreeEnvFilePath(root),
      missingEnv: false,
    });
    expect(env.GSAM_HOME).toBe("/tmp/paperclip-worktrees");
    expect(env.GSAM_INSTANCE_ID).toBe("already-set");
    expect(env.GSAM_IN_WORKTREE).toBe("true");
    expect(env.GSAM_OPTIONAL).toBe("");
  });

  it("repairs stale migrated config paths before loading worktree env", () => {
    const root = createTempRoot("paperclip-dev-runner-worktree-migrated-env-");
    const localConfigPath = path.join(root, ".gsam", "config.json");
    const worktreesDir = path.join(root, ".paperclip-worktrees");
    fs.mkdirSync(path.dirname(localConfigPath), { recursive: true });
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/paperclip/.git/worktrees/feature\n", "utf8");
    fs.writeFileSync(localConfigPath, "{}\n", "utf8");
    fs.writeFileSync(
      resolveWorktreeEnvFilePath(root),
      [
        "GSAM_HOME=/old/home/.paperclip-worktrees",
        "GSAM_INSTANCE_ID=feature-worktree",
        "GSAM_CONFIG=/old/home/paperclip/.gsam/worktrees/feature/.gsam/config.json",
        "GSAM_CONTEXT=/old/home/.paperclip-worktrees/context.json",
        "GSAM_IN_WORKTREE=true",
        "GSAM_WORKTREE_NAME=feature-worktree",
        "",
      ].join("\n"),
      "utf8",
    );

    const env: NodeJS.ProcessEnv = {
      GSAM_WORKTREES_DIR: worktreesDir,
    };
    const result = bootstrapDevRunnerWorktreeEnv(root, env);

    expect(result).toEqual({
      envPath: resolveWorktreeEnvFilePath(root),
      missingEnv: false,
    });
    expect(env.GSAM_HOME).toBe(worktreesDir);
    expect(env.GSAM_CONFIG).toBe(localConfigPath);
    expect(env.GSAM_CONTEXT).toBe(path.join(worktreesDir, "context.json"));
    expect(env.GSAM_INSTANCE_ID).toBe("feature-worktree");
  });

  it("reports uninitialized linked worktrees so dev runner can fail fast", () => {
    const root = createTempRoot("paperclip-dev-runner-worktree-missing-");
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/paperclip/.git/worktrees/feature\n", "utf8");

    expect(bootstrapDevRunnerWorktreeEnv(root, {})).toEqual({
      envPath: resolveWorktreeEnvFilePath(root),
      missingEnv: true,
    });
  });
});
