import { test } from "node:test";
import assert from "node:assert/strict";
import { formatWorktreeCleanupLine } from "./worktree-cleanup.mjs";

test("says none when nothing was removed", () => {
  assert.equal(formatWorktreeCleanupLine([]), "**Worktrees cleared (24h):** none.");
});

test("lists each patch path and the clean removals", () => {
  const line = formatWorktreeCleanupLine([
    { issueIdentifier: "GRE-12", branchName: "GRE-12-x", worktreePath: "/w/GRE-12-x", patchPath: "/d/GRE-12-x.patch", patchFileCount: 3, branchKept: true },
    { issueIdentifier: null, branchName: "GRE-14-y", worktreePath: "/w/GRE-14-y", patchPath: null, patchFileCount: 0, branchKept: false },
  ]);
  assert.equal(
    line,
    "**Worktrees cleared (24h):** 2 removed, 1 with uncommitted changes saved as a patch; 1 branch kept, 1 branch deleted." +
      " Patches: GRE-12 (3 files) → `/d/GRE-12-x.patch`. Clean: GRE-14-y.",
  );
});

test("says branches deleted when every removal was clean merged work (GRE-457)", () => {
  const line = formatWorktreeCleanupLine([
    { issueIdentifier: "GRE-20", branchName: "GRE-20-a", worktreePath: "/w/a", patchPath: null, patchFileCount: 0, branchKept: false },
    { issueIdentifier: "GRE-21", branchName: "GRE-21-b", worktreePath: "/w/b", patchPath: null, patchFileCount: 0, branchKept: false },
  ]);
  assert.equal(
    line,
    "**Worktrees cleared (24h):** 2 removed, 0 with uncommitted changes saved as a patch; 2 branches deleted. Clean: GRE-20, GRE-21.",
  );
});

test("counts a clean pushed-only removal as kept, and old rows by their patch (GRE-457)", () => {
  const line = formatWorktreeCleanupLine([
    { issueIdentifier: "GRE-30", branchName: "GRE-30-a", worktreePath: "/w/a", patchPath: null, patchFileCount: 0, branchKept: true },
    { issueIdentifier: "GRE-31", branchName: "GRE-31-b", worktreePath: "/w/b", patchPath: "/d/b.patch", patchFileCount: 1 },
    { issueIdentifier: "GRE-32", branchName: "GRE-32-c", worktreePath: "/w/c", patchPath: null, patchFileCount: 0 },
  ]);
  assert.match(line, /; 2 branches kept, 1 branch deleted\./);
});
