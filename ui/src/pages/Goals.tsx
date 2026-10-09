import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GoalWithProgress } from "@greatstone/shared";
import { goalsApi } from "../api/goals";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { buildScoreboard } from "../lib/goal-journey";
import { buildStrategyCascade, hasStrategyGoals } from "../lib/goal-cascade";
import { buildCompanyUserProfileMap } from "../lib/company-members";
import { relativeTime } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { GoalHealthLegend } from "../components/goals/GoalHealth";
import { GoalScoreboardView, GoalsEmptyState, type AgentsById } from "../components/goals/GoalScoreboard";
import { StrategyCascadeView } from "../components/goals/StrategyCascade";
import { Button } from "@/components/ui/button";
import { Target, Plus, Network } from "lucide-react";
import { ErrorState } from "../components/ErrorState";

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
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [showAchieved, setShowAchieved] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Goals" }]);
  }, [setBreadcrumbs]);

  const { data: goals, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: userDirectory } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const createStrategicPlan = useMutation({
    mutationFn: () => goalsApi.createStrategicPlan(selectedCompanyId!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(selectedCompanyId!) });
      pushToast({ title: "Strategic plan added", body: "Rename each layer and set its owner.", tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Could not add the strategic plan", body: err.message, tone: "error" });
    },
  });

  const agentsById: AgentsById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent])),
    [agents],
  );
  const usersById = useMemo(() => buildCompanyUserProfileMap(userDirectory?.users), [userDirectory?.users]);
  const hasStrategy = hasStrategyGoals(goals ?? []);
  const cascade = useMemo(() => buildStrategyCascade(goals ?? []), [goals]);
  // Goals with a kind live in the strategic plan; the scoreboard keeps plain goals.
  const plainGoals = useMemo(() => (goals ?? []).filter((goal) => goal.kind == null), [goals]);
  const entries = useMemo(
    () => buildScoreboard(plainGoals, { includeAchieved: showAchieved }),
    [plainGoals, showAchieved],
  );
  const hasAchieved = plainGoals.some((goal) => goal.status === "achieved");

  if (!selectedCompanyId) {
    return <EmptyState icon={Target} message="Select an organization to view goals." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (error && !goals) {
    return <ErrorState error={error} onRetry={() => void refetch()} />;
  }

  const shownCount = entries.reduce((sum, entry) => sum + 1 + entry.subGoals.length, 0)
    + cascade.vision.length + cascade.values.length + cascade.csfs.length + cascade.strategy.length;

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
        {goals ? (
          <div className="flex flex-wrap items-center gap-2">
            {!hasStrategy ? (
              <Button
                size="sm"
                variant="outline"
                disabled={createStrategicPlan.isPending}
                onClick={() => createStrategicPlan.mutate()}
              >
                <Network className="size-3.5" />
                {createStrategicPlan.isPending ? "Adding…" : "Strategic plan"}
              </Button>
            ) : null}
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
            {goals.length > 0 ? (
              <Button size="sm" onClick={() => openNewGoal()}>
                <Plus className="size-3.5" />
                New goal
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>

      {error && <ErrorState error={error} onRetry={() => void refetch()} compact />}

      {hasStrategy ? (
        <StrategyCascadeView cascade={cascade} agentsById={agentsById} usersById={usersById} />
      ) : null}

      {goals && entries.length === 0 && !hasStrategy ? (
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
          {hasStrategy ? <h2 className="pt-2 text-base font-semibold">Other goals</h2> : null}
          <GoalHealthLegend />
          <GoalScoreboardView entries={entries} agentsById={agentsById} usersById={usersById} />
        </>
      ) : null}
    </div>
  );
}
