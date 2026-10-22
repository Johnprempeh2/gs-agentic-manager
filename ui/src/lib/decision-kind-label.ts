import type { DecisionCard, DecisionCardKind } from "@greatstone/shared";
import { ASK_TYPE_COPY, readAskType } from "@greatstone/shared";
import { focusItemKind, isFocusItem } from "./focus-items";

export const DECISION_KIND_LABEL: Record<DecisionCardKind, string> = {
  question: "Question",
  approval: "Approval",
  connection: "Connection",
  recovery: "Stopped",
  failed_run: "Stopped with an error",
  blocked: "Blocked",
  review: "Review",
  decision: "Decision",
  budget: "Budget",
  agent_error: "Agent error",
  join_request: "Join request",
  outage: "Internet outage",
};

/**
 * The chip for one of a card's kinds. The feed files confirmations and
 * suggested tasks under "question"; the card names what it really asks for.
 */
export function decisionKindLabel(card: DecisionCard, kind: DecisionCardKind): string {
  if (kind === "question") {
    const interactionKind = card.items.find(isFocusItem);
    const itemKind = interactionKind ? focusItemKind(interactionKind) : null;
    const askType = interactionKind ? readAskType(interactionKind.subject.metadata) : null;
    if (askType) return ASK_TYPE_COPY[askType].label;
    if (itemKind === "request_confirmation" || itemKind === "request_checkbox_confirmation") return "Confirmation";
    if (itemKind === "suggest_tasks") return "Suggested tasks";
  }
  return DECISION_KIND_LABEL[kind];
}
