import { useQuery } from "@tanstack/react-query";
import { Eye } from "lucide-react";
import { Link } from "@/lib/router";
import { decisionsFeedApi } from "../../api/decisionsFeed";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { DecisionFeedCard } from "../decisions-feed/DecisionFeedCard";

const OPEN_STATUSES = "todo,in_progress,in_review,blocked";

/**
 * "View Ben That's Desk" (Ben's access, Nov 2026): the owner reads a member's
 * Desk as that member sees it. Every card is theirs, so it is decided only
 * through Take over, which the server records on their behalf.
 */
export function MemberDeskView({
  companyId,
  member,
  currentUserId,
}: {
  companyId: string;
  member: { userId: string; name: string };
  currentUserId: string | null;
}) {
  const feed = useQuery({
    queryKey: queryKeys.decisionsFeed.memberFeed(companyId, member.userId),
    queryFn: () => decisionsFeedApi.getForMember(companyId, member.userId),
  });
  const tasks = useQuery({
    queryKey: ["issues", companyId, "member-desk", member.userId],
    queryFn: () => issuesApi.list(companyId, { assigneeUserId: member.userId, status: OPEN_STATUSES, excludeParked: true }),
  });
  const cards = feed.data?.cards ?? [];

  return (
    <div className="space-y-6" data-member-desk={member.userId}>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-status-info/40 bg-status-info-soft px-4 py-3 text-sm text-status-info-foreground">
        <span className="flex items-center gap-2 font-medium">
          <Eye className="size-4 shrink-0" aria-hidden />
          You are viewing {member.name}'s Desk. Anything you decide here is taken over on their behalf.
        </span>
        <Link to="/desk" className="font-medium underline underline-offset-2">
          Back to my Desk
        </Link>
      </div>

      <section className="space-y-3" aria-labelledby="member-desk-decisions">
        <h2 id="member-desk-decisions" className="text-base font-semibold">
          Waiting on {member.name}
        </h2>
        {feed.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {feed.error ? (
          <p className="text-sm text-destructive" role="alert">{(feed.error as Error).message}</p>
        ) : null}
        {!feed.isLoading && cards.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing is waiting on {member.name}.</p>
        ) : null}
        <div className="space-y-4">
          {cards.map((card) => (
            <DecisionFeedCard
              key={card.id}
              card={card}
              companyId={companyId}
              assignableAgents={feed.data?.assignableAgents ?? []}
              currentUserId={currentUserId}
              viewingMember={member}
              onActed={() => void feed.refetch()}
            />
          ))}
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="member-desk-tasks">
        <h2 id="member-desk-tasks" className="text-base font-semibold">
          {member.name}'s open tasks
        </h2>
        {tasks.data && tasks.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open tasks.</p>
        ) : null}
        <ul className="divide-y divide-border rounded-lg border border-border">
          {(tasks.data ?? []).map((issue) => (
            <li key={issue.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <Link to={`/issues/${issue.identifier ?? issue.id}`} className="min-w-0 truncate hover:underline">
                {issue.identifier ? <span className="mr-2 text-muted-foreground">{issue.identifier}</span> : null}
                {issue.title}
              </Link>
              <span className="shrink-0 text-xs text-muted-foreground">{issue.status.replace("_", " ")}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
