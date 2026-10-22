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
  "outage",
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
  | "request_changes"
  | "send_back"
  | "reconnect"
  | "dismiss"
  | "done"
  | "open"
  | "fix_setup"
  | "not_now";

/** One HTTP call. `path` is absolute from the server root (starts with /api). */
export interface DecisionCardRequest {
  method: "POST" | "PATCH";
  path: string;
  /** Fixed body fields. The UI adds the field named by the action `input`. */
  body: Record<string, unknown>;
  /**
   * The UI adds one fresh `clientRequestId` per press to this request's body,
   * so a double press posts once and a chat thread accepts the message.
   */
  clientRequestId?: boolean;
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
  /** What happens if the person picks it, in one sentence: the consequence. */
  description: string;
  /** The owning agent recommends this option. */
  recommended?: boolean;
  /** Set when the option is shown but cannot be used, with the plain reason. */
  disabledReason?: string | null;
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

/** Who must give the verdict on a task in review (GRE-870). */
export interface DecisionCardReviewer {
  type: "user" | "agent";
  id: string;
  name: string;
  /** The reviewer is the user who asked for the feed: only they may approve. */
  isYou: boolean;
}

export interface DecisionCardClarity {
  questionCommentId: string;
  question: string;
  askedAt: string;
  agent: DecisionCardAgentRef | null;
  /** First comment from that agent on the task after the question. */
  answer: { commentId: string; body: string; answeredAt: string } | null;
}

/**
 * A card that needs the board user at the computer (GRE-450): a host command,
 * a sign-in, a restart. It shows under "At your desk" and is not in the phone
 * count or push.
 */
export interface DecisionCardAtDesk {
  /** The exact command to run, shown in a copy box. Null when there is none. */
  command: string | null;
}

/**
 * Runs of one agent that stopped for the same setup gap (GRE-504):
 * `configuration_incomplete` with the same reason and message. Every later
 * failure adds to `failureCount`; it does not open a new card.
 */
export interface DecisionCardSetup {
  agent: DecisionCardAgentRef | null;
  /** The plain failure message, for example "Connect an account and choose your personal default". */
  cause: string;
  /** Failures with this cause since the agent's last successful run. */
  failureCount: number;
  lastSeenAt: string;
  /** In-app page where the setup is fixed. */
  fixHref: string;
  /** Open tasks stopped by this cause. */
  tasks: Array<{ id: string; identifier: string | null; title: string }>;
  /** Set once the agent finished a run after the failures: the setup works again. */
  fixedAt: string | null;
}

/** A task named on a card: what it holds up, or what it waits on. */
export interface DecisionCardTaskRef {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  href: string;
}

/** Why the decision matters: what it holds up and how long it has waited. */
export interface DecisionCardWhy {
  /** One plain sentence, for example "It holds up GRE-12 Ship invitations." */
  text: string;
  holdsUp: DecisionCardTaskRef[];
  /** When the wait began; the UI shows it as "waiting 2 days". */
  waitingSince: string;
}

/** The facts behind the decision, so it can be made on the card. */
export interface DecisionCardFacts {
  /** The latest comment from the owning agent on the task, shortened. */
  latestComment: { agent: DecisionCardAgentRef | null; excerpt: string; at: string } | null;
  /** Open tasks this task waits on. */
  blockerChain: DecisionCardTaskRef[];
  links: Array<{ label: string; href: string }>;
}

/** What the owning agent recommends, from the interaction or its latest comment. */
export interface DecisionCardRecommendation {
  by: DecisionCardAgentRef | null;
  text: string;
  /** The card option it points at, when it names one. */
  actionId: DecisionCardActionId | null;
  source: "interaction" | "comment";
}

/** One question of a question card, with its options, so it reads on the card. */
export interface DecisionCardQuestion {
  prompt: string;
  options: Array<{ id: string; label: string; description: string | null; recommended: boolean }>;
}

/**
 * Why a stall that started on the agent side now reaches a person: the lead
 * agent asked them, the stall outlived the threshold, or the owning agent's
 * latest comment names them and an action.
 */
export interface DecisionCardEscalation {
  reason: "lead_asked" | "stall_threshold" | "named_in_comment";
  lead: DecisionCardAgentRef | null;
  /** The lead agent's latest comment on the task, shortened. Null when it has said nothing. */
  summary: string | null;
}

export interface DecisionCard {
  /**
   * `task:<issueId>` for task cards, `item:<dedupKey>` for company-level cards,
   * `setup:<agentId>:<cause>` for one setup gap that stopped several tasks.
   */
  id: string;
  /** The main kind, used for the title and the next step. */
  kind: DecisionCardKind;
  /** Every kind merged into this card, main kind first. */
  kinds: DecisionCardKind[];
  /** The task this card is about. Null for company-level cards (connection alerts, budgets). */
  task: AttentionSubject | null;
  /** What is blocked. */
  title: string;
  /** The decision: one sentence saying exactly what is asked of the viewer. */
  decision: string;
  why: DecisionCardWhy;
  facts: DecisionCardFacts;
  recommendation: DecisionCardRecommendation | null;
  /** A question card's questions with their options. Empty for other kinds. */
  questions: DecisionCardQuestion[];
  escalation?: DecisionCardEscalation | null;
  /** The real reason or error. */
  reason: string;
  /** The agent whose work waits on the board. */
  waiting: DecisionCardAgentRef | null;
  /** The pending reviewer when the task waits on a review stage. */
  reviewer?: DecisionCardReviewer | null;
  /** What happens next if nobody acts, or once the board acts. */
  nextStep: string;
  severity: AttentionSeverity;
  activityAt: string;
  createdAt: string;
  actions: DecisionCardAction[];
  clarity: DecisionCardClarity | null;
  /** Source rows merged into this card. Native resolvers (question forms) use these. */
  items: AttentionItem[];
  /** Set when every row on the card needs the board user at the computer. */
  atDesk?: DecisionCardAtDesk | null;
  /** Set when the card is about a repeated setup failure (GRE-504). */
  setup?: DecisionCardSetup | null;
}

export interface DecisionsFeed {
  companyId: string;
  generatedAt: string;
  /**
   * Cards outside "At your desk" (GRE-450). Part of the number the UI shows;
   * every "needs you" count reads `NeedsMe.decisionCount`.
   */
  count: number;
  /** Cards that need the board user at the computer, outside `count`. */
  atDeskCount?: number;
  countsByKind: Record<DecisionCardKind, number>;
  /** Source rows dropped because their cause is gone. Diagnostic only. */
  staleCleared: number;
  assignableAgents: DecisionCardAgentRef[];
  cards: DecisionCard[];
  /**
   * Agent-side stalls with no ask of a person: handed to the lead agent first
   * and not shown as cards. Not in `count`.
   */
  routedToLead?: Array<{
    taskId: string;
    identifier: string | null;
    title: string;
    lead: DecisionCardAgentRef | null;
    routedAt: string | null;
  }>;
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
 * A task that has waited on the user or the board for more than 24h
 * (GRE-500). `waitingForMs` is its age at `generatedAt`.
 */
export interface NeedsMeOverdueWait extends NeedsMeTask {
  assigneeAgentId: string | null;
  owner: "board" | "user";
  action: string;
  waitingSinceAt: string;
  waitingForMs: number;
  /** When the assignee was woken once to re-check the block; null until then. */
  recheckWokenAt: string | null;
}

/**
 * A question an agent asked on an open task that expired before anyone
 * answered it, in the last two days. The agent has been woken to ask again
 * or carry on; the user may still want to answer it.
 */
export interface NeedsMeExpiredCard {
  interactionId: string;
  /** The task the card was on. */
  id: string;
  identifier: string | null;
  title: string;
  /** The card's own title, for example the question it asked. */
  question: string | null;
  expiredAt: string;
}

/**
 * What truly needs the board user: open decisions waiting on them, plus
 * tasks assigned to them that are not done. Tasks they only created or
 * commented on are not included.
 */
export interface NeedsMe {
  companyId: string;
  generatedAt: string;
  /** `decisionCount` plus assigned tasks. A task is never counted twice. */
  count: number;
  /**
   * The one "needs you" number shown everywhere: every decision card except
   * "At your desk" ones (GRE-450), every overdue wait and every expired
   * question listed here.
   */
  decisionCount: number;
  assignedTaskCount: number;
  decisions: DecisionCard[];
  /** Assigned open tasks, without the ones already shown as a decision card. */
  assignedTasks: NeedsMeTask[];
  /**
   * Waits on the user or the board older than 24h, oldest first. A task here
   * is not repeated in `assignedTasks` and has no decision card.
   */
  overdueWaits: NeedsMeOverdueWait[];
  /**
   * Questions from agents that expired unanswered on open tasks in the last
   * two days, newest first, one per task. A task here is not repeated as a
   * decision, an assigned task or an overdue wait.
   */
  expiredCards?: NeedsMeExpiredCard[];
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
