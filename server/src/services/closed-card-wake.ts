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
