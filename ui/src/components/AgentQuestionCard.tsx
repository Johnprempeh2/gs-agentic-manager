import type { Agent, AskAgentInteraction } from "@greatstone/shared";
import { CheckCircle2, Clock3, MessageCircleQuestion, MinusCircle } from "lucide-react";
import { MarkdownBody } from "./MarkdownBody";

function agentLabel(agentId: string | null | undefined, agentMap?: Map<string, Agent>) {
  if (!agentId) return "another agent";
  return agentMap?.get(agentId)?.name ?? "another agent";
}

function closedWithoutAnswerText(interaction: AskAgentInteraction, targetLabel: string) {
  switch (interaction.result?.outcome) {
    case "withdrawn":
      return "Question withdrawn before it was answered";
    case "issue_closed":
      return `The task closed before ${targetLabel} answered`;
    case "addressee_deleted":
      return `${targetLabel} was removed before answering`;
    default:
      return "Not answered";
  }
}

/**
 * A question one agent asked another on this task, with the answer underneath
 * once it arrives. Read-only: only the asked agent answers, through the API.
 */
export function AgentQuestionCard({
  interaction,
  agentMap,
}: {
  interaction: AskAgentInteraction;
  agentMap?: Map<string, Agent>;
}) {
  const targetLabel = agentLabel(interaction.addresseeAgentId, agentMap);
  const askerLabel = interaction.createdByAgentId
    ? agentLabel(interaction.createdByAgentId, agentMap)
    : null;
  const answer = interaction.status === "answered" ? interaction.result?.answer ?? null : null;

  return (
    <div
      id={`interaction-${interaction.id}`}
      data-testid="agent-question-card"
      className="w-full space-y-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
    >
      <div className="flex items-start gap-2">
        <MessageCircleQuestion aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="font-medium">Asked {targetLabel}:</div>
          <MarkdownBody>{interaction.payload.question}</MarkdownBody>
          {askerLabel ? (
            <div className="text-xs text-muted-foreground">Asked by {askerLabel}</div>
          ) : null}
        </div>
      </div>
      {interaction.status === "pending" ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="agent-question-waiting">
          <Clock3 aria-hidden className="h-3.5 w-3.5" />
          Waiting for {targetLabel} to answer
        </div>
      ) : answer ? (
        <div className="flex items-start gap-2 border-t border-border pt-2" data-testid="agent-question-answer">
          <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="text-xs text-muted-foreground">Answer from {targetLabel}</div>
            <MarkdownBody>{answer}</MarkdownBody>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <MinusCircle aria-hidden className="h-3.5 w-3.5" />
          {closedWithoutAnswerText(interaction, targetLabel)}
        </div>
      )}
    </div>
  );
}
