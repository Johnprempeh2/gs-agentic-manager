import type { IssueThreadInteraction } from "@greatstone/shared";

// A pending card dies with its task: closing the task expires every card on
// it. When an agent or the system closes the task, the agent that asked the
// question was never told, and the person never answered (GRE-1560: Keystone
// closed the task 4 minutes after Ridge's card went up). This wakes the agent
// that made the card so it can ask again on a task that is still open. A
// person who closes the task chose to, so their close wakes no one.

const MAX_QUESTION_CHARS = 300;

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The words the person would have read on the card. */
export function closedCardQuestion(interaction: Pick<IssueThreadInteraction, "title" | "payload">): string | null {
  const payload = readObject(interaction.payload);
  const firstQuestion = Array.isArray(payload.questions) ? readObject(payload.questions[0]).prompt : null;
  const text = readText(interaction.title)
    ?? readText(payload.prompt)
    ?? readText(payload.title)
    ?? readText(payload.purpose)
    ?? readText(firstQuestion);
  if (!text) return null;
  return text.length > MAX_QUESTION_CHARS ? `${text.slice(0, MAX_QUESTION_CHARS)}...` : text;
}

/** Which expired cards need their maker woken, given who closed the task. */
export function closedCardMakersToWake(
  interactions: readonly Pick<IssueThreadInteraction, "id" | "createdByAgentId">[],
  closer: { agentId?: string | null; userId?: string | null },
): { interactionId: string; agentId: string }[] {
  if (closer.userId) return [];
  const wakes: { interactionId: string; agentId: string }[] = [];
  for (const interaction of interactions) {
    const maker = interaction.createdByAgentId ?? null;
    if (!maker || maker === (closer.agentId ?? null)) continue;
    wakes.push({ interactionId: interaction.id, agentId: maker });
  }
  return wakes;
}

export function buildClosedCardAgentMessage(input: {
  question: string | null;
  issueLabel: string;
  closerName: string | null;
}): string {
  const card = input.question ? `Your card "${input.question}"` : "Your card";
  const closer = input.closerName ?? "Another agent";
  return [
    `${card} on ${input.issueLabel} expired before anyone answered it. ${closer} closed ${input.issueLabel}, and closing a task expires every card on it.`,
    "The question was not answered, so do not act as if it was.",
    "If you still need the answer, ask again with a new card on a task that is still open, for example your own task or the parent task. If you no longer need it, do nothing.",
  ].join("\n");
}

// A card can also expire while its task stays open: the person replied with a
// comment instead of answering it, the document it pointed at changed, or the
// task changed hands. The agent that made the card was not told either. These
// helpers wake it once per card so it can follow up.

export type ExpiredCardCause = "comment" | "stale_target" | "other";

/**
 * Why a card expired, or null when no one needs waking for it: the task was
 * closed (the close wakes the maker itself), or the maker replaced its own
 * card with a newer one.
 */
export function expiredCardCause(interaction: Pick<IssueThreadInteraction, "kind" | "result">): ExpiredCardCause | null {
  const result = readObject(interaction.result);
  const outcome = readText(result.outcome);
  const expirationReason = readText(result.expirationReason);
  if (outcome === "issue_closed" || expirationReason === "issue_closed") return null;
  if (outcome === "superseded_by_newer_request" || expirationReason === "superseded_by_newer_interaction") return null;
  if (outcome === "superseded_by_comment" || expirationReason === "superseded_by_comment") return "comment";
  if (interaction.kind === "connection_intent" && readText(result.reason) === "Superseded by a newer user comment") {
    return "comment";
  }
  if (outcome === "stale_target") return "stale_target";
  return "other";
}

/** Which cards that expired on an open task need their maker woken. */
export function expiredCardMakersToWake(
  interactions: readonly Pick<IssueThreadInteraction, "id" | "kind" | "status" | "result" | "createdByAgentId">[],
  context: { actorAgentId?: string | null; assigneeAgentId?: string | null },
): { interactionId: string; agentId: string; cause: ExpiredCardCause }[] {
  const wakes: { interactionId: string; agentId: string; cause: ExpiredCardCause }[] = [];
  for (const interaction of interactions) {
    if (interaction.status !== "expired") continue;
    const maker = interaction.createdByAgentId ?? null;
    // The maker expired its own card, so it already knows.
    if (!maker || maker === (context.actorAgentId ?? null)) continue;
    const cause = expiredCardCause(interaction);
    if (!cause) continue;
    // A person's comment already wakes the task's assignee, who will read it.
    if (cause === "comment" && maker === (context.assigneeAgentId ?? null)) continue;
    wakes.push({ interactionId: interaction.id, agentId: maker, cause });
  }
  return wakes;
}

export function buildExpiredCardAgentMessage(input: {
  question: string | null;
  issueLabel: string;
  cause: ExpiredCardCause;
}): string {
  const card = input.question ? `Your card "${input.question}"` : "Your card";
  const why =
    input.cause === "comment"
      ? `The person replied with a comment on ${input.issueLabel} instead of answering it. Read their comment: it may answer your question.`
      : input.cause === "stale_target"
        ? "The document it pointed at changed or was removed, so the card no longer matched it."
        : "The task changed before anyone answered it.";
  return [
    `${card} on ${input.issueLabel} expired. ${why}`,
    "The card itself was not answered, so do not act as if it was.",
    "If you still need an answer, ask again with a new card. If you no longer need it, do nothing.",
  ].join("\n");
}

type ExpiredCardWakeIssue = {
  id: string;
  companyId: string;
  identifier?: string | null;
  title?: string | null;
  status?: string | null;
  assigneeAgentId?: string | null;
};

/**
 * Wake the maker of each card that expired on a task that is still open. The
 * idempotency key is per card, so a card wakes its maker at most once. A lost
 * wake is logged and never fails the caller: the card is already expired.
 */
export async function wakeMakersOfExpiredCards(
  heartbeat: { wakeup: (agentId: string, input: any) => Promise<unknown> },
  input: {
    issue: ExpiredCardWakeIssue;
    interactions: readonly IssueThreadInteraction[];
    actorAgentId?: string | null;
    source: string;
    logger?: { warn: (obj: unknown, msg: string) => void };
  },
): Promise<number> {
  if (input.interactions.length === 0) return 0;
  if (input.issue.status === "done" || input.issue.status === "cancelled") return 0;
  const byId = new Map(input.interactions.map((interaction) => [interaction.id, interaction]));
  const issueLabel = input.issue.identifier ?? (input.issue.title ? `"${input.issue.title}"` : "the task");
  let woken = 0;
  for (const wake of expiredCardMakersToWake(input.interactions, {
    actorAgentId: input.actorAgentId ?? null,
    assigneeAgentId: input.issue.assigneeAgentId ?? null,
  })) {
    const interaction = byId.get(wake.interactionId)!;
    const text = buildExpiredCardAgentMessage({ question: closedCardQuestion(interaction), issueLabel, cause: wake.cause });
    const agentMessage = { text, source: "expired_card", sessionId: wake.interactionId };
    // No issueId, like the close wake: the maker may not be the assignee, and
    // the message names the task so it can look there.
    const context = {
      expiredCardIssueId: input.issue.id,
      interactionId: wake.interactionId,
      interactionStatus: "expired",
      paperclipAgentMessage: agentMessage,
    };
    try {
      await heartbeat.wakeup(wake.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "interaction_expired",
        idempotencyKey: `interaction:${wake.interactionId}:expired`,
        requestedByActorType: "system",
        requestedByActorId: "expired_card_guard",
        payload: context,
        contextSnapshot: { ...context, wakeReason: "interaction_expired", source: input.source },
      });
      woken += 1;
    } catch (err) {
      input.logger?.warn(
        { err, interactionId: wake.interactionId, agentId: wake.agentId },
        "failed to wake the maker of an expired card",
      );
    }
  }
  return woken;
}
