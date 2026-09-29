import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import type { Agent, AttentionItem } from "@greatstone/shared";
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
import { focusItemKind, focusKindLabel } from "../../lib/focus-items";
import type { FocusPrefs } from "../../lib/focus-prefs";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { FocusQuestionCard } from "./FocusQuestionCard";

export interface DecisionsFocusViewProps {
  /** Open Focus-eligible feed rows, in queue order. */
  items: AttentionItem[];
  companyId: string;
  agentMap: Map<string, Agent>;
  currentUserId: string | null;
  prefs: FocusPrefs;
  onPrefsChange: (next: FocusPrefs) => void;
  onShowList: () => void;
}

/**
 * Decisions Focus mode (GRE-55): one open agent question at a time, a tab per
 * question, progress, and a caught-up screen. Answers go to the original card
 * on the original task through the same mutations the List view uses.
 */
export function DecisionsFocusView({
  items,
  companyId,
  agentMap,
  currentUserId,
  prefs,
  onPrefsChange,
  onShowList,
}: DecisionsFocusViewProps) {
  const { pushToast } = useToastActions();
  // Restore this browser session's Focus run, so Open task → Back keeps the count.
  const [restored] = useState(() => loadFocusSession<AttentionItem>(companyId));
  // Keep every row this session has shown, so answered tabs stay (crossed out)
  // after the feed drops them.
  const [seenItems, setSeenItems] = useState<Map<string, AttentionItem>>(
    () => new Map((restored?.items ?? []).map((item) => [item.id, item])),
  );
  const [queue, setQueue] = useState<FocusQueueState>(() => restored?.queue ?? initialFocusQueue);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const pushToastRef = useRef(pushToast);
  pushToastRef.current = pushToast;

  useEffect(() => {
    saveFocusSession(companyId, {
      queue,
      items: queue.order.map((id) => seenItems.get(id)).filter(Boolean) as AttentionItem[],
    });
  }, [companyId, queue, seenItems]);

  // Both paths that find the open question closed (feed refetch, card refetch)
  // land here; the toast shows once per question.
  const toastedGoneRef = useRef(new Set<string>());
  const toastAnsweredElsewhere = useCallback((id: string) => {
    if (toastedGoneRef.current.has(id)) return;
    toastedGoneRef.current.add(id);
    pushToastRef.current({
      id: `focus-gone-${id}`,
      title: "Answered elsewhere",
      body: "That question was closed on another screen, so Focus moved on.",
      tone: "info",
      ttlMs: 5000,
    });
  }, []);

  const openIdsKey = items.map((item) => item.id).join("|");
  useEffect(() => {
    setSeenItems((previous) => {
      const next = new Map(previous);
      for (const item of items) next.set(item.id, item);
      return next;
    });
    const before = queueRef.current;
    const after = syncFocusQueue(before, items.map((item) => item.id));
    if (before.currentId && before.currentId !== after.currentId && after.gone.includes(before.currentId)) {
      toastAnsweredElsewhere(before.currentId);
    }
    setQueue(after);
    // `openIdsKey` stands in for `items`: rows re-create on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openIdsKey]);

  const handleAnswered = useCallback((id: string) => setQueue((state) => answerFocusItem(state, id)), []);
  const handleGone = useCallback(
    (id: string) => {
      const before = queueRef.current;
      if (!isFocusPending(before, id)) return;
      if (before.currentId === id) toastAnsweredElsewhere(id);
      setQueue((state) => markFocusGone(state, id));
    },
    [toastAnsweredElsewhere],
  );
  const handleSkip = useCallback(() => setQueue((state) => skipFocusItem(state)), []);
  const handleStep = useCallback((direction: 1 | -1) => setQueue((state) => stepFocus(state, direction)), []);

  const progress = focusProgress(queue);
  const percent = progress.total > 0 ? Math.round((progress.answered / progress.total) * 100) : 0;
  const tabs = useMemo(
    () => queue.order.filter((id) => !queue.gone.includes(id)).map((id) => seenItems.get(id)).filter(Boolean) as AttentionItem[],
    [queue.gone, queue.order, seenItems],
  );
  const current = queue.currentId ? seenItems.get(queue.currentId) ?? null : null;

  const activeTabRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [queue.currentId]);

  return (
    <div className="space-y-4">
      {progress.total > 0 && (
        <div className="flex items-center gap-3 text-sm">
          <span className="shrink-0 font-semibold tabular-nums">
            {progress.answered} of {progress.total} answered
          </span>
          <div
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="Questions answered"
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
        <div role="tablist" aria-label="Open questions" className="scrollbar-auto-hide flex overflow-x-auto border-b border-border">
          {tabs.map((item) => {
            const pending = isFocusPending(queue, item.id);
            const active = item.id === queue.currentId;
            const agentId = item.subject.metadata?.createdByAgentId;
            const agentName =
              (typeof agentId === "string" ? agentMap.get(agentId)?.name : null) ?? item.originAgentName ?? "Agent";
            const skipped = queue.skipped.includes(item.id);
            return (
              <button
                key={item.id}
                ref={active ? activeTabRef : undefined}
                type="button"
                role="tab"
                aria-selected={active}
                disabled={!pending}
                onClick={() => setQueue((state) => selectFocusItem(state, item.id))}
                className={cn(
                  "-mb-px shrink-0 rounded-t-lg border border-transparent px-3 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                  active ? "border-border border-b-card bg-card" : "hover:bg-accent/60",
                  !pending && "text-muted-foreground line-through",
                )}
              >
                <span className="block font-semibold">{agentName}</span>
                <span className={cn("block text-xs", pending && "text-muted-foreground")}>
                  {[item.relatedIssue?.identifier, focusKindLabel(focusItemKind(item))].filter(Boolean).join(" · ")}
                  {skipped && pending ? " · skipped" : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {current ? (
        <FocusQuestionCard
          key={current.id}
          item={current}
          companyId={companyId}
          agentMap={agentMap}
          currentUserId={currentUserId}
          prefs={prefs}
          onPrefsChange={onPrefsChange}
          onAnswered={handleAnswered}
          onGone={handleGone}
          onSkip={handleSkip}
          onStep={handleStep}
        />
      ) : (
        <FocusCaughtUp
          skippedCount={queue.skipped.length}
          answeredCount={progress.answered}
          onReviewSkipped={() => setQueue((state) => reviewSkippedFocus(state))}
          onShowList={onShowList}
        />
      )}
    </div>
  );
}

function FocusCaughtUp({
  skippedCount,
  answeredCount,
  onReviewSkipped,
  onShowList,
}: {
  skippedCount: number;
  answeredCount: number;
  onReviewSkipped: () => void;
  onShowList: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-16 text-center">
      <div className="mb-4 rounded-full bg-accent p-4">
        <CheckCircle2 className="size-10 text-primary" />
      </div>
      <p className="text-lg font-semibold">You are all caught up.</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {skippedCount > 0
          ? `${skippedCount} skipped ${skippedCount === 1 ? "question is" : "questions are"} still open.`
          : answeredCount > 0
            ? `You answered ${answeredCount} ${answeredCount === 1 ? "question" : "questions"}.`
            : "No agent questions are waiting for you."}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">Approvals and other decisions stay in List.</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {skippedCount > 0 && <Button onClick={onReviewSkipped}>Review skipped</Button>}
        <Button variant="outline" onClick={onShowList}>
          Back to list
        </Button>
      </div>
    </div>
  );
}
