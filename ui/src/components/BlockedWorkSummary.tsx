import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import type { BlockedWorkIssueRef, BlockedWorkItem, BlockedWorkRootCause } from "@greatstone/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { blockedWorkApi } from "../api/blockedWork";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { blockedWorkOwnerLabel, formatWaitingFor, pluralTasks } from "../lib/blockedWork";
import { cn } from "../lib/utils";

const ROOTS_SHOWN_AT_FIRST = 5;

interface BlockedWorkSummaryProps {
  companyId: string;
  agentNameById: ReadonlyMap<string, string>;
  userLabelById?: ReadonlyMap<string, string>;
  currentUserId: string | null;
}

/**
 * The top of the Blocked tab: how much work is waiting, the few tasks holding
 * most of it up, who has to act on each, and blocked tasks that can already move.
 */
export function BlockedWorkSummary({ companyId, agentNameById, userLabelById, currentUserId }: BlockedWorkSummaryProps) {
  const [showAllRoots, setShowAllRoots] = useState(false);
  const { data, error, isLoading } = useQuery({
    queryKey: queryKeys.issues.blockedWork(companyId),
    queryFn: () => blockedWorkApi.overview(companyId),
  });

  const issueById = useMemo(() => {
    const map = new Map<string, BlockedWorkIssueRef>();
    for (const item of data?.items ?? []) map.set(item.issue.id, item.issue);
    return map;
  }, [data]);
  const tidyItems = useMemo(() => (data?.items ?? []).filter((item) => item.tidyReason), [data]);

  if (isLoading) return null;
  if (error) {
    return (
      <p role="alert" className="px-3 text-sm text-destructive sm:px-4" data-testid="blocked-work-error">
        Couldn't load the blocked work summary. {error instanceof Error ? error.message : ""}
      </p>
    );
  }
  if (!data || data.totalBlocked === 0) return null;

  const names = { agentNameById, userLabelById, currentUserId };
  const heldByRoots = new Set(data.rootCauses.flatMap((root) => root.heldIssueIds)).size;
  const roots = showAllRoots ? data.rootCauses : data.rootCauses.slice(0, ROOTS_SHOWN_AT_FIRST);
  const longest = formatWaitingFor(data.oldestWaitingSince);

  return (
    <Card data-testid="blocked-work-summary" className="mx-2 mb-4 gap-4 border-border/70 bg-card/60 p-4 sm:mx-0">
      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground" data-testid="blocked-work-headline">
          {pluralTasks(data.totalBlocked)} {data.totalBlocked === 1 ? "is" : "are"} blocked.
          {data.rootCauses.length > 0
            ? ` ${pluralTasks(data.rootCauses.length)} ${data.rootCauses.length === 1 ? "is" : "are"} holding up ${pluralTasks(heldByRoots)}.`
            : null}
        </p>
        <p className="text-xs text-muted-foreground">
          {longest ? `The longest has waited ${longest}. ` : null}
          Clear a task below and everything waiting on it is picked up automatically.
        </p>
      </div>

      {roots.length > 0 ? (
        <section aria-label="What is holding work up" className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What is holding work up</h3>
          <ul className="space-y-2">
            {roots.map((root) => (
              <RootCauseRow
                key={root.issue.id}
                root={root}
                issueById={issueById}
                ownerLabel={blockedWorkOwnerLabel(root.owner, names)}
              />
            ))}
          </ul>
          {data.rootCauses.length > ROOTS_SHOWN_AT_FIRST ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowAllRoots((value) => !value)}>
              {showAllRoots ? "Show fewer" : `Show all ${data.rootCauses.length}`}
            </Button>
          ) : null}
        </section>
      ) : null}

      {tidyItems.length > 0 ? (
        <section aria-label="Ready to move on" className="space-y-2" data-testid="blocked-work-tidy">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Ready to move on</h3>
          <p className="text-xs text-muted-foreground">
            These still say blocked, but what they were waiting on is already finished or cancelled. Open each one to move it on.
          </p>
          <ul className="space-y-1">
            {tidyItems.map((item) => (
              <TidyRow key={item.issue.id} item={item} ownerLabel={blockedWorkOwnerLabel(item.owner, names)} />
            ))}
          </ul>
        </section>
      ) : null}

      {data.truncated ? (
        <p className="text-xs text-muted-foreground">Showing the first {data.totalBlocked} blocked tasks.</p>
      ) : null}
    </Card>
  );
}

function IssueLink({ issue, className }: { issue: BlockedWorkIssueRef; className?: string }) {
  return (
    <Link
      to={createIssueDetailPath(issue.identifier ?? issue.id)}
      className={cn("min-w-0 text-foreground no-underline hover:underline", className)}
    >
      {issue.identifier ? <span className="mr-1.5 font-mono text-xs text-muted-foreground">{issue.identifier}</span> : null}
      <span>{issue.title}</span>
    </Link>
  );
}

function RootCauseRow({
  root,
  issueById,
  ownerLabel,
}: {
  root: BlockedWorkRootCause;
  issueById: ReadonlyMap<string, BlockedWorkIssueRef>;
  ownerLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const waited = formatWaitingFor(root.oldestWaitingSince);
  const held = root.heldIssueIds.map((id) => issueById.get(id)).filter((issue): issue is BlockedWorkIssueRef => Boolean(issue));

  return (
    <li className="rounded-lg border border-border/60 bg-background/40 p-3" data-testid="blocked-work-root">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <IssueLink issue={root.issue} className="text-sm font-medium" />
        <span className="shrink-0 text-xs font-medium text-foreground">Holding up {pluralTasks(root.heldIssueIds.length)}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        <span className={cn(root.owner.type === "nobody" ? "text-destructive" : "text-foreground")}>
          {root.owner.type === "nobody" ? "Nobody owns this yet" : `${ownerLabel} needs to act`}
        </span>
        {waited ? ` · work has waited ${waited}` : null}
        {root.action ? ` · ${root.action}` : null}
      </p>
      {held.length > 0 ? (
        <div className="mt-2">
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} aria-hidden="true" />
            {open ? "Hide waiting tasks" : "See waiting tasks"}
          </button>
          {open ? (
            <ul className="mt-1 space-y-1 pl-5 text-xs">
              {held.map((issue) => (
                <li key={issue.id}>
                  <IssueLink issue={issue} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function TidyRow({ item, ownerLabel }: { item: BlockedWorkItem; ownerLabel: string }) {
  return (
    <li className="flex flex-col gap-0.5 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3" data-testid="blocked-work-tidy-row">
      <IssueLink issue={item.issue} />
      <span className="shrink-0 text-xs text-muted-foreground">
        {item.tidyReason === "waiting_on_finished_work" ? "Its blockers are done" : "Its blockers were cancelled"} · {ownerLabel}
      </span>
    </li>
  );
}
