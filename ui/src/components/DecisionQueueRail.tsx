import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DecisionsFeed } from "@greatstone/shared";
import { Link } from "@/lib/router";
import { decisionQueuesApi } from "../api/decisionQueues";
import { useDecisionsFeed } from "../hooks/useDecisionsFeed";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

const RECENT_ACTIVITY_MS = 24 * 60 * 60 * 1000;

/** Href for a queue page under the current company prefix, or `/decisions` for All. */
export function decisionsHref(queueKey?: string | null): string {
  return queueKey ? `/decisions/queues/${encodeURIComponent(queueKey)}` : "/decisions";
}

/**
 * What still needs an answer in each queue: the open items on the decisions
 * feed, each counted once. Queue membership alone never shrinks, so the
 * queue's own item count kept saying 25 while its page was empty.
 */
export function openItemsByQueue(feed: Pick<DecisionsFeed, "cards">): Map<string, number> {
  const counted = new Set<string>();
  const counts = new Map<string, number>();
  for (const card of feed.cards) {
    for (const item of card.items) {
      if (counted.has(item.id)) continue;
      counted.add(item.id);
      for (const queue of item.queues ?? []) counts.set(queue.key, (counts.get(queue.key) ?? 0) + 1);
    }
  }
  return counts;
}

interface DecisionQueueRailProps {
  companyId: string;
  /** The active queue key, or null when the desk (All) is active. */
  activeQueueKey?: string | null;
}

/**
 * Queue quicklinks (PAP-16032 §4.1 / wireframe screen 1, annotation 1). The
 * chips are *this company's queues*, ordered by most-recently-updated (the
 * server already sorts them that way), not a hardcoded set of types. "All" is
 * the only fixed chip. A dot marks a queue with recent activity; the count is
 * what in the queue still needs an answer.
 */
export function DecisionQueueRail({ companyId, activeQueueKey = null }: DecisionQueueRailProps) {
  const { data: queues } = useQuery({
    queryKey: queryKeys.decisionQueues.list(companyId),
    queryFn: () => decisionQueuesApi.list(companyId),
    enabled: !!companyId,
  });
  const { data: feed } = useDecisionsFeed(companyId);
  const openCounts = useMemo(() => (feed ? openItemsByQueue(feed) : null), [feed]);

  // Nothing to show until at least one queue exists — the desk still works
  // without the rail, so render nothing rather than a lone "All" chip.
  if (!queues || queues.length === 0) {
    return null;
  }

  const now = Date.now();

  return (
    <nav className="flex flex-wrap items-center gap-1.5" aria-label="Decision queues" data-decision-queue-rail>
      <Chip href={decisionsHref(null)} active={activeQueueKey == null} label="All" />
      {queues.map((queue) => {
        const recent = now - new Date(queue.updatedAt).getTime() < RECENT_ACTIVITY_MS;
        return (
          <Chip
            key={queue.key}
            href={decisionsHref(queue.key)}
            active={activeQueueKey === queue.key}
            label={queue.title}
            count={openCounts?.get(queue.key)}
            recent={recent}
          />
        );
      })}
    </nav>
  );
}

function Chip({
  href,
  active,
  label,
  count,
  recent,
}: {
  href: string;
  active: boolean;
  label: string;
  count?: number;
  recent?: boolean;
}) {
  return (
    <Link
      to={href}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
      aria-current={active ? "page" : undefined}
    >
      {recent && (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-label="Recent activity" />
      )}
      <span className="truncate">{label}</span>
      {count != null && count > 0 && (
        <span className="tabular-nums text-(length:--text-nano) text-muted-foreground">{count}</span>
      )}
    </Link>
  );
}
