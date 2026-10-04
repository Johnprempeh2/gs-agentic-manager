import { and, eq } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { issueAttachments } from "@greatstone/db";

// GRE-451: John approves what he can see, not a description. An approval card
// that asks him to approve a design, screen, deck, video or document must come
// with the real thing attached to the task.

const VISUAL_WORK_WORDS =
  /\b(?:designs?|mock-?ups?|wireframes?|screens?|screenshots?|layouts?|pages?|decks?|slides?|presentations?|videos?|documents?|docs?|reports?|briefs?|one-pagers?|deliverables?|visuals?|logos?)\b/i;
// "UI" only as a capital acronym, so "ui" in a path or word does not count.
const UI_WORD = /\bUI\b/;

export const MISSING_APPROVAL_EVIDENCE_MESSAGE =
  "This card asks John to approve a design, screen, deck, video or document, but the task has nothing attached. " +
  "John approves what he can see. Attach the real thing first: upload it with " +
  "POST /api/companies/{companyId}/issues/{issueId}/attachments, or register it as a deliverable with " +
  "POST /api/issues/{issueId}/deliverables. Then post the card again.";

type ConfirmationInput = {
  kind?: unknown;
  payload?: { prompt?: unknown; target?: { type?: unknown; key?: unknown } | null } | null;
};

/** True when a request_confirmation's prompt asks to approve visual or document work. */
export function asksToApproveVisualWork(input: ConfirmationInput): boolean {
  if (input.kind !== "request_confirmation") return false;
  // A plan confirmation points at the plan document itself; the card shows it.
  // Any other document (a pitch, a price sheet) still needs the real thing attached.
  const target = input.payload?.target;
  if (target?.type === "issue_document" && target.key === "plan") return false;
  const prompt = typeof input.payload?.prompt === "string" ? input.payload.prompt : "";
  return VISUAL_WORK_WORDS.test(prompt) || UI_WORD.test(prompt);
}

/** True when the task has at least one attachment. Every deliverable is an attachment too. */
export async function issueHasApprovalEvidence(db: Db, companyId: string, issueId: string): Promise<boolean> {
  const rows = await db
    .select({ id: issueAttachments.id })
    .from(issueAttachments)
    .where(and(eq(issueAttachments.companyId, companyId), eq(issueAttachments.issueId, issueId)))
    .limit(1);
  return rows.length > 0;
}

