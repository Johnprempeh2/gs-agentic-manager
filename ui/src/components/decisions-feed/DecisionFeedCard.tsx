import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Loader2, MessageCircleQuestion } from "lucide-react";
import type {
  Agent,
  AttentionItem,
  DecisionCard,
  DecisionCardAction,
  DecisionCardAgentRef,
  DecisionCardKind,
} from "@greatstone/shared";
import { Link } from "@/lib/router";
import { decisionsFeedApi, runDecisionCardAction } from "../../api/decisionsFeed";
import { severityStyle } from "../../lib/attention";
import { focusItemIssueId, isFocusItem } from "../../lib/focus-items";
import { queryKeys } from "../../lib/queryKeys";
import { cn, relativeTime } from "../../lib/utils";
import { AttentionInteractionResolver } from "../AttentionInteractionResolver";
import { DecisionResolver } from "../DecisionResolver";
import { MarkdownBody } from "../MarkdownBody";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { NotNowButton } from "./NotNowButton";

export const DECISION_KIND_LABEL: Record<DecisionCardKind, string> = {
  question: "Question",
  approval: "Approval",
  connection: "Connection",
  recovery: "Stopped",
  failed_run: "Failed run",
  blocked: "Blocked",
  review: "Review",
  decision: "Decision",
  budget: "Budget",
  agent_error: "Agent error",
  join_request: "Join request",
};

/** The task a card is about. Falls back to the `task:<id>` card id. */
export function decisionCardTaskId(card: DecisionCard): string | null {
  if (card.task?.id) return card.task.id;
  return card.id.startsWith("task:") ? card.id.slice("task:".length) : null;
}

/** The first row Focus can answer natively (question, confirmation, suggested tasks). */
export function decisionCardQuestionItem(card: DecisionCard): AttentionItem | null {
  return card.items.find(isFocusItem) ?? null;
}

/** Card buttons, minus the ones the card renders in its own way. */
export function visibleCardActions(card: DecisionCard): DecisionCardAction[] {
  const answersInPlace = decisionCardQuestionItem(card) !== null;
  return card.actions.filter((action) => {
    if (action.id === "ask_clarity") return false;
    // A question is answered on the card, so its "Answer" link is not needed.
    if (answersInPlace && action.type === "link" && action.id === "open") return false;
    return true;
  });
}

export interface DecisionFeedCardProps {
  card: DecisionCard;
  companyId: string;
  assignableAgents: DecisionCardAgentRef[];
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  /** Focus renders the question itself; the card then shows only its frame. */
  hideInlineResolver?: boolean;
  /** Called after any action, answer, question or Not now. */
  onActed?: () => void;
  className?: string;
}

/**
 * One Decisions card (GRE-264): what is blocked, why, who is waiting and what
 * happens next, with the real actions as buttons, Ask for clarity and Not now.
 * List and Focus both render it, so John can act without opening the chat.
 */
export function DecisionFeedCard({
  card,
  companyId,
  assignableAgents,
  agentMap,
  currentUserId,
  hideInlineResolver = false,
  onActed,
  className,
}: DecisionFeedCardProps) {
  const queryClient = useQueryClient();
  const taskId = decisionCardTaskId(card);
  const taskIdentifier = card.task?.identifier ?? null;
  const taskHref = card.task?.href ?? null;
  const severity = severityStyle(card.severity);
  const [openActionId, setOpenActionId] = useState<string | null>(null);
  const [clarityOpen, setClarityOpen] = useState(false);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
    onActed?.();
  };

  const actionMutation = useMutation({
    mutationFn: ({ action, value }: { action: DecisionCardAction; value?: string | null }) =>
      runDecisionCardAction(action, value),
    onSuccess: () => {
      setOpenActionId(null);
      refresh();
    },
  });

  const clarityAction = card.actions.find((action) => action.id === "ask_clarity") ?? null;
  const actions = visibleCardActions(card);
  const openAction = actions.find((action) => action.id === openActionId) ?? null;
  const questionItem = hideInlineResolver ? null : decisionCardQuestionItem(card);
  const decisionItems = hideInlineResolver ? [] : card.items.filter((item) => item.sourceKind === "decision");

  const runAction = (action: DecisionCardAction) => {
    if (action.type === "link") return;
    if (action.input || action.id === "cancel_task") {
      actionMutation.reset();
      setOpenActionId((current) => (current === action.id ? null : action.id));
      return;
    }
    actionMutation.mutate({ action });
  };

  return (
    <article
      className={cn(
        "relative flex flex-col gap-3 overflow-hidden rounded-xl border border-border bg-card px-4 pt-3 pb-4",
        className,
      )}
      data-decision-card={card.id}
      data-decision-kind={card.kind}
      aria-label={card.title}
    >
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1", severity.accent)} />

      {/* Eyebrow: every merged kind, the task, and when it last moved. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {card.kinds.map((kind, index) => (
            <span
              key={kind}
              className={cn(
                "rounded-full border border-border px-2 py-0.5 font-medium",
                index === 0 ? "bg-accent text-foreground" : "text-muted-foreground",
              )}
            >
              {DECISION_KIND_LABEL[kind]}
            </span>
          ))}
          <span className="sr-only">Severity: {severity.label}</span>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground" title={new Date(card.activityAt).toLocaleString()}>
          {relativeTime(card.activityAt)}
        </span>
      </div>

      <h3 className="text-base font-semibold leading-snug">
        {taskHref ? (
          <Link to={taskHref} className="hover:underline">
            {card.title}
          </Link>
        ) : (
          card.title
        )}
      </h3>

      <dl className="grid gap-x-3 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr]">
        <CardFact label="Why">{card.reason}</CardFact>
        <CardFact label="Waiting">
          {card.waiting ? card.waiting.name : <span className="text-muted-foreground">No agent owns this yet.</span>}
        </CardFact>
        <CardFact label="Next">{card.nextStep}</CardFact>
      </dl>

      {questionItem && focusItemIssueId(questionItem) ? (
        <AttentionInteractionResolver
          companyId={companyId}
          issueId={focusItemIssueId(questionItem)!}
          interactionId={questionItem.subject.id}
          agentMap={agentMap}
          currentUserId={currentUserId}
          onResolved={refresh}
        />
      ) : null}

      {decisionItems.map((item) => (
        <DecisionResolver
          key={item.id}
          companyId={companyId}
          decisionId={item.subject.id}
          originIssue={item.relatedIssue}
          agentMap={agentMap}
          onResolved={refresh}
        />
      ))}

      {card.clarity ? <ClarityThread clarity={card.clarity} /> : null}

      <div className="flex flex-wrap items-center gap-1.5">
        {actions.map((action) => (
          <CardActionButton
            key={action.id}
            action={action}
            pending={actionMutation.isPending && actionMutation.variables?.action.id === action.id}
            open={openActionId === action.id}
            onRun={() => runAction(action)}
          />
        ))}
        {taskId ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-expanded={clarityOpen}
            disabled={!clarityAction}
            title={clarityAction ? clarityAction.description : "No agent owns this task. Reassign it first."}
            onClick={() => setClarityOpen((open) => !open)}
          >
            <MessageCircleQuestion />
            Ask for clarity
          </Button>
        ) : null}
        {taskId ? (
          <NotNowButton companyId={companyId} issueId={taskId} issueLabel={taskIdentifier} onTabled={onActed} />
        ) : null}
      </div>

      {openAction ? (
        <ActionInputPanel
          key={openAction.id}
          action={openAction}
          assignableAgents={assignableAgents}
          pending={actionMutation.isPending}
          error={actionMutation.error as Error | null}
          onCancel={() => setOpenActionId(null)}
          onSubmit={(value) => actionMutation.mutate({ action: openAction, value })}
        />
      ) : actionMutation.error ? (
        <p className="text-xs text-destructive" role="alert">
          {(actionMutation.error as Error).message}
        </p>
      ) : null}

      {clarityOpen && taskId ? (
        <AskForClarityForm
          companyId={companyId}
          cardId={card.id}
          agentName={card.waiting?.name ?? null}
          onAsked={() => {
            setClarityOpen(false);
            refresh();
          }}
          onCancel={() => setClarityOpen(false)}
        />
      ) : null}
    </article>
  );
}

function CardFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:pt-0.5">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function CardActionButton({
  action,
  pending,
  open,
  onRun,
}: {
  action: DecisionCardAction;
  pending: boolean;
  open: boolean;
  onRun: () => void;
}) {
  const primary = action.id === "approve" || action.id === "retry" || action.id === "reconnect" || action.id === "open";
  const variant = primary ? "default" : action.id === "cancel_task" || action.id === "reject" ? "ghost" : "outline";
  if (action.type === "link" && action.href) {
    return (
      <Button asChild size="xs" variant={variant} title={action.description}>
        <Link to={action.href}>
          {action.label}
          <ArrowUpRight />
        </Link>
      </Button>
    );
  }
  return (
    <Button
      type="button"
      size="xs"
      variant={variant}
      title={action.description}
      aria-expanded={action.input || action.id === "cancel_task" ? open : undefined}
      disabled={pending}
      className={cn(action.id === "cancel_task" && "text-destructive hover:text-destructive")}
      onClick={onRun}
    >
      {pending ? <Loader2 className="animate-spin" /> : null}
      {action.label}
    </Button>
  );
}

/** Inline form for an action that needs a value (agent, text or choice) or a confirm. */
export function ActionInputPanel({
  action,
  assignableAgents,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  action: DecisionCardAction;
  assignableAgents: DecisionCardAgentRef[];
  pending: boolean;
  error: Error | null;
  onCancel: () => void;
  onSubmit: (value: string | null) => void;
}) {
  const [value, setValue] = useState("");
  const input = action.input;
  const missing = Boolean(input?.required) && value.trim() === "";
  const fieldId = `decision-action-${action.id}`;

  return (
    <form
      className="space-y-2 rounded-lg border border-border bg-muted/30 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!missing) onSubmit(input ? value.trim() : null);
      }}
    >
      <p className="text-xs text-muted-foreground">{action.description}</p>
      {input?.type === "agent" ? (
        <Select value={value} onValueChange={setValue}>
          <SelectTrigger id={fieldId} aria-label={input.label} className="w-full sm:w-72">
            <SelectValue placeholder={`${input.label}…`} />
          </SelectTrigger>
          <SelectContent>
            {assignableAgents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : input?.type === "choice" ? (
        <Select value={value} onValueChange={setValue}>
          <SelectTrigger id={fieldId} aria-label={input.label} className="w-full sm:w-72">
            <SelectValue placeholder={`${input.label}…`} />
          </SelectTrigger>
          <SelectContent>
            {(input.options ?? []).map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : input?.type === "text" ? (
        <Textarea
          id={fieldId}
          aria-label={input.label}
          placeholder={input.label}
          value={value}
          rows={3}
          onChange={(event) => setValue(event.target.value)}
        />
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error.message}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          Back
        </Button>
        <Button
          type="submit"
          size="xs"
          variant={action.id === "cancel_task" ? "destructive" : "default"}
          disabled={pending || missing}
        >
          {pending ? <Loader2 className="animate-spin" /> : null}
          {action.id === "cancel_task" ? "Yes, cancel the task" : action.label}
        </Button>
      </div>
    </form>
  );
}

function newClientRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // RFC 4122 v4 fallback for old browsers and test environments.
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16),
  );
}

export function AskForClarityForm({
  companyId,
  cardId,
  agentName,
  onAsked,
  onCancel,
}: {
  companyId: string;
  cardId: string;
  agentName: string | null;
  onAsked: () => void;
  onCancel: () => void;
}) {
  const [question, setQuestion] = useState("");
  // One id per question, so a double click posts it once.
  const [clientRequestId] = useState(newClientRequestId);
  const ask = useMutation({
    mutationFn: () => decisionsFeedApi.askClarity(companyId, cardId, { question: question.trim(), clientRequestId }),
    onSuccess: onAsked,
  });
  const fieldId = `clarity-${cardId}`;
  return (
    <form
      className="space-y-2 rounded-lg border border-border bg-muted/30 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (question.trim()) ask.mutate();
      }}
    >
      <label htmlFor={fieldId} className="block text-xs text-muted-foreground">
        Ask {agentName ?? "the agent"} a short question. The answer shows on this card.
      </label>
      <Textarea
        id={fieldId}
        value={question}
        rows={2}
        maxLength={2000}
        placeholder="What do you need to know?"
        onChange={(event) => setQuestion(event.target.value)}
      />
      {ask.error ? (
        <p className="text-xs text-destructive" role="alert">
          {(ask.error as Error).message}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          Back
        </Button>
        <Button type="submit" size="xs" disabled={ask.isPending || question.trim() === ""}>
          {ask.isPending ? <Loader2 className="animate-spin" /> : null}
          Ask
        </Button>
      </div>
    </form>
  );
}

function ClarityThread({ clarity }: { clarity: NonNullable<DecisionCard["clarity"]> }) {
  const agentName = clarity.agent?.name ?? "The agent";
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3 text-sm" data-clarity>
      <div>
        <p className="text-xs font-medium text-muted-foreground">You asked · {relativeTime(clarity.askedAt)}</p>
        <p className="whitespace-pre-wrap break-words">{clarity.question}</p>
      </div>
      {clarity.answer ? (
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            {agentName} answered · {relativeTime(clarity.answer.answeredAt)}
          </p>
          <MarkdownBody className="text-sm">{clarity.answer.body}</MarkdownBody>
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Waiting for {agentName} to answer.
        </p>
      )}
    </div>
  );
}
