import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { GoalWithProgress } from "@greatstone/shared";
import { goalsApi } from "../api/goals";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { buildScoreboard } from "../lib/goal-journey";
import { relativeTime } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { GoalHealthLegend } from "../components/goals/GoalHealth";
import { GoalScoreboardView, GoalsEmptyState, type AgentsById } from "../components/goals/GoalScoreboard";
import { Button } from "@/components/ui/button";
import { Target, Plus } from "lucide-react";

/** "3 active goals · Everest checked in 2h ago" */
export function scoreboardLede(goals: readonly GoalWithProgress[], shown: number, agentsById: AgentsById): string {
  const parts = [`${shown} ${shown === 1 ? "goal" : "goals"}`];
  let latest: GoalWithProgress["latestCheckIn"] = null;
  for (const goal of goals) {
    const checkIn = goal.latestCheckIn;
    if (checkIn && (!latest || new Date(checkIn.createdAt) > new Date(latest.createdAt))) latest = checkIn;
  }
  if (latest) {
    const who = latest.authorAgentId ? agentsById.get(latest.authorAgentId)?.name : null;
    parts.push(`${who ?? "Last check-in"}${who ? " checked in" : ""} ${relativeTime(latest.createdAt)}`);
  }
  return parts.join(" · ");
}

export function Goals() {
  const { selectedCompanyId } = useCompany();
  const { openNewGoal } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [showAchieved, setShowAchieved] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Goals" }]);
  }, [setBreadcrumbs]);

  const { data: goals, isLoading, error } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentsById: AgentsById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent])),
    [agents],
  );
  const entries = useMemo(
    () => buildScoreboard(goals ?? [], { includeAchieved: showAchieved }),
    [goals, showAchieved],
  );
  const hasAchieved = (goals ?? []).some((goal) => goal.status === "achieved");

  if (!selectedCompanyId) {
    return <EmptyState icon={Target} message="Select an organization to view goals." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const shownCount = entries.reduce((sum, entry) => sum + 1 + entry.subGoals.length, 0);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Goals</p>
          <h1 className="text-xl font-bold">How far we are from each goal</h1>
          {goals && goals.length > 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">{scoreboardLede(goals, shownCount, agentsById)}</p>
          ) : null}
        </div>
        {goals && goals.length > 0 ? (
          <div className="flex items-center gap-2">
            {hasAchieved ? (
              <Button
                size="sm"
                variant="outline"
                aria-pressed={showAchieved}
                onClick={() => setShowAchieved((value) => !value)}
              >
                {showAchieved ? "Hide achieved" : "Show achieved"}
              </Button>
            ) : null}
            <Button size="sm" onClick={() => openNewGoal()}>
              <Plus className="size-3.5" />
              New goal
            </Button>
          </div>
        ) : null}
      </header>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {goals && entries.length === 0 ? (
        !hasAchieved ? (
          <GoalsEmptyState onNewGoal={() => openNewGoal()} />
        ) : (
          <p className="rounded-lg border border-dashed border-border px-6 py-8 text-center text-sm text-muted-foreground">
            Every goal is achieved. Use “Show achieved” to see them, or set a new goal.
          </p>
        )
      ) : null}

      {entries.length > 0 ? (
        <>
          <GoalHealthLegend />
          <GoalScoreboardView entries={entries} agentsById={agentsById} />
        </>
      ) : null}
    </div>
  );
}
