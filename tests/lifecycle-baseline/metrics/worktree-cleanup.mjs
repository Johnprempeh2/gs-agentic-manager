// Formats the "Worktrees cleared" line for the 08:00 digest (GRE-452). The
// terminal reaper records one `execution_workspace.issue_terminal_worktree_removed`
// activity per worktree it removes, with the patch path when it saved
// uncommitted changes first. John never removes worktrees by hand.

export const WORKTREE_REMOVED_ACTION = "execution_workspace.issue_terminal_worktree_removed";

// rows: [{ issueIdentifier, worktreePath, branchName, patchPath, patchFileCount, branchKept }]
// A patched removal keeps its branch. A clean removal of merged work deletes it
// (GRE-208); a clean removal of pushed-only work keeps it. Rows without
// `branchKept` fall back to "kept only when patched" (GRE-457).
export function formatWorktreeCleanupLine(rows) {
  if (rows.length === 0) return "**Worktrees cleared (24h):** none.";
  const patched = rows.filter((row) => row.patchPath);
  const name = (row) => row.issueIdentifier ?? row.branchName ?? row.worktreePath ?? "unknown";
  const clean = rows.filter((row) => !row.patchPath).map(name);
  const kept = rows.filter((row) => row.branchKept ?? Boolean(row.patchPath)).length;
  const branches = [
    kept && `${kept} ${kept === 1 ? "branch" : "branches"} kept`,
    rows.length - kept && `${rows.length - kept} ${rows.length - kept === 1 ? "branch" : "branches"} deleted`,
  ].filter(Boolean);
  const parts = [
    `**Worktrees cleared (24h):** ${rows.length} removed, ${patched.length} with uncommitted changes saved as a patch; ${branches.join(", ")}.`,
  ];
  if (patched.length) {
    parts.push(
      `Patches: ${patched
        .map((row) => `${name(row)} (${row.patchFileCount ?? 0} files) → \`${row.patchPath}\``)
        .join("; ")}.`,
    );
  }
  if (clean.length) parts.push(`Clean: ${clean.join(", ")}.`);
  return parts.join(" ");
}
