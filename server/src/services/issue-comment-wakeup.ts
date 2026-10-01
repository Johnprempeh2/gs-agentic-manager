// Statuses where a comment may carry `resume: true`. The comment route refuses
// resume intent on any other status with a 409, so callers that build comment
// requests (the Decisions card) must use this too.
export function isExplicitResumeCapableStatus(status: string | null | undefined) {
  return (
    status === "done" ||
    status === "cancelled" ||
    status === "blocked" ||
    status === "todo" ||
    status === "in_progress"
  );
}

export function shouldWakeAssigneeForIssueComment(input: {
  selfComment: boolean;
  resumeRequested: boolean;
  commentCreatedByRunId?: string | null;
  issueAtCommentStart: {
    checkoutRunId?: string | null;
    executionRunId?: string | null;
  };
  reopened: boolean;
  currentStatus: string | null | undefined;
}) {
  const sourceRunId = input.commentCreatedByRunId;
  const commentIsFromCurrentIssueRun = Boolean(
    sourceRunId &&
    (sourceRunId === input.issueAtCommentStart.checkoutRunId ||
      sourceRunId === input.issueAtCommentStart.executionRunId),
  );
  if (
    input.selfComment &&
    (!input.resumeRequested || commentIsFromCurrentIssueRun)
  ) {
    return false;
  }
  return (
    input.reopened ||
    (input.currentStatus !== "done" && input.currentStatus !== "cancelled")
  );
}
