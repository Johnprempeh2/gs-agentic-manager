import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  documentRevisions,
  issueComments,
  issueDocuments,
  issueWorkProducts,
} from "@greatstone/db";

// GRE-573: an agent must not close its own task as `done` in a run that
// posted no result. The first comment of a run is its acknowledgement, so a
// result needs a second comment, an inline comment on the closing request, a
// document revision or a work product from the same run.
export const AGENT_DONE_WITHOUT_RESULT_CODE = "agent_done_without_result";
export const AGENT_DONE_WITHOUT_RESULT_MESSAGE =
  "Post your result first: this run has no result comment, document or work product on this task. " +
  "Post the result (or send it as `comment` with this request), then set `done`.";

export type AgentDoneResultEvidence = {
  runCommentCount: number;
  runDocumentRevisionCount: number;
  runWorkProductCount: number;
};

export type AgentDoneGuardInput = {
  actorType: "agent" | "user";
  actorAgentId: string | null;
  actorRunId: string | null;
  existingStatus: string;
  existingAssigneeAgentId: string | null;
  requestedStatus: unknown;
  inlineComment: unknown;
};

export function agentDoneGuardApplies(input: AgentDoneGuardInput): boolean {
  return (
    input.actorType === "agent" &&
    Boolean(input.actorAgentId) &&
    Boolean(input.actorRunId) &&
    input.requestedStatus === "done" &&
    input.existingStatus !== "done" &&
    input.existingAssigneeAgentId === input.actorAgentId &&
    !(typeof input.inlineComment === "string" && input.inlineComment.trim().length > 0)
  );
}

export function agentDoneHasResult(evidence: AgentDoneResultEvidence): boolean {
  return (
    evidence.runCommentCount >= 2 ||
    evidence.runDocumentRevisionCount > 0 ||
    evidence.runWorkProductCount > 0
  );
}

export async function loadAgentDoneResultEvidence(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string; runId: string },
): Promise<AgentDoneResultEvidence> {
  const [comments, revisions, workProducts] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, input.companyId),
          eq(issueComments.issueId, input.issueId),
          eq(issueComments.authorAgentId, input.agentId),
          eq(issueComments.createdByRunId, input.runId),
          isNull(issueComments.deletedAt),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(documentRevisions)
      .innerJoin(issueDocuments, eq(issueDocuments.documentId, documentRevisions.documentId))
      .where(
        and(
          eq(issueDocuments.companyId, input.companyId),
          eq(issueDocuments.issueId, input.issueId),
          eq(documentRevisions.createdByRunId, input.runId),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(issueWorkProducts)
      .where(
        and(
          eq(issueWorkProducts.companyId, input.companyId),
          eq(issueWorkProducts.issueId, input.issueId),
          eq(issueWorkProducts.createdByRunId, input.runId),
        ),
      ),
  ]);
  return {
    runCommentCount: comments[0]?.count ?? 0,
    runDocumentRevisionCount: revisions[0]?.count ?? 0,
    runWorkProductCount: workProducts[0]?.count ?? 0,
  };
}
