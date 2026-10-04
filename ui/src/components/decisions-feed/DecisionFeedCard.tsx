import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ExternalLink, Loader2, MessageCircleQuestion, MoreHorizontal } from "lucide-react";
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
import { focusItemIssueId, focusItemKind, isFocusItem } from "../../lib/focus-items";
import { queryKeys } from "../../lib/queryKeys";
import { cn, relativeTime } from "../../lib/utils";
import { AttentionInteractionResolver } from "../AttentionInteractionResolver";
import { DecisionResolver } from "../DecisionResolver";
import { ImageGalleryModal, type GalleryMediaItem } from "../ImageGalleryModal";
import { MarkdownBody } from "../MarkdownBody";
import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { NotNowButton } from "./NotNowButton";
import { AtDeskPanel } from "./AtDeskPanel";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet";
import { useIsPhone } from "../../hooks/useIsPhone";
import { attachmentThumbnailSrc } from "../../lib/issue-attachments";
import { DeliverableDocumentView } from "../deliverables/DeliverableDocument";

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

/**
 * The chip for one of a card's kinds. The feed files confirmations and
 * suggested tasks under "question"; the card names what it really asks for.
 */
export function decisionKindLabel(card: DecisionCard, kind: DecisionCardKind): string {
  if (kind === "question") {
    const interactionKind = card.items.find(isFocusItem);
    const itemKind = interactionKind ? focusItemKind(interactionKind) : null;
    if (itemKind === "request_confirmation" || itemKind === "request_checkbox_confirmation") return "Confirmation";
    if (itemKind === "suggest_tasks") return "Suggested tasks";
  }
  return DECISION_KIND_LABEL[kind];
}

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

/** Card buttons, minus the ones the card renders in its own way. */
export function visibleCardActions(card: DecisionCard): DecisionCardAction[] {
  const answersInPlace = decisionCardQuestionItem(card) !== null;
  return card.actions.filter((action) => {
    if (action.id === "ask_clarity") return false;
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
  embedded = false,
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
  const [moreOpen, setMoreOpen] = useState(false);
  const isPhone = useIsPhone();

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
  const doneAction = card.actions.find((action) => action.id === "done") ?? null;
  // An at-desk confirmation is answered with Done, not a second Accept.
  const questionItem = hideInlineResolver
    ? null
    : doneAction
      ? card.items.find((item) => isFocusItem(item) && focusItemKind(item) !== "request_confirmation") ?? null
      : decisionCardQuestionItem(card);
  // A card answered in place has its main action (Approve, Submit) in the
  // question itself; the card's own actions are then the rare ones and fold
  // into a menu, so the answer sits higher (GRE-360).
  const answersInPlace = questionItem !== null;
  // Phone: one main action up front, the rest in the More sheet.
  const phonePrimary = actions.find(isPrimaryCardAction) ?? (answersInPlace ? null : actions[0]) ?? null;
  const phoneMore = actions.filter((action) => action !== phonePrimary);
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
        <span className="shrink-0 text-xs text-muted-foreground" title={new Date(card.activityAt).toLocaleString()}>
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

      <dl className="grid gap-x-3 gap-y-1.5 text-sm sm:grid-cols-(--gtc-16)">
        <CardFact label="Why">{card.reason}</CardFact>
        <CardFact label="Waiting">
          {card.waiting ? card.waiting.name : <span className="text-muted-foreground">No agent owns this yet.</span>}
        </CardFact>
        <CardFact label="Next">{card.nextStep}</CardFact>
      </dl>

      {card.atDesk ? (
        <AtDeskPanel
          command={card.atDesk.command}
          doneAction={doneAction}
          pending={actionMutation.isPending && actionMutation.variables?.action.id === "done"}
          onDone={() => doneAction && runAction(doneAction)}
        />
      ) : null}

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

      {isPhone ? (
        // Phone: the main action, Not now, and More (a sheet with the rest as
        // big full-width rows), instead of a wrap of small buttons.
        <div className="flex items-center gap-2">
          {phonePrimary ? (
            <CardActionButton
              action={phonePrimary}
              size="sm"
              pending={actionMutation.isPending && actionMutation.variables?.action.id === phonePrimary.id}
              open={openActionId === phonePrimary.id}
              onRun={() => runAction(phonePrimary)}
            />
          ) : null}
          {taskId ? (
            <NotNowButton companyId={companyId} issueId={taskId} issueLabel={taskIdentifier} onTabled={onActed} />
          ) : null}
          {phoneMore.length > 0 || taskId ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="ml-auto"
              aria-label="More actions"
              onClick={() => setMoreOpen(true)}
            >
              <MoreHorizontal />
              More
            </Button>
          ) : null}
          <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
            <SheetContent side="bottom" className="rounded-t-xl pb-(--sz-safe-bottom)">
              <SheetHeader>
                <SheetTitle className="line-clamp-2 text-left">{card.title}</SheetTitle>
                <SheetDescription className="sr-only">More actions for this decision</SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-2 px-4 pb-4">
                {phoneMore.map((action) => (
                  <CardActionButton
                    key={action.id}
                    action={action}
                    size="lg"
                    block
                    pending={actionMutation.isPending && actionMutation.variables?.action.id === action.id}
                    open={openActionId === action.id}
                    onRun={() => {
                      setMoreOpen(false);
                      runAction(action);
                    }}
                  />
                ))}
                {taskId ? (
                  <Button
                    type="button"
                    size="lg"
                    variant="outline"
                    className="w-full justify-start"
                    disabled={!clarityAction}
                    onClick={() => {
                      setMoreOpen(false);
                      setClarityOpen(true);
                    }}
                  >
                    <MessageCircleQuestion />
                    Ask for clarity
                  </Button>
                ) : null}
              </div>
            </SheetContent>
          </Sheet>
        </div>
      ) : (
      <div className="flex flex-wrap items-center gap-1.5">
        {!answersInPlace && actions.map((action) => (
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
        {answersInPlace && actions.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="xs" variant="ghost" aria-label="More actions">
                <MoreHorizontal />
                More
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {actions.map((action) =>
                action.type === "link" && action.href ? (
                  <DropdownMenuItem key={action.id} asChild>
                    <Link to={action.href}>{action.label}</Link>
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    key={action.id}
                    variant={action.id === "cancel_task" ? "destructive" : "default"}
                    disabled={actionMutation.isPending}
                    onSelect={() => runAction(action)}
                  >
                    {action.label}
                  </DropdownMenuItem>
                ),
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      )}

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
    </Frame>
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

function isPrimaryCardAction(action: DecisionCardAction): boolean {
  return action.id === "approve" || action.id === "retry" || action.id === "reconnect" || action.id === "open";
}

function CardActionButton({
  action,
  pending,
  open,
  onRun,
  size = "xs",
  block = false,
}: {
  action: DecisionCardAction;
  pending: boolean;
  open: boolean;
  onRun: () => void;
  size?: "xs" | "sm" | "lg";
  /** Full-width, left-aligned row (the phone More sheet). */
  block?: boolean;
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
      title={action.description}
      aria-expanded={action.input || action.id === "cancel_task" ? open : undefined}
      disabled={pending}
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
