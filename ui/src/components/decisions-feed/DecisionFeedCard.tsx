import { useId, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ExternalLink, Loader2, MessageCircleQuestion } from "lucide-react";
import type {
  Agent,
  AttentionDetailDeliverable,
  AttentionDetailImage,
  AttentionItem,
  DecisionCard,
  DecisionCardAction,
  DecisionCardAgentRef,
  DecisionCardKind,
} from "@greatstone/shared";
import { Link } from "@/lib/router";
import { decisionsFeedApi, runDecisionCardAction } from "../../api/decisionsFeed";
import { attentionDetailDeliverables, attentionDetailImages, attentionImageUrl, severityStyle } from "../../lib/attention";
import { DECISION_KIND_LABEL, decisionKindLabel } from "../../lib/decision-kind-label";
import { focusItemIssueId, focusItemKind, isFocusItem } from "../../lib/focus-items";
import { queryKeys } from "../../lib/queryKeys";
import { cn, formatDateTime, relativeTime } from "../../lib/utils";
import { AttentionInteractionResolver } from "../AttentionInteractionResolver";
import { DecisionResolver } from "../DecisionResolver";
import { ImageGalleryModal, type GalleryMediaItem } from "../ImageGalleryModal";
import { MarkdownBody } from "../MarkdownBody";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { NotNowButton } from "./NotNowButton";
import { AtDeskPanel } from "./AtDeskPanel";
import { useIsPhone } from "../../hooks/useIsPhone";
import { attachmentThumbnailSrc } from "../../lib/issue-attachments";
import { DeliverableDocumentView } from "../deliverables/DeliverableDocument";
import { ReviewWorkEvidence, reviewDetailOf } from "../ReviewDecisionSummary";
import { useToastActions } from "../../context/ToastContext";

export { DECISION_KIND_LABEL, decisionKindLabel };

/** The task a card is about. Falls back to the `task:<id>` card id. */
export function decisionCardTaskId(card: DecisionCard): string | null {
  if (card.task?.id) return card.task.id;
  return card.id.startsWith("task:") ? card.id.slice("task:".length) : null;
}

/** The task's screenshots across the card's rows, newest first, each once. */
export function decisionCardImages(card: DecisionCard): AttentionDetailImage[] {
  const byAsset = new Map(card.items.flatMap(attentionDetailImages).map((image) => [image.assetId, image]));
  return [...byAsset.values()];
}

/** The task's deliverables across the card's rows, in feed order, each once (GRE-451). */
export function decisionCardDeliverables(card: DecisionCard): AttentionDetailDeliverable[] {
  const byId = new Map(card.items.flatMap(attentionDetailDeliverables).map((deliverable) => [deliverable.id, deliverable]));
  return [...byId.values()];
}

/** The first row Focus can answer natively (question, confirmation, suggested tasks). */
export function decisionCardQuestionItem(card: DecisionCard): AttentionItem | null {
  return card.items.find(isFocusItem) ?? null;
}

/** The review row that carries what the agent handed over (GRE-1421). */
export function decisionCardReviewItem(card: DecisionCard): AttentionItem | null {
  return card.items.find((item) => item.sourceKind === "review" && reviewDetailOf(item) !== null) ?? null;
}

const VERDICT_ACTION_IDS = new Set<DecisionCardAction["id"]>(["approve", "request_changes", "send_back"]);

/** A review's verdict buttons, each with what it does, for the "Your choices" list. */
export function reviewChoiceActions(card: DecisionCard): DecisionCardAction[] {
  if (!card.kinds.includes("review")) return [];
  return card.actions.filter((action) => VERDICT_ACTION_IDS.has(action.id));
}

/** The card's options, minus the ones the card renders in its own way. */
export function visibleCardActions(card: DecisionCard): DecisionCardAction[] {
  const answersInPlace = decisionCardQuestionItem(card) !== null;
  return card.actions.filter((action) => {
    // Ask for clarity and Not now sit under the options as quieter buttons.
    if (action.id === "ask_clarity" || action.id === "not_now") return false;
    // Done sits in the "At your desk" panel, next to the command (GRE-450).
    if (action.id === "done") return false;
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
  /**
   * Focus puts the card's other work inside its question card (GRE-431), so
   * one issue is one card: no frame and no title of its own.
   */
  embedded?: boolean;
  /** Called after any action, answer, question or Not now. */
  onActed?: () => void;
  /** Focus moves to the next card on its own, so it skips the "done" toast. */
  quietSuccess?: boolean;
  className?: string;
}

/** "for 3 hours", "for 2 days": how long a decision has waited. */
export function waitedFor(since: string, now = Date.now()): string {
  const hours = Math.floor((now - new Date(since).getTime()) / 3_600_000);
  if (!Number.isFinite(hours) || hours < 1) return "for under an hour";
  if (hours < 48) return `for ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.floor(hours / 24);
  return `for ${days} days`;
}

/** Kinds whose `reason` is a real cause worth showing beside the decision. */
const CAUSE_KINDS = new Set<DecisionCardKind>(["recovery", "failed_run", "agent_error", "budget", "outage"]);

/**
 * One Decisions card (GRE-264): the decision asked of you, why it matters,
 * the facts behind it, and each option with what it leads to. The server
 * decides which options a card has; the card renders what it is given.
 * List, Focus and the Desk all render it.
 */
export function DecisionFeedCard({
  card,
  companyId,
  assignableAgents,
  agentMap,
  currentUserId,
  hideInlineResolver = false,
  embedded = false,
  onActed,
  quietSuccess = false,
  className,
}: DecisionFeedCardProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const taskId = decisionCardTaskId(card);
  const taskIdentifier = card.task?.identifier ?? null;
  const taskHref = card.task?.href ?? null;
  const severity = severityStyle(card.severity);
  const [openActionId, setOpenActionId] = useState<string | null>(null);
  const [clarityOpen, setClarityOpen] = useState(false);
  const isPhone = useIsPhone();

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
    // The Desk lists the same tasks; an action can move one between its groups.
    queryClient.invalidateQueries({ queryKey: ["issues"] });
    onActed?.();
  };

  const actionMutation = useMutation({
    mutationFn: ({ action, value }: { action: DecisionCardAction; value?: string | null }) =>
      runDecisionCardAction(action, value),
    onSuccess: (_result, { action }) => {
      setOpenActionId(null);
      if (!quietSuccess) pushToast({ title: `${action.label}: done`, body: card.title, tone: "success" });
    },
    // A multi-request action can fail half way: refresh either way, so the
    // card shows what really happened instead of its state before the press.
    onSettled: refresh,
  });
  // One action at a time on a card: a second press while one runs is ignored.
  const busy = actionMutation.isPending;

  const clarityAction = card.actions.find((action) => action.id === "ask_clarity") ?? null;
  const notNowAction = card.actions.find((action) => action.id === "not_now") ?? null;
  const actions = visibleCardActions(card);
  const openAction = actions.find((action) => action.id === openActionId) ?? null;
  const doneAction = card.actions.find((action) => action.id === "done") ?? null;
  // An at-desk confirmation is answered with Done, not a second Accept.
  const questionItem = hideInlineResolver
    ? null
    : doneAction
      ? card.items.find((item) => isFocusItem(item) && focusItemKind(item) !== "request_confirmation") ?? null
      : decisionCardQuestionItem(card);
  const answersInPlace = questionItem !== null;
  const decisionItems = hideInlineResolver ? [] : card.items.filter((item) => item.sourceKind === "decision");
  const reviewItem = decisionCardReviewItem(card);
  // The question box shows the question itself (a yes/no confirmation or one question); the
  // decision line would repeat it.
  const decisionShown = !(answersInPlace && card.questions.length <= 1);

  const runAction = (action: DecisionCardAction) => {
    if (action.type === "link" || busy || action.disabledReason) return;
    if (action.input || action.id === "cancel_task") {
      actionMutation.reset();
      setOpenActionId((current) => (current === action.id ? null : action.id));
      return;
    }
    actionMutation.mutate({ action });
  };

  const Frame = embedded ? "section" : "article";

  return (
    <Frame
      className={cn(
        embedded
          ? "flex flex-col gap-3 border-t border-border pt-4"
          : "relative flex flex-col gap-3 overflow-hidden rounded-xl border border-border bg-card px-4 pt-3 pb-4",
        className,
      )}
      data-decision-card={card.id}
      data-decision-kind={card.kind}
      aria-label={embedded ? "Also on this task" : card.title}
    >
      {embedded ? null : <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1", severity.accent)} />}

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
              {decisionKindLabel(card, kind)}
            </span>
          ))}
          <span className="sr-only">Severity: {severity.label}</span>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground" title={formatDateTime(card.activityAt)}>
          {relativeTime(card.activityAt)}
        </span>
      </div>

      <h3 className="text-base font-semibold leading-snug">
        {embedded ? (
          "Also on this task"
        ) : taskHref ? (
          <Link to={taskHref} className="hover:underline">
            {card.title}
          </Link>
        ) : (
          card.title
        )}
      </h3>

      {/* The decision: what exactly is asked of you, in one sentence. */}
      {decisionShown ? (
        <p className="text-sm font-medium leading-snug" data-decision-sentence>
          {card.decision}
        </p>
      ) : null}

      {card.escalation ? <EscalationNote escalation={card.escalation} /> : null}

      <dl className="grid gap-x-3 gap-y-1.5 text-sm sm:grid-cols-(--gtc-16)">
        <CardFact label="Why">
          <span data-decision-why>
            {card.why.text} Waiting {waitedFor(card.why.waitingSince)}.
          </span>
        </CardFact>
        {CAUSE_KINDS.has(card.kind) && card.reason && card.reason !== card.decision ? (
          <CardFact label="Cause">{card.reason}</CardFact>
        ) : null}
        {card.reviewer ? (
          <CardFact label="Reviewer">{card.reviewer.isYou ? `You (${card.reviewer.name})` : card.reviewer.name}</CardFact>
        ) : null}
        {card.waiting || !card.reviewer ? (
          // On a review the board is the one waited on; the agent did the work.
          <CardFact label={card.kind === "review" ? "Work by" : "Owner"}>
            {card.waiting ? card.waiting.name : <span className="text-muted-foreground">No agent owns this yet.</span>}
          </CardFact>
        ) : null}
        {card.facts.latestComment ? (
          <CardFact label="Latest">
            <span data-decision-latest-comment>
              <span className="text-muted-foreground">
                {card.facts.latestComment.agent?.name ?? "The agent"}, {relativeTime(card.facts.latestComment.at)}:
              </span>{" "}
              {card.facts.latestComment.excerpt}
            </span>
          </CardFact>
        ) : null}
        {card.facts.blockerChain.length > 0 ? (
          <CardFact label="Waits on">
            <TaskRefLinks refs={card.facts.blockerChain} />
          </CardFact>
        ) : null}
        {card.why.holdsUp.length > 0 ? (
          <CardFact label="Holds up">
            <TaskRefLinks refs={card.why.holdsUp} />
          </CardFact>
        ) : null}
        {card.setup ? <SetupFacts setup={card.setup} showTasks={!card.task} /> : null}
      </dl>

      {card.atDesk ? (
        <AtDeskPanel
          command={card.atDesk.command}
          doneAction={doneAction}
          pending={actionMutation.isPending && actionMutation.variables?.action.id === "done"}
          onDone={() => doneAction && runAction(doneAction)}
        />
      ) : null}

      {reviewItem ? <ReviewWorkEvidence item={reviewItem} agentMap={agentMap} knownAgent={card.waiting} /> : null}

      <DecisionCardDeliverables card={card} />

      <DecisionCardImages card={card} />

      {questionItem && focusItemIssueId(questionItem) ? (
        <AttentionInteractionResolver
          companyId={companyId}
          issueId={focusItemIssueId(questionItem)!}
          interactionId={questionItem.subject.id}
          agentMap={agentMap}
          currentUserId={currentUserId}
          onResolved={refresh}
          embedded
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

      {card.recommendation ? (
        <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm" data-decision-recommendation>
          <span className="font-medium">{card.recommendation.by?.name ?? "The agent"} recommends: </span>
          {card.recommendation.text}
        </p>
      ) : null}

      {actions.length > 0 ? (
        <CardOptions
          title={answersInPlace ? "Other options" : "Your options"}
          actions={actions}
          size={isPhone ? "lg" : "sm"}
          busy={busy}
          pendingId={busy ? actionMutation.variables?.action.id ?? null : null}
          openId={openActionId}
          onRun={runAction}
        />
      ) : null}

      {clarityAction || (notNowAction && taskId) || card.task?.href ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {clarityAction ? (
            <Button
              type="button"
              size={isPhone ? "sm" : "xs"}
              variant="ghost"
              aria-expanded={clarityOpen}
              aria-describedby={clarityAction.disabledReason ? `clarity-reason-${card.id}` : undefined}
              disabled={Boolean(clarityAction.disabledReason) || busy}
              title={clarityAction.disabledReason ?? clarityAction.description}
              onClick={() => setClarityOpen((open) => !open)}
            >
              <MessageCircleQuestion />
              Ask for clarity
            </Button>
          ) : null}
          {notNowAction && taskId ? (
            <NotNowButton companyId={companyId} issueId={taskId} issueLabel={taskIdentifier} onTabled={onActed} />
          ) : null}
          {clarityAction?.disabledReason ? (
            <span id={`clarity-reason-${card.id}`} className="text-xs text-muted-foreground">
              {clarityAction.disabledReason}
            </span>
          ) : null}
        </div>
      ) : null}

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

      {clarityOpen && taskId && clarityAction && !clarityAction.disabledReason ? (
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
    </Frame>
  );
}

/** Why an agent-side stall now reaches you, with the lead agent's summary. */
function EscalationNote({ escalation }: { escalation: NonNullable<DecisionCard["escalation"]> }) {
  const lead = escalation.lead?.name ?? "The lead agent";
  const why = escalation.reason === "stall_threshold"
    ? `${lead} had it for a day and could not get it moving, so it comes to you.`
    : escalation.reason === "lead_asked"
      ? `${lead} looked at it and asked you.`
      : "The owning agent named you in its latest comment.";
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm" data-decision-escalation={escalation.reason}>
      <p>{why}</p>
      {escalation.reason !== "named_in_comment" ? (
        <p className="mt-1">
          <span className="font-medium">{lead}'s summary: </span>
          {escalation.summary ?? <span className="text-muted-foreground">{lead} has not written one.</span>}
        </p>
      ) : null}
    </div>
  );
}

function TaskRefLinks({ refs }: { refs: DecisionCard["why"]["holdsUp"] }) {
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {refs.map((ref) => (
        <Link key={ref.id} to={ref.href} className="hover:underline" title={ref.title}>
          {ref.identifier ? <span className="font-mono text-xs text-muted-foreground">{ref.identifier} </span> : null}
          {ref.title}
        </Link>
      ))}
    </span>
  );
}

/**
 * The card's options (GRE-1421, now every kind): each button with one line on
 * what it leads to, so the consequence is read at the point of choice. The
 * owning agent's recommended option is marked.
 */
function CardOptions({
  title,
  actions,
  size,
  busy,
  pendingId,
  openId,
  onRun,
}: {
  title: string;
  actions: DecisionCardAction[];
  size: "sm" | "lg";
  busy: boolean;
  pendingId: string | null;
  openId: string | null;
  onRun: (action: DecisionCardAction) => void;
}) {
  const hintIdPrefix = `card-option-${useId()}`;
  return (
    <section className="flex flex-col gap-1.5" aria-label={title} data-card-options>
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      <ul className="flex flex-col gap-2">
        {actions.map((action) => (
          <li
            key={action.id}
            className="flex flex-col gap-1 sm:grid sm:grid-cols-(--gtc-41) sm:items-center sm:gap-3"
            data-card-option={action.id}
            data-review-choice={VERDICT_ACTION_IDS.has(action.id) ? action.id : undefined}
          >
            <CardActionButton
              action={action}
              size={size}
              block
              describedBy={`${hintIdPrefix}-${action.id}`}
              pending={pendingId === action.id}
              disabled={busy || Boolean(action.disabledReason)}
              open={openId === action.id}
              onRun={() => onRun(action)}
            />
            <p id={`${hintIdPrefix}-${action.id}`} className="text-sm text-muted-foreground">
              {action.recommended ? <span className="mr-1.5 font-medium text-foreground">Recommended.</span> : null}
              {action.disabledReason ?? action.description}
            </p>
          </li>
        ))}
      </ul>
    </section>
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

/** How often one setup gap stopped the agent, and which tasks wait on it (GRE-504). */
function SetupFacts({ setup, showTasks }: { setup: NonNullable<DecisionCard["setup"]>; showTasks: boolean }) {
  return (
    <>
      <CardFact label="Seen">
        <span data-setup-count>
          {setup.failureCount} {setup.failureCount === 1 ? "failure" : "failures"}, last{" "}
          <span title={formatDateTime(setup.lastSeenAt)}>{relativeTime(setup.lastSeenAt)}</span>
        </span>
      </CardFact>
      {showTasks && setup.tasks.length > 0 ? (
        <CardFact label="Tasks">
          <span className="flex flex-wrap gap-x-2 gap-y-1">
            {setup.tasks.map((task) => (
              <Link key={task.id} to={`/issues/${task.identifier ?? task.id}`} className="hover:underline" title={task.title}>
                {task.identifier ?? task.title}
              </Link>
            ))}
          </span>
        </CardFact>
      ) : null}
    </>
  );
}

function isPrimaryCardAction(action: DecisionCardAction): boolean {
  return action.id === "approve" || action.id === "retry" || action.id === "reconnect" || action.id === "open"
    || action.id === "fix_setup";
}

function CardActionButton({
  action,
  pending,
  disabled = false,
  open,
  onRun,
  size = "xs",
  block = false,
  describedBy,
}: {
  action: DecisionCardAction;
  pending: boolean;
  /** Another action on the card is running, or the option cannot be used. */
  disabled?: boolean;
  open: boolean;
  onRun: () => void;
  size?: "xs" | "sm" | "lg";
  /** Full-width, left-aligned row (the phone More sheet). */
  block?: boolean;
  /** Id of the line that says what the action does; it replaces the hover title. */
  describedBy?: string;
}) {
  const primary = isPrimaryCardAction(action);
  const variant = primary ? "default" : action.id === "cancel_task" || action.id === "reject" ? (block ? "outline" : "ghost") : "outline";
  if (action.type === "link" && action.href) {
    return (
      <Button asChild size={size} variant={variant} title={action.description} className={cn(block && "w-full justify-start")}>
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
      size={size}
      variant={variant}
      title={describedBy ? undefined : action.description}
      aria-describedby={describedBy}
      aria-expanded={action.input || action.id === "cancel_task" ? open : undefined}
      disabled={pending || disabled}
      className={cn(block && "w-full justify-start", action.id === "cancel_task" && "text-destructive hover:text-destructive")}
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

/** What the agent is showing: a design choice is judged on the screenshots, not the words. */
function DecisionCardImages({ card }: { card: DecisionCard }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const items: GalleryMediaItem[] = decisionCardImages(card).map((image) => ({
    id: image.assetId,
    contentPath: attentionImageUrl(image.assetId),
    contentType: "image/*",
    originalFilename: image.alt ?? null,
  }));
  if (items.length === 0) return null;
  return (
    <>
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" data-decision-images>
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setOpenIndex(index)}
            aria-label={`Open image ${index + 1} of ${items.length}${item.originalFilename ? `, ${item.originalFilename}` : ""}`}
            className="shrink-0 overflow-hidden rounded-lg border border-border bg-muted transition-colors hover:border-primary/50 focus-visible:ring-ring focus-visible:ring-(length:--rad-3) focus-visible:outline-none"
          >
            <img
              src={attachmentThumbnailSrc(item.contentPath, 640)}
              alt={item.originalFilename ?? ""}
              loading="lazy"
              className="h-32 w-52 object-cover object-top sm:h-40 sm:w-64"
            />
          </button>
        ))}
      </div>
      <ImageGalleryModal
        items={items}
        initialIndex={openIndex ?? 0}
        open={openIndex !== null}
        onOpenChange={(open) => { if (!open) setOpenIndex(null); }}
      />
    </>
  );
}

/**
 * The real thing John is asked to approve, open on the card (GRE-451): he
 * judges the deliverable itself without leaving the Decisions feed.
 */
function DecisionCardDeliverables({ card }: { card: DecisionCard }) {
  const deliverables = decisionCardDeliverables(card);
  const [shownId, setShownId] = useState<string | null>(null);
  const shown = deliverables.find((deliverable) => deliverable.id === shownId) ?? deliverables[0] ?? null;
  if (!shown) return null;
  return (
    <section className="overflow-hidden rounded-lg border border-border" aria-label="Deliverable" data-decision-deliverable>
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
        {deliverables.length > 1 ? (
          <div className="flex min-w-0 flex-1 flex-wrap gap-1" role="group" aria-label="Deliverables on this task">
            {deliverables.map((deliverable) => (
              <Button
                key={deliverable.id}
                type="button"
                size="xs"
                variant={deliverable.id === shown.id ? "secondary" : "ghost"}
                aria-pressed={deliverable.id === shown.id}
                onClick={() => setShownId(deliverable.id)}
              >
                {deliverable.title}
              </Button>
            ))}
          </div>
        ) : (
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{shown.title}</p>
        )}
        <Button asChild size="xs" variant="ghost">
          <a href={shown.contentPath} target="_blank" rel="noreferrer">
            Open full size
            <ExternalLink />
          </a>
        </Button>
      </div>
      <div className="h-80 sm:h-96">
        <DeliverableDocumentView source={{ ...shown, originalFilename: shown.originalFilename ?? null }} />
      </div>
    </section>
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
