import type {
  AttentionItem,
  DecisionCard,
  DecisionCardAction,
  DecisionCardKind,
  DecisionsFeed,
  Issue,
} from "@greatstone/shared";

/**
 * Decisions feed fixtures (GRE-264) in the shape the GRE-263 server builds.
 * Shared by the component tests and the Storybook screens John reviews.
 */
export const FIXTURE_COMPANY_ID = "company-1";
const NOW = "2026-09-29T22:00:00.000Z";

export const fixtureAgents = [
  { id: "agent-ridge", name: "Ridge" },
  { id: "agent-mica", name: "Mica" },
  { id: "agent-summit", name: "Summit" },
];

function task(id: string, identifier: string, title: string) {
  return {
    kind: "issue",
    id,
    companyId: FIXTURE_COMPANY_ID,
    title,
    identifier,
    status: "blocked",
    href: `/issues/${identifier}`,
    metadata: {},
  } as unknown as DecisionCard["task"];
}

function request(method: "POST" | "PATCH", path: string, body: Record<string, unknown> = {}) {
  return { method, path, body };
}

function taskActions(issueId: string, cardId: string, opts: { retry?: boolean; resolve?: boolean; clarity?: boolean } = {}) {
  const path = `/api/issues/${issueId}`;
  const actions: DecisionCardAction[] = [];
  if (opts.retry) {
    actions.push({
      id: "retry",
      label: "Retry",
      description: "Send the task back to its owner to try again.",
      type: "request",
      requests: [request("POST", `${path}/recovery-actions/resolve`, { actionId: "rec-1", outcome: "restored", sourceIssueStatus: "todo" })],
      href: null,
      input: null,
    });
  }
  actions.push(
    {
      id: "reassign",
      label: "Reassign",
      description: "Give the task to another agent. The new owner is woken.",
      type: "request",
      requests: [request("PATCH", path, { assigneeUserId: null })],
      href: null,
      input: { field: "assigneeAgentId", type: "agent", label: "New owner", required: true },
    },
    {
      id: "instruct",
      label: "Give an instruction",
      description: "Post an instruction on the task and wake its owner.",
      type: "request",
      requests: [request("POST", `${path}/comments`, { resume: true })],
      href: null,
      input: { field: "body", type: "text", label: "Instruction", required: true },
    },
  );
  if (opts.resolve) {
    actions.push({
      id: "resolve",
      label: "Mark resolved",
      description: "Record that the problem is fixed and choose where the task goes.",
      type: "request",
      requests: [request("POST", `${path}/recovery-actions/resolve`, { actionId: "rec-1", outcome: "restored" })],
      href: null,
      input: {
        field: "sourceIssueStatus",
        type: "choice",
        label: "Task goes to",
        required: true,
        options: [
          { value: "done", label: "Done" },
          { value: "in_review", label: "In review" },
          { value: "todo", label: "Back to its owner" },
        ],
      },
    });
  }
  if (opts.clarity !== false) {
    actions.push({
      id: "ask_clarity",
      label: "Ask for clarity",
      description: "Send a short question to the owning agent and wake it. The answer shows on this card.",
      type: "request",
      requests: [request("POST", `/api/companies/${FIXTURE_COMPANY_ID}/decisions-feed/cards/${cardId}/clarity`)],
      href: null,
      input: { field: "question", type: "text", label: "Your question", required: true },
    });
  }
  actions.push({
    id: "cancel_task",
    label: "Cancel the task",
    description: "Stop the task for good.",
    type: "request",
    requests: [request("PATCH", path, { status: "cancelled" })],
    href: null,
    input: null,
  });
  return actions;
}

function card(input: Partial<DecisionCard> & { id: string; kind: DecisionCardKind; title: string }): DecisionCard {
  return {
    kinds: [input.kind],
    task: null,
    reason: "",
    waiting: null,
    nextStep: "",
    severity: "medium",
    activityAt: NOW,
    createdAt: NOW,
    actions: [],
    clarity: null,
    items: [],
    ...input,
  };
}

export function questionItem(interactionId: string, issueId: string, identifier: string): AttentionItem {
  return {
    id: `attention-${interactionId}`,
    sourceKind: "issue_thread_interaction",
    dismissalKey: `interaction:${interactionId}`,
    severity: "medium",
    subject: {
      kind: "interaction",
      id: interactionId,
      title: "Question",
      href: `/issues/${identifier}#interaction-${interactionId}`,
      metadata: { kind: "ask_user_questions", issueId, createdByAgentId: "agent-ridge" },
    },
    relatedIssue: { id: issueId, identifier, title: "Stalled runs recovery", href: `/issues/${identifier}` },
    originAgentName: "Ridge",
  } as unknown as AttentionItem;
}

export function questionCard(interactionId = "int-1", issueId = "issue-44", identifier = "GRE-44"): DecisionCard {
  const id = `task:${issueId}`;
  return card({
    id,
    kind: "question",
    task: task(issueId, identifier, "Stalled runs recovery"),
    title: `${identifier} Stalled runs recovery`,
    reason: "When a run is stuck, should I restart it?",
    waiting: { id: "agent-ridge", name: "Ridge" },
    nextStep: "Ridge waits for your answer, then continues.",
    actions: [
      { id: "open", label: "Answer", description: "Open the question on the task.", type: "link", requests: [], href: `/issues/${identifier}`, input: null },
      ...taskActions(issueId, id),
    ],
    items: [questionItem(interactionId, issueId, identifier)],
  });
}

/**
 * GRE-431: blocked GRE-44 asks a question and waits on stalled blocker GRE-58.
 * One card for GRE-44, with the blocker's own actions on it.
 */
export function questionWithBlockerCard(): DecisionCard {
  const base = questionCard();
  const blockerPath = "/api/issues/issue-58";
  return {
    ...base,
    kinds: ["question", "blocked"],
    severity: "high",
    nextStep: `${base.nextStep} It is also blocked by GRE-58, which has no live next step.`,
    actions: [
      base.actions[0]!,
      {
        id: "reassign_blocker",
        label: "Reassign GRE-58",
        description: "Give the blocker GRE-58 to another agent. The new owner is woken.",
        type: "request",
        requests: [request("PATCH", blockerPath, { assigneeUserId: null })],
        href: null,
        input: { field: "assigneeAgentId", type: "agent", label: "New owner", required: true },
      },
      {
        id: "instruct_blocker",
        label: "Instruct GRE-58",
        description: "Post an instruction on the blocker GRE-58 and wake its owner.",
        type: "request",
        requests: [request("POST", `${blockerPath}/comments`, { resume: true })],
        href: null,
        input: { field: "body", type: "text", label: "Instruction", required: true },
      },
      ...base.actions.slice(1),
    ],
    items: [
      ...base.items,
      {
        id: "attention-blocker-58",
        sourceKind: "blocker_attention",
        dismissalKey: "blocker:issue-58",
        dedupKey: "blocker:issue-58",
        severity: "high",
        subject: { kind: "issue", id: "issue-58", title: "Pick a ledger owner", identifier: "GRE-58", href: "/issues/GRE-58", metadata: {} },
        relatedIssue: base.items[0]!.relatedIssue,
      } as unknown as AttentionItem,
    ],
  };
}

/** GRE-138 style: one task, three sources merged to one card. */
export function mergedCard(): DecisionCard {
  const id = "task:issue-138";
  return card({
    id,
    kind: "recovery",
    kinds: ["recovery", "failed_run", "connection"],
    severity: "high",
    task: task("issue-138", "GRE-138", "Nightly backup of the client files"),
    title: "GRE-138 Nightly backup of the client files",
    reason: "The AI connection works again (since 22:41). The task is still stopped from the earlier failure.",
    waiting: { id: "agent-ridge", name: "Ridge" },
    nextStep: "Retry to continue the task, or reassign or cancel it.",
    actions: taskActions("issue-138", id, { retry: true, resolve: true }),
    clarity: {
      questionCommentId: "comment-1",
      question: "Did the backup finish before it stopped?",
      askedAt: "2026-09-29T21:40:00.000Z",
      agent: { id: "agent-ridge", name: "Ridge" },
      answer: {
        commentId: "comment-2",
        body: "No. It copied 3 of 5 folders. A retry starts from the fourth folder.",
        answeredAt: "2026-09-29T21:52:00.000Z",
      },
    },
  });
}

export function blockedCard(): DecisionCard {
  const id = "task:issue-201";
  return card({
    id,
    kind: "blocked",
    severity: "high",
    task: task("issue-201", "GRE-201", "Move the invoices to the new folder"),
    title: "GRE-201 Move the invoices to the new folder",
    reason: "GRE-201 Move the invoices to the new folder has no live next step and blocks 2 tasks. Owner: Summit.",
    waiting: { id: "agent-summit", name: "Summit" },
    nextStep: "2 blocked tasks wait until this task has a live owner. Reassign it, give an instruction, or cancel it.",
    actions: taskActions("issue-201", id, { resolve: false }),
  });
}

export function approvalCard(): DecisionCard {
  const id = "task:issue-77";
  return card({
    id,
    kind: "approval",
    task: task("issue-77", "GRE-77", "Hire a QA engineer"),
    title: "GRE-77 Hire a QA engineer",
    reason: "Approve hiring a QA engineer",
    waiting: { id: "agent-mica", name: "Mica" },
    nextStep: "Nothing moves until you approve or reject it.",
    actions: [
      { id: "approve", label: "Approve", description: "Approve the request.", type: "request", requests: [request("POST", "/api/approvals/appr-1/approve")], href: null, input: null },
      { id: "reject", label: "Reject", description: "Reject the request.", type: "request", requests: [request("POST", "/api/approvals/appr-1/reject")], href: null, input: null },
      ...taskActions("issue-77", id),
    ],
  });
}

export function failedRunCard(): DecisionCard {
  const id = "task:issue-90";
  return card({
    id,
    kind: "failed_run",
    severity: "high",
    task: task("issue-90", "GRE-90", "Send the weekly client report"),
    title: "GRE-90 Send the weekly client report",
    reason: "The mail server refused the login (535 authentication failed).",
    waiting: { id: "agent-ridge", name: "Ridge" },
    nextStep: "Automatic retries are used up. The task waits until you retry or reassign it.",
    actions: [
      {
        id: "retry",
        label: "Retry",
        description: "Run the failed run again.",
        type: "request",
        requests: [request("POST", "/api/agents/agent-ridge/wakeup", { source: "on_demand", reason: "retry_failed_run", failedRunId: "run-9" })],
        href: null,
        input: null,
      },
      ...taskActions("issue-90", id),
    ],
  });
}

export function reviewCard(): DecisionCard {
  const id = "task:issue-120";
  return card({
    id,
    kind: "review",
    severity: "low",
    task: task("issue-120", "GRE-120", "New price list for 2027"),
    title: "GRE-120 New price list for 2027",
    reason: "Summit asks you to review the new price list.",
    waiting: { id: "agent-summit", name: "Summit" },
    nextStep: "The task stays in review until you approve it or ask for changes.",
    actions: taskActions("issue-120", id),
  });
}

/** Company-level card: no task, so no Not now or Ask for clarity. */
export function connectionAlertCard(): DecisionCard {
  return card({
    id: "item:ai-connection:anthropic",
    kind: "connection",
    severity: "critical",
    title: "The Anthropic connection is down",
    reason: "Login required. Every agent that uses this connection is stopped.",
    nextStep: "Runs that use this connection stay stopped until it is reconnected.",
    actions: [
      { id: "reconnect", label: "Reconnect", description: "Open the AI connection and reconnect it.", type: "link", requests: [], href: "/settings/ai-connections", input: null },
      { id: "dismiss", label: "Dismiss", description: "Hide this card. It comes back if the problem happens again.", type: "request", requests: [request("POST", `/api/companies/${FIXTURE_COMPANY_ID}/inbox-dismissals`, { itemKey: "ai:anthropic", kind: "dismiss" })], href: null, input: null },
    ],
  });
}

export function noOwnerCard(): DecisionCard {
  const base = blockedCard();
  return {
    ...base,
    id: "task:issue-202",
    task: task("issue-202", "GRE-202", "Renew the office lease"),
    title: "GRE-202 Renew the office lease",
    reason: "GRE-202 Renew the office lease has no live next step and blocks 1 task. It has no agent owner.",
    waiting: null,
    actions: taskActions("issue-202", "task:issue-202", { clarity: false }),
  };
}

export function fixtureFeed(cards: DecisionCard[]): DecisionsFeed {
  const countsByKind = {} as DecisionsFeed["countsByKind"];
  for (const entry of cards) countsByKind[entry.kind] = (countsByKind[entry.kind] ?? 0) + 1;
  return {
    companyId: FIXTURE_COMPANY_ID,
    generatedAt: NOW,
    count: cards.length,
    countsByKind,
    staleCleared: 0,
    assignableAgents: fixtureAgents,
    cards,
  };
}

export function tabledIssue(id: string, identifier: string, title: string, tabledUntil: string | null): Issue {
  return {
    id,
    companyId: FIXTURE_COMPANY_ID,
    identifier,
    title,
    status: "backlog",
    tabledAt: "2026-09-29T20:00:00.000Z",
    tabledUntil,
    tabledFromStatus: "todo",
  } as unknown as Issue;
}
