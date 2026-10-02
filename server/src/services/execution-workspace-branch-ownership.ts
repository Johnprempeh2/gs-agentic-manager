export const GIT_BRANCH_OWNERSHIP_METADATA_VERSION = 1;
export const GIT_BRANCH_OWNERSHIP_METADATA_KEY = "gitBranchOwnershipVersion";

function hasCurrentGitBranchOwnershipMetadata(
  metadata: Record<string, unknown> | null | undefined,
) {
  return metadata?.[GIT_BRANCH_OWNERSHIP_METADATA_KEY] === GIT_BRANCH_OWNERSHIP_METADATA_VERSION;
}

export function isRuntimeOwnedGitBranch(
  metadata: Record<string, unknown> | null | undefined,
) {
  return hasCurrentGitBranchOwnershipMetadata(metadata) && metadata?.createdByRuntime === true;
}

// A session on a local directory the runtime did not create: the shared project
// checkout, or a plain project folder. No cleanup step deletes or rewrites that
// directory, so archiving the session removes only its record and cannot lose
// work. Worktrees, runtime-created folders, and sandbox or adapter-managed
// workspaces can hold the only copy of work, so they never count.
export function isRecordOnlyExecutionWorkspace(workspace: {
  providerType: string;
  metadata?: Record<string, unknown> | null;
}) {
  return workspace.providerType === "local_fs" && workspace.metadata?.createdByRuntime !== true;
}
