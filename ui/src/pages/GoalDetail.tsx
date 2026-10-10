import { useEffect, useMemo, useState } from "react";
import { useLocation, useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { goalsApi } from "../api/goals";
import { projectsApi } from "../api/projects";
import { assetsApi } from "../api/assets";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { buildCompanyUserProfileMap } from "../lib/company-members";
import { GoalProperties } from "../components/GoalProperties";
import { GoalTree } from "../components/GoalTree";
import { StatusBadge } from "../components/StatusBadge";
import { InlineEditor } from "../components/InlineEditor";
import { EntityRow } from "../components/EntityRow";
import { PageSkeleton } from "../components/PageSkeleton";
import { cn, projectUrl, relativeTime } from "../lib/utils";
import {
  daysToTarget,
  formatTargetDate,
  GOAL_BLOCKERS_ANCHOR,
  goalHealth,
  remainingLabel,
} from "../lib/goal-journey";
import { GoalHealthPill, GoalPercent, GoalProgressRing } from "../components/goals/GoalHealth";
import { GoalJourneyMap } from "../components/goals/GoalJourneyMap";
import { GoalCheckIns } from "../components/goals/GoalCheckIns";
import { GoalBlockerList } from "../components/goals/GoalBlockers";
import { GoalOwnerPicker } from "../components/goals/GoalOwnerPicker";
import { goalOwnerName } from "../components/goals/GoalOwner";
import {
  KpiReadingsList,
  KpiStatusPill,
  RecordKpiReadingForm,
  kpiStatusSentence,
  rollupSummary,
  type NewKpiReading,
} from "../components/goals/KpiReadings";
import { GoalWhyRequests } from "../components/strategy-board/GoalWhyRequests";
import { useStrategyBoardEnabled } from "../components/StrategyBoardExperimentalGate";
import { strategyBoardApi } from "../api/strategyBoard";
import { InitiativeBudgetForm, KpiPlanForm } from "../components/goals/KpiPlanForm";
import { PackKpiDraftsDialog } from "../components/goals/PackKpiDraftsDialog";
import { KpiDraftNotice } from "../components/goals/KpiDraftNotice";
import { GOAL_KIND_LABELS, GOAL_KIND_PARENTS } from "@greatstone/shared";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FileText, Plus, SlidersHorizontal } from "lucide-react";
import { ErrorState } from "../components/ErrorState";

interface GoalPropertiesToggleButtonProps {
  panelVisible: boolean;
  onShowProperties: () => void;
}

export function GoalPropertiesToggleButton({
  panelVisible,
  onShowProperties,
}: GoalPropertiesToggleButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={cn(
        "hidden md:inline-flex shrink-0 transition-opacity duration-200",
        panelVisible ? "opacity-0 pointer-events-none w-0 overflow-hidden" : "opacity-100",
      )}
      onClick={onShowProperties}
      title="Show properties"
    >
      <SlidersHorizontal className="h-4 w-4" />
    </Button>
  );
}

export function GoalDetail() {
  const { goalId } = useParams<{ goalId: string }>();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { openNewGoal } = useDialogActions();
  const { openPanel, closePanel, panelVisible, setPanelVisible } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [packDialogOpen, setPackDialogOpen] = useState(false);

  const {
    data: goal,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: queryKeys.goals.detail(goalId!),
    queryFn: () => goalsApi.get(goalId!),
    enabled: !!goalId
  });
  const resolvedCompanyId = goal?.companyId ?? selectedCompanyId;

  const { data: allGoals } = useQuery({
    queryKey: queryKeys.goals.list(resolvedCompanyId!),
    queryFn: () => goalsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId
  });

  const { data: allProjects } = useQuery({
    queryKey: queryKeys.projects.list(resolvedCompanyId!, { includeArchived: true }),
    queryFn: () => projectsApi.list(resolvedCompanyId!, { includeArchived: true }),
    enabled: !!resolvedCompanyId
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(resolvedCompanyId!),
    queryFn: () => agentsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId
  });

  const { data: checkIns } = useQuery({
    queryKey: queryKeys.goals.checkIns(goalId!),
    queryFn: () => goalsApi.listCheckIns(goalId!),
    enabled: !!goalId
  });

  const isKpi = goal?.kind === "kpi";
  const { data: readings } = useQuery({
    queryKey: queryKeys.goals.readings(goalId!),
    queryFn: () => goalsApi.listReadings(goalId!),
    enabled: !!goalId && isKpi,
  });

  // GRE-1135: the board's "Why?" questions, while the board control panel is on.
  const { enabled: strategyBoardOn } = useStrategyBoardEnabled();
  const { data: boardSummary } = useQuery({
    queryKey: queryKeys.strategyBoard.summary(selectedCompanyId!),
    queryFn: () => strategyBoardApi.summary(selectedCompanyId!),
    enabled: strategyBoardOn && isKpi && !!selectedCompanyId,
  });

  const { data: userDirectory } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const usersById = useMemo(() => buildCompanyUserProfileMap(userDirectory?.users), [userDirectory?.users]);
  const people = useMemo(
    () => [...usersById.entries()].map(([id, profile]) => ({ id, ...profile })),
    [usersById],
  );

  const agentsById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent])),
    [agents]
  );

  useEffect(() => {
    if (!goal?.companyId || goal.companyId === selectedCompanyId) return;
    setSelectedCompanyId(goal.companyId, { source: "route_sync" });
  }, [goal?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const updateGoal = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      goalsApi.update(goalId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.goals.detail(goalId!)
      });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.goals.list(resolvedCompanyId)
        });
      }
    },
    // e.g. 403 when an Exco member edits the vision, 422 for a wrong parent kind.
    onError: (err: Error) => {
      pushToast({ title: "Goal not saved", body: err.message, tone: "error" });
    }
  });

  const recordReading = useMutation({
    mutationFn: (reading: NewKpiReading) => goalsApi.createReading(goalId!, reading),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.goals.readings(goalId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.goals.detail(goalId!) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(resolvedCompanyId) });
      }
    },
    onError: (err: Error) => {
      pushToast({ title: "Reading not saved", body: err.message, tone: "error" });
    },
  });

  const uploadImage = useMutation({
    mutationFn: async (file: File) => {
      if (!resolvedCompanyId) throw new Error("No organization selected");
      return assetsApi.uploadImage(
        resolvedCompanyId,
        file,
        `goals/${goalId ?? "draft"}`
      );
    }
  });

  const childGoals = (allGoals ?? []).filter((g) => g.parentId === goalId);
  const linkedProjects = (allProjects ?? []).filter((p) => {
    if (!goalId) return false;
    if (p.goalIds.includes(goalId)) return true;
    if (p.goals.some((goalRef) => goalRef.id === goalId)) return true;
    return p.goalId === goalId;
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Goals", href: "/goals" },
      { label: goal?.title ?? goalId ?? "Goal" }
    ]);
  }, [setBreadcrumbs, goal, goalId]);

  useEffect(() => {
    if (goal) {
      openPanel(
        <GoalProperties
          goal={goal}
          onUpdate={(data) => updateGoal.mutate(data)}
        />
      );
    }
    return () => closePanel();
  }, [goal]); // eslint-disable-line react-hooks/exhaustive-deps

  // "+N more blockers" on a goal card lands here; scroll once the list renders.
  const { hash } = useLocation();
  const hasBlockers = (goal?.blockers.length ?? 0) > 0;
  useEffect(() => {
    if (hash !== `#${GOAL_BLOCKERS_ANCHOR}` || !hasBlockers) return;
    document.getElementById(GOAL_BLOCKERS_ANCHOR)?.scrollIntoView({ block: "start" });
  }, [hash, hasBlockers]);

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!goal) return null;

  const health = goalHealth(goal);
  const ownerName = goalOwnerName(goal, agentsById, usersById);
  const left = remainingLabel(goal);
  const target = formatTargetDate(goal.targetDate);
  const days = daysToTarget(goal.targetDate);
  const newestCheckIn = checkIns?.[0] ?? goal.latestCheckIn;
  const rollup = rollupSummary(goal.ragRollup);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase text-muted-foreground">
            {goal.kind ? GOAL_KIND_LABELS[goal.kind] : goal.level}
          </span>
          <StatusBadge status={goal.status} />
          {/* On a KPI the reading against plan is the status, not task progress. */}
          {goal.kind === "kpi" ? (
            <KpiStatusPill status={goal.kpiStatus?.status ?? null} />
          ) : (
            <GoalHealthPill health={health} />
          )}
          {goal.kind !== "kpi" && rollup ? (
            <span className="flex items-center gap-1.5" data-testid="goal-rag-rollup">
              <KpiStatusPill status={goal.ragRollup.status} />
              <span className="text-xs text-muted-foreground">{rollup}</span>
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <GoalOwnerPicker
              agents={agents ?? []}
              people={people}
              ownerAgentId={goal.ownerAgentId}
              ownerUserId={goal.ownerUserId}
              onChange={(change) => updateGoal.mutate(change)}
              disabled={updateGoal.isPending}
            />
            <GoalPropertiesToggleButton
              panelVisible={panelVisible}
              onShowProperties={() => setPanelVisible(true)}
            />
          </div>
        </div>

        <InlineEditor
          value={goal.title}
          onSave={(title) => updateGoal.mutate({ title })}
          as="h2"
          className="text-xl font-bold"
        />

        <InlineEditor
          value={goal.description ?? ""}
          onSave={(description) => updateGoal.mutate({ description })}
          as="p"
          className="text-sm text-muted-foreground"
          placeholder="Add a description..."
          multiline
          imageUploadHandler={async (file) => {
            const asset = await uploadImage.mutateAsync(file);
            return asset.contentPath;
          }}
        />
      </div>

      <section
        className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4"
        aria-label="Goal at a glance"
        data-testid="goal-kpis"
      >
        <div className="flex items-center gap-4 rounded-lg border border-border bg-card p-4 col-span-2 lg:col-span-1">
          <GoalProgressRing percent={goal.progress.percent} health={health} />
          <div className="min-w-0">
            <GoalPercent percent={goal.progress.percent} />
            <p className="mt-1 text-xs text-muted-foreground">{ownerName ?? "No owner"}</p>
          </div>
        </div>
        <GoalKpi label="What is left" value={left ?? "No linked tasks yet"} />
        <GoalKpi label="Target date" value={target ?? "No target date"} hint={daysHint(days)} />
        <GoalKpi
          label="Last check-in"
          value={newestCheckIn ? relativeTime(newestCheckIn.createdAt) : "None yet"}
        />
      </section>

      {goal.kind === "kpi" && (goal.status === "draft" || goal.benchmarkNote || goal.sourceIssueId) ? (
        <KpiDraftNotice goal={goal} onAccept={() => updateGoal.mutate({ status: "active" })} pending={updateGoal.isPending} />
      ) : null}

      {goal.kind === "kpi" ? (
        <section className="space-y-3" aria-labelledby="kpi-readings-heading">
          <h3 id="kpi-readings-heading" className="text-sm font-semibold">
            Readings
          </h3>
          {goal.kpiStatus ? (
            <p className="text-sm text-muted-foreground" data-testid="kpi-status-sentence">
              {kpiStatusSentence(goal.kpiStatus, goal.unit)}
            </p>
          ) : null}
          <div className="grid items-start gap-4 lg:grid-cols-(--gtc-66)">
            <KpiReadingsList
              readings={readings ?? (goal.latestReading ? [goal.latestReading] : [])}
              unit={goal.unit}
              names={{ agents: agentsById, users: usersById }}
            />
            <RecordKpiReadingForm onSubmit={(reading) => recordReading.mutate(reading)} pending={recordReading.isPending} />
          </div>
          <h3 className="pt-2 text-sm font-semibold">Plan</h3>
          <KpiPlanForm key={goal.id} goal={goal} onSave={(patch) => updateGoal.mutate(patch)} pending={updateGoal.isPending} />
          {strategyBoardOn ? (
            <>
              <h3 className="pt-2 text-sm font-semibold">Why? requests from the board</h3>
              <GoalWhyRequests
                goalId={goal.id}
                companyId={goal.companyId}
                names={{ agents: agentsById, users: usersById }}
                mayAnswer={boardSummary ? !boardSummary.viewer.isBoardMember : false}
              />
            </>
          ) : null}
        </section>
      ) : null}

      {goal.kind === "initiative" ? (
        <section className="space-y-3" aria-labelledby="initiative-budget-heading">
          <h3 id="initiative-budget-heading" className="text-sm font-semibold">
            Budget
          </h3>
          <InitiativeBudgetForm key={goal.id} goal={goal} onSave={(patch) => updateGoal.mutate(patch)} pending={updateGoal.isPending} />
        </section>
      ) : null}

      {goal.blockers.length > 0 ? (
        <section
          id={GOAL_BLOCKERS_ANCHOR}
          className="scroll-mt-4 space-y-3"
          aria-labelledby="goal-blockers-heading"
        >
          <h3 id="goal-blockers-heading" className="text-sm font-semibold">
            What blocks this goal
          </h3>
          <GoalBlockerList goal={goal} health={health} />
        </section>
      ) : null}

      <section className="space-y-3" aria-labelledby="goal-journey-heading">
        <h3 id="goal-journey-heading" className="text-sm font-semibold">
          The journey
        </h3>
        <GoalJourneyMap milestones={goal.milestones ?? []} agentsById={agentsById} />
      </section>

      <section className="space-y-3" aria-labelledby="goal-recap-heading">
        <h3 id="goal-recap-heading" className="text-sm font-semibold">
          Recap
        </h3>
        <GoalCheckIns
          checkIns={checkIns ?? (goal.latestCheckIn ? [goal.latestCheckIn] : [])}
          agentsById={agentsById}
          ownerName={ownerName}
        />
      </section>

      <Tabs defaultValue="children">
        <TabsList>
          <TabsTrigger value="children">
            Sub-Goals ({childGoals.length})
          </TabsTrigger>
          <TabsTrigger value="projects">
            Projects ({linkedProjects.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="children" className="mt-4 space-y-3">
          <div className="flex items-center justify-start">
            <Button
              size="sm"
              variant="outline"
              onClick={() => openNewGoal({ parentId: goalId })}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Sub Goal
            </Button>
            {goal.kind && GOAL_KIND_PARENTS.kpi?.includes(goal.kind) ? (
              <Button size="sm" variant="outline" className="ml-2" onClick={() => setPackDialogOpen(true)}>
                <FileText className="h-3.5 w-3.5 mr-1.5" />
                KPIs from research pack
              </Button>
            ) : null}
          </div>
          {childGoals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sub-goals.</p>
          ) : (
            <GoalTree goals={childGoals} goalLink={(g) => `/goals/${g.id}`} />
          )}
        </TabsContent>

        <TabsContent value="projects" className="mt-4">
          {linkedProjects.length === 0 ? (
            <p className="text-sm text-muted-foreground">No linked projects.</p>
          ) : (
            <div className="border border-border">
              {linkedProjects.map((project) => (
                <EntityRow
                  key={project.id}
                  title={project.name}
                  subtitle={project.description ?? undefined}
                  to={projectUrl(project)}
                  trailing={<StatusBadge status={project.status} />}
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
      {goal.kind && GOAL_KIND_PARENTS.kpi?.includes(goal.kind) ? (
        <PackKpiDraftsDialog goal={goal} open={packDialogOpen} onOpenChange={setPackDialogOpen} />
      ) : null}
    </div>
  );
}


/** "12 days to go" or "3 days late". */
export function daysHint(days: number | null): string | null {
  if (days == null) return null;
  const n = Math.abs(days);
  const unit = n === 1 ? "day" : "days";
  return days < 0 ? `${n} ${unit} late` : `${n} ${unit} to go`;
}

function GoalKpi({ label, value, hint }: { label: string; value: string; hint?: string | null }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1.5 text-base font-semibold">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
