import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Clock, Loader2, RotateCcw } from "lucide-react";
import type { Issue } from "@greatstone/shared";
import { decisionsFeedApi } from "../../api/decisionsFeed";
import { queryKeys } from "../../lib/queryKeys";
import { Button } from "../ui/button";
import { tabledReturnLabel } from "./TabledList";

/** Task page banner while a task is set aside with "Not now" (GRE-264). */
export function TabledBanner({ issue }: { issue: Issue }) {
  const queryClient = useQueryClient();
  const bringBack = useMutation({
    mutationFn: () => decisionsFeedApi.bringBack(issue.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attention(issue.companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(issue.companyId) });
      queryClient.invalidateQueries({ queryKey: ["issues", "detail"] });
    },
  });
  if (!issue.tabledAt) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
    >
      <span className="flex items-center gap-2">
        <Clock className="size-4 text-muted-foreground" />
        <span>
          <span className="font-medium">Set aside (Not now).</span>{" "}
          <span className="text-muted-foreground">{tabledReturnLabel(issue)}. No agent works on it until then.</span>
        </span>
      </span>
      <div className="flex items-center gap-2">
        {bringBack.error ? (
          <span className="text-xs text-destructive" role="alert">
            {(bringBack.error as Error).message}
          </span>
        ) : null}
        <Button type="button" size="xs" variant="outline" disabled={bringBack.isPending} onClick={() => bringBack.mutate()}>
          {bringBack.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          Bring back
        </Button>
      </div>
    </div>
  );
}
