import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrandCaughtUpMark } from "../BrandPageTitle";
import type { Agent, DecisionCard, DecisionCardAgentRef } from "@greatstone/shared";
import { useToastActions } from "../../context/ToastContext";
import {
  answerFocusItem,
  focusProgress,
  initialFocusQueue,
  isFocusPending,
  loadFocusSession,
  markFocusGone,
  reviewSkippedFocus,
  saveFocusSession,
  selectFocusItem,
  skipFocusItem,
  stepFocus,
  syncFocusQueue,
  type FocusQueueState,
} from "../../lib/focus-queue";
import type { FocusPrefs } from "../../lib/focus-prefs";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { DecisionFeedCard, decisionCardQuestionItem, decisionKindLabel } from "../decisions-feed/DecisionFeedCard";
import { FocusQuestionCard } from "./FocusQuestionCard";

export interface DecisionsFocusViewProps {
  /** Every open Decisions card, in feed order (GRE-264: all kinds, not only questions). */
  cards: DecisionCard[];
  assignableAgents: DecisionCardAgentRef[];
  companyId: string;
  agentMap: Map<string, Agent>;
  currentUserId: string | null;
  prefs: FocusPrefs;
  onPrefsChange: (next: FocusPrefs) => void;
  onShowList: () => void;
}

/** Old sessions stored attention rows; only keep real cards. */
function isStoredCard(value: unknown): value is DecisionCard {
  return !!value && typeof value === "object" && Array.isArray((value as { kinds?: unknown }).kinds);
}

/**
 * Decisions Focus mode (GRE-55, GRE-264): one card at a time, a tab per card,
 * progress, and a caught-up screen. It takes every card that needs John, the
 * same set and count as List. A question is answered with the Focus form; every
 * other card shows its actions, Ask for clarity and Not now in place.
 */
export function DecisionsFocusView({
  cards,
  assignableAgents,
  companyId,
  agentMap,
  currentUserId,
  prefs,
  onPrefsChange,
  onShowList,
}: DecisionsFocusViewProps) {
  const { pushToast } = useToastActions();
  // Restore this browser session's Focus run, so Open task → Back keeps the count.
  const [restored] = useState(() => loadFocusSession<DecisionCard>(companyId));
  // Keep every card this session has shown, so done tabs stay (crossed out)
  // after the feed drops them.
  const [seenCards, setSeenCards] = useState<Map<string, DecisionCard>>(
    () => new Map((restored?.items ?? []).filter(isStoredCard).map((card) => [card.id, card])),
  );
  const [queue, setQueue] = useState<FocusQueueState>(() => restored?.queue ?? initialFocusQueue);
  // Questions answered or found closed on a card that still has other work.
  const [closedQuestionIds, setClosedQuestionIds] = useState<Set<string>>(() => new Set());
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const pushToastRef = useRef(pushToast);
  pushToastRef.current = pushToast;
  // Cards John acted on here. When they leave the feed they count as done, not
  // as "handled elsewhere".
  const actedRef = useRef(new Set<string>());

  useEffect(() => {
    saveFocusSession(companyId, {
      queue,
      items: queue.order.map((id) => seenCards.get(id)).filter(Boolean) as DecisionCard[],
    });
  }, [companyId, queue, seenCards]);

  const toastedGoneRef = useRef(new Set<string>());
  const toastHandledElsewhere = useCallback((id: string) => {
    if (toastedGoneRef.current.has(id)) return;
    toastedGoneRef.current.add(id);
    pushToastRef.current({
      id: `focus-gone-${id}`,
      title: "Handled elsewhere",
      body: "That card was closed on another screen, so Focus moved on.",
      tone: "info",
      ttlMs: 5000,
    });
  }, []);

  const openIdsKey = cards.map((card) => card.id).join("|");
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  useEffect(() => {
    const current = cardsRef.current;
    setSeenCards((previous) => {
      const next = new Map(previous);
      for (const card of current) next.set(card.id, card);
      return next;
    });
    const before = queueRef.current;
    let after = syncFocusQueue(before, current.map((card) => card.id));
    for (const id of after.gone) {
      if (actedRef.current.has(id) && !before.gone.includes(id)) after = answerFocusItem(after, id);
    }
    if (
      before.currentId &&
      before.currentId !== after.currentId &&
      after.gone.includes(before.currentId) &&
      !actedRef.current.has(before.currentId)
    ) {
      toastHandledElsewhere(before.currentId);
    }
    setQueue(after);
    // `openIdsKey` stands in for `cards`: the feed re-creates them on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openIdsKey]);

  // Keep the shown card fresh (clarity answers, new actions) between id changes.
  useEffect(() => {
    setSeenCards((previous) => {
      let changed = false;
      const next = new Map(previous);
      for (const card of cards) {
        if (next.get(card.id) !== card) {
          next.set(card.id, card);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [cards]);

  const handleActed = useCallback((cardId: string) => {
    actedRef.current.add(cardId);
  }, []);

  const handleSkip = useCallback(() => setQueue((state) => skipFocusItem(state)), []);
  const handleStep = useCallback((direction: 1 | -1) => setQueue((state) => stepFocus(state, direction)), []);

  const progress = focusProgress(queue);
  const percent = progress.total > 0 ? Math.round((progress.answered / progress.total) * 100) : 0;
  const tabs = useMemo(
    () => queue.order.filter((id) => !queue.gone.includes(id)).map((id) => seenCards.get(id)).filter(Boolean) as DecisionCard[],
    [queue.gone, queue.order, seenCards],
  );
  const current = queue.currentId ? seenCards.get(queue.currentId) ?? null : null;
  const questionItem = current ? decisionCardQuestionItem(current) : null;
  const showQuestion = questionItem !== null && !closedQuestionIds.has(questionItem.id);
  // The card's other work (a blocker, a recovery) goes inside the question card,
  // without the question again: one issue is one card (GRE-363, GRE-431).
  const hasOtherWork = !!current && !!questionItem && current.items.some((item) => item.id !== questionItem.id);

  // A question answered on a card with nothing else to do finishes the card.
  // On a merged card (question + recovery, say) the card stays for the rest.
  const finishQuestion = useCallback(
    (cardId: string, questionId: string, how: "answered" | "gone") => {
      const card = cardsRef.current.find((entry) => entry.id === cardId) ?? null;
      const onlyQuestion = !card || card.items.every((item) => item.id === questionId);
      if (onlyQuestion) {
        if (how === "answered") setQueue((state) => answerFocusItem(state, cardId));
        else {
          if (queueRef.current.currentId === cardId && isFocusPending(queueRef.current, cardId)) {
            toastHandledElsewhere(cardId);
          }
          setQueue((state) => markFocusGone(state, cardId));
        }
        return;
      }
      if (how === "answered") actedRef.current.add(cardId);
      setClosedQuestionIds((previous) => new Set(previous).add(questionId));
    },
    [toastHandledElsewhere],
  );

  const activeTabRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [queue.currentId]);

  return (
    <div className="space-y-4">
      {progress.total > 0 && (
        <div className="flex items-center gap-3 text-sm">
          <span className="shrink-0 font-semibold tabular-nums">
            {progress.answered} of {progress.total} done
          </span>
          <div
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="Decisions done"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.answered}
          >
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          <span className="shrink-0 font-semibold tabular-nums">{progress.remaining} left</span>
        </div>
      )}

      {tabs.length > 0 && (
        <div role="tablist" aria-label="Open decisions" className="scrollbar-auto-hide flex overflow-x-auto border-b border-border">
          {tabs.map((card) => {
            const pending = isFocusPending(queue, card.id);
            const active = card.id === queue.currentId;
            const skipped = queue.skipped.includes(card.id);
            return (
              <button
                key={card.id}
                ref={active ? activeTabRef : undefined}
                type="button"
                role="tab"
                aria-selected={active}
                disabled={!pending}
                onClick={() => setQueue((state) => selectFocusItem(state, card.id))}
                className={cn(
                  "-mb-px shrink-0 rounded-t-lg border border-transparent px-3 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                  active ? "border-border border-b-card bg-card" : "hover:bg-accent/60",
                  !pending && "text-muted-foreground line-through",
                )}
              >
                <span className="block font-semibold">{card.waiting?.name ?? card.task?.identifier ?? "Board"}</span>
                <span className={cn("block text-xs", pending && "text-muted-foreground")}>
                  {[card.task?.identifier, decisionKindLabel(card, card.kind)].filter(Boolean).join(" · ")}
                  {skipped && pending ? " · skipped" : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {current && showQuestion && questionItem ? (
        <FocusQuestionCard
          key={questionItem.id}
          item={questionItem}
          companyId={companyId}
          agentMap={agentMap}
          currentUserId={currentUserId}
          prefs={prefs}
          onPrefsChange={onPrefsChange}
          onAnswered={() => finishQuestion(current.id, questionItem.id, "answered")}
          onGone={() => finishQuestion(current.id, questionItem.id, "gone")}
          onSkip={handleSkip}
          onStep={handleStep}
        >
          {hasOtherWork && (
            <DecisionFeedCard
              key={current.id}
              card={current}
              companyId={companyId}
              assignableAgents={assignableAgents}
              agentMap={agentMap}
              currentUserId={currentUserId}
              hideInlineResolver
              embedded
              onActed={() => handleActed(current.id)}
            />
          )}
        </FocusQuestionCard>
      ) : current ? (
        <div className="mx-auto max-w-3xl space-y-3">
          <DecisionFeedCard
            key={current.id}
            card={current}
            companyId={companyId}
            assignableAgents={assignableAgents}
            agentMap={agentMap}
            currentUserId={currentUserId}
            onActed={() => handleActed(current.id)}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => handleStep(-1)}>
              Previous
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={handleSkip}>
              Skip for now
            </Button>
          </div>
        </div>
      ) : (
        <FocusCaughtUp
          skippedCount={queue.skipped.length}
          doneCount={progress.answered}
          onReviewSkipped={() => setQueue((state) => reviewSkippedFocus(state))}
          onShowList={onShowList}
        />
      )}
    </div>
  );
}

function FocusCaughtUp({
  skippedCount,
  doneCount,
  onReviewSkipped,
  onShowList,
}: {
  skippedCount: number;
  doneCount: number;
  onReviewSkipped: () => void;
  onShowList: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-16 text-center">
      <BrandCaughtUpMark />
      <p className="text-lg font-semibold">You are all caught up.</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {skippedCount > 0
          ? `${skippedCount} skipped ${skippedCount === 1 ? "card is" : "cards are"} still open.`
          : doneCount > 0
            ? `You handled ${doneCount} ${doneCount === 1 ? "card" : "cards"}.`
            : "Nothing needs you right now."}
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {skippedCount > 0 && <Button onClick={onReviewSkipped}>Review skipped</Button>}
        <Button variant="outline" onClick={onShowList}>
          Back to list
        </Button>
      </div>
    </div>
  );
}
