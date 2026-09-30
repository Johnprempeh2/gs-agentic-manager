import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RotateCcw } from "lucide-react";
import type { Issue } from "@greatstone/shared";
import { Link } from "@/lib/router";
import { decisionsFeedApi } from "../../api/decisionsFeed";
import { queryKeys } from "../../lib/queryKeys";
import { Button } from "../ui/button";

export function tabledReturnLabel(issue: Pick<Issue, "tabledUntil">): string {
  if (!issue.tabledUntil) return "Until you bring it back";
  return `Comes back ${new Date(issue.tabledUntil).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  })}`;
}

export function useTabledIssues(companyId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.tabledIssues(companyId!),
    queryFn: () => decisionsFeedApi.listTabled(companyId!),
    enabled: !!companyId && enabled,
  });
}

/** Tasks set aside with "Not now", soonest return first, each with "Bring back". */
export function TabledList({ companyId, issues }: { companyId: string; issues: Issue[] }) {
  if (issues.length === 0) {
    return <p className="text-xs text-muted-foreground">Nothing is set aside.</p>;
  }
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-card">
      {issues.map((issue) => (
        <TabledRow key={issue.id} companyId={companyId} issue={issue} />
      ))}
    </ul>
  );
}

function TabledRow({ companyId, issue }: { companyId: string; issue: Issue }) {
  const queryClient = useQueryClient();
  const bringBack = useMutation({
    mutationFn: () => decisionsFeedApi.bringBack(issue.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
      queryClient.invalidateQueries({ queryKey: ["issues", "detail"] });
    },
  });
  const label = issue.identifier ?? issue.id.slice(0, 8);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
      <div className="min-w-0">
        <Link to={`/issues/${issue.identifier ?? issue.id}`} className="text-sm font-medium hover:underline">
          <span className="font-mono text-xs text-muted-foreground">{label}</span> {issue.title}
        </Link>
        <p className="text-xs text-muted-foreground">{tabledReturnLabel(issue)}</p>
        {bringBack.error ? (
          <p className="text-xs text-destructive" role="alert">
            {(bringBack.error as Error).message}
          </p>
        ) : null}
      </div>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={bringBack.isPending}
        onClick={() => bringBack.mutate()}
        aria-label={`Bring back ${label}`}
      >
        {bringBack.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />}
        Bring back
      </Button>
    </li>
  );
}
