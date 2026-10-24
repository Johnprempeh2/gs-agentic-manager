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
  if (kind === "question") {
    const stepsItem = card.items.find((item) => item.subject.metadata?.kind === "request_steps");
    if (stepsItem) return stepsKindLabel(stepsItem.subject.metadata?.steps);
  }
  return DECISION_KIND_LABEL[kind];
}

const STEPS_RISK_LABEL: Record<string, string> = {
  safe: "Safe",
  careful: "Careful",
  money_or_live: "Money or live",
};

/** "Steps · 5 min · Careful" for a step-by-step card on the Decisions feed. */
export function stepsKindLabel(meta: unknown): string {
  const steps = meta && typeof meta === "object" ? (meta as { minutes?: unknown; risk?: unknown }) : {};
  const parts = ["Steps"];
  if (typeof steps.minutes === "number" && steps.minutes > 0) parts.push(`${Math.max(1, Math.round(steps.minutes))} min`);
  if (typeof steps.risk === "string" && STEPS_RISK_LABEL[steps.risk]) parts.push(STEPS_RISK_LABEL[steps.risk]!);
  return parts.join(" · ");
}
