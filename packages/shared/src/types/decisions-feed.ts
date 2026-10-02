import type { AttentionItem, AttentionSeverity, AttentionSubject } from "./attention.js";

/**
 * One Decisions feed (GRE-263): every thing that needs the board, merged to
 * one card per task. The sidebar badge, the list header and Focus all read
 * `count` from the same build, so the three numbers cannot disagree.
 */
export const DECISION_CARD_KINDS = [
  "question",
  "approval",
  "connection",
  "recovery",
  "failed_run",
  "blocked",
  "review",
  "decision",
  "budget",
  "agent_error",
  "join_request",
] as const;

export type DecisionCardKind = (typeof DECISION_CARD_KINDS)[number];

export type DecisionCardActionId =
  | "reassign"
  | "reassign_blocker"
  | "instruct_blocker"
  | "retry"
  | "instruct"
  | "resolve"
  | "cancel_task"
  | "ask_clarity"
  | "approve"
  | "reject"
  | "reconnect"
  | "dismiss"
  | "open";

/** One HTTP call. `path` is absolute from the server root (starts with /api). */
export interface DecisionCardRequest {
  method: "POST" | "PATCH";
  path: string;
  /** Fixed body fields. The UI adds the field named by the action `input`. */
  body: Record<string, unknown>;
}

export interface DecisionCardActionInput {
  /** Body field the UI fills in, on every request of the action. */
  field: string;
  /** `agent`: pick from `DecisionsFeed.assignableAgents`. `text`: free text. `choice`: pick from `options`. */
  type: "agent" | "text" | "choice";
  label: string;
  required: boolean;
  options?: Array<{ value: string; label: string }>;
}

export interface DecisionCardAction {
  id: DecisionCardActionId;
  label: string;
  description: string;
  /** `request`: run `requests` in order. `link`: open `href` in the app. */
  type: "request" | "link";
  requests: DecisionCardRequest[];
  href: string | null;
  input: DecisionCardActionInput | null;
}

export interface DecisionCardAgentRef {
  id: string;
  name: string;
}

export interface DecisionCardClarity {
  questionCommentId: string;
  question: string;
  askedAt: string;
  agent: DecisionCardAgentRef | null;
  /** First comment from that agent on the task after the question. */
  answer: { commentId: string; body: string; answeredAt: string } | null;
}

export interface DecisionCard {
  /** `task:<issueId>` for task cards, `item:<dedupKey>` for company-level cards. */
  id: string;
  /** The main kind, used for the title and the next step. */
  kind: DecisionCardKind;
  /** Every kind merged into this card, main kind first. */
  kinds: DecisionCardKind[];
  /** The task this card is about. Null for company-level cards (connection alerts, budgets). */
  task: AttentionSubject | null;
  /** What is blocked. */
  title: string;
  /** The real reason or error. */
  reason: string;
  /** The agent whose work waits on the board. */
  waiting: DecisionCardAgentRef | null;
  /** What happens next if nobody acts, or once the board acts. */
  nextStep: string;
  severity: AttentionSeverity;
  activityAt: string;
  createdAt: string;
  actions: DecisionCardAction[];
  clarity: DecisionCardClarity | null;
  /** Source rows merged into this card. Native resolvers (question forms) use these. */
  items: AttentionItem[];
}

export interface DecisionsFeed {
  companyId: string;
  generatedAt: string;
  /** The one count: sidebar badge, list header and Focus all show this number. */
  count: number;
  countsByKind: Record<DecisionCardKind, number>;
  /** Source rows dropped because their cause is gone. Diagnostic only. */
  staleCleared: number;
  assignableAgents: DecisionCardAgentRef[];
  cards: DecisionCard[];
}

export interface DecisionsFeedCount {
  companyId: string;
  generatedAt: string;
  count: number;
}

/** A task assigned to the board user that is not done and has no decision card. */
export interface NeedsMeTask {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  updatedAt: string;
}

/**
 * What truly needs the board user: open decisions waiting on them, plus
 * tasks assigned to them that are not done. Tasks they only created or
 * commented on are not included.
 */
export interface NeedsMe {
  companyId: string;
  generatedAt: string;
  /** decisionCount + assignedTaskCount. A task is never counted twice. */
  count: number;
  decisionCount: number;
  assignedTaskCount: number;
  decisions: DecisionCard[];
  /** Assigned open tasks, without the ones already shown as a decision card. */
  assignedTasks: NeedsMeTask[];
}

export interface DecisionClarityRequest {
  question: string;
  clientRequestId?: string;
}

export interface DecisionClarityResponse {
  cardId: string;
  issueId: string;
  commentId: string;
  agentId: string;
  woken: boolean;
}
