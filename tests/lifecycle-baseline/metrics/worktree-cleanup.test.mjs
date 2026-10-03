import { test } from "node:test";
import assert from "node:assert/strict";
import { formatWorktreeCleanupLine } from "./worktree-cleanup.mjs";

test("says none when nothing was removed", () => {
  assert.equal(formatWorktreeCleanupLine([]), "**Worktrees cleared (24h):** none.");
});

test("lists each patch path and the clean removals", () => {
  const line = formatWorktreeCleanupLine([
    { issueIdentifier: "GRE-12", branchName: "GRE-12-x", worktreePath: "/w/GRE-12-x", patchPath: "/d/GRE-12-x.patch", patchFileCount: 3 },
    { issueIdentifier: null, branchName: "GRE-14-y", worktreePath: "/w/GRE-14-y", patchPath: null, patchFileCount: 0 },
  ]);
  assert.equal(
    line,
    "**Worktrees cleared (24h):** 2 removed, 1 with uncommitted changes saved as a patch; branches kept." +
      " Patches: GRE-12 (3 files) → `/d/GRE-12-x.patch`. Clean: GRE-14-y.",
  );
});
