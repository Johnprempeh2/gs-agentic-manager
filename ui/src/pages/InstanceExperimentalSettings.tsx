import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FlaskConical, Lock, Play } from "lucide-react";
import type {
  InstanceExperimentalSettings,
  InstanceExperimentalSettingsWithManaged,
  InstanceFeatureKey,
  ManagedSettingMetadata,
  PatchInstanceExperimentalSettings,
} from "@greatstone/shared";
import { experimentalSettingKey, isGraduatedInstanceFeatureKey, isRetiredInstanceFeatureKey } from "@greatstone/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { useHiddenSettings } from "@/hooks/useHiddenSettings";
import { useEntitlements } from "@/hooks/useEntitlements";
import { getWorktreeInstanceId, isWorktreeRuntime } from "../lib/worktree-branding";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ErrorState } from "@/components/ErrorState";
import { BoardSecretarySetting } from "@/components/strategy-board/BoardSecretarySetting";

type WorktreeRunExecutionDisplayState =
  | { kind: "off" }
  | { kind: "armed"; activatedAt: string }
  | { kind: "fail_closed"; reason: "missing_cutoff" | "missing_instance_id" | "instance_mismatch" };

/**
 * Mirror of the server's `resolveWorktreeRunExecutionActivation` fail-closed
 * ladder (server/src/services/instance-settings.ts) so the card never claims a
 * copied/legacy row is arming execution. The derived fields are display-only —
 * the PATCH the toggle sends still writes just the boolean.
 */
function resolveWorktreeRunExecutionDisplayState(
  settings:
    | Pick<
        InstanceExperimentalSettings,
        | "enableWorktreeRunExecution"
        | "worktreeRunExecutionActivatedAt"
        | "worktreeRunExecutionActivationInstanceId"
      >
    | undefined,
  currentInstanceId: string | null,
): WorktreeRunExecutionDisplayState {
  if (settings?.enableWorktreeRunExecution !== true) return { kind: "off" };
  if (!settings.worktreeRunExecutionActivatedAt) return { kind: "fail_closed", reason: "missing_cutoff" };
  if (!currentInstanceId) return { kind: "fail_closed", reason: "missing_instance_id" };
  if (settings.worktreeRunExecutionActivationInstanceId !== currentInstanceId) {
    return { kind: "fail_closed", reason: "instance_mismatch" };
  }
  return { kind: "armed", activatedAt: settings.worktreeRunExecutionActivatedAt };
}

function formatActivationTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

function ManagedByCloudBadge() {
  return (
    <Badge variant="outline" className="text-muted-foreground">
      <Lock aria-hidden="true" />
      Managed by your hosting service
    </Badge>
  );
}

function ExperimentalToggleCard({
  title,
  description,
  footnote,
  checked,
  onCheckedChange,
  disabled,
  settingKey,
  managed,
  ariaLabel,
}: {
  title: string;
  description: string;
  footnote?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled: boolean;
  /** Flag key backing this card; operator-hidden keys render nothing. */
  settingKey: InstanceFeatureKey;
  managed?: ManagedSettingMetadata;
  ariaLabel: string;
}) {
  const { hidden: hiddenSettings } = useHiddenSettings();
  const entitlement = useEntitlements().featureState(settingKey);
  const notInPlan = entitlement?.entitled === false;
  const isManaged = managed?.managed === true || notInPlan;
  if (hiddenSettings.has(experimentalSettingKey(settingKey))) return null;
  // Greatstone (GRE-196): retired switches are hidden; their code stays in place.
  if (isRetiredInstanceFeatureKey(settingKey)) return null;
  // Greatstone (GRE-191): graduated switches are hidden; the feature is always on.
  if (isGraduatedInstanceFeatureKey(settingKey)) return null;
  return (
    <Card className="block bg-transparent p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{title}</h3>
            {managed?.managed === true ? <ManagedByCloudBadge /> : null}
            {notInPlan ? (
              <Badge variant="outline" className="text-muted-foreground">
                <Lock aria-hidden="true" />
                Not in your plan
              </Badge>
            ) : null}
            {entitlement?.pendingRestart ? (
              <Badge variant="outline" className="text-muted-foreground">
                Pending restart
              </Badge>
            ) : null}
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
          {footnote ? <p className="max-w-2xl text-xs text-muted-foreground">{footnote}</p> : null}
        </div>
        <ToggleSwitch
          checked={checked}
          onCheckedChange={(next) => {
            if (isManaged) return;
            onCheckedChange(next);
          }}
          disabled={disabled || isManaged}
          aria-label={ariaLabel}
        />
      </div>
    </Card>
  );
}

/** GRE-1078: the signed plan in force, with "Sync now". Renders nothing while entitlements are off. */
function EntitlementPlanStatus() {
  const queryClient = useQueryClient();
  const { data } = useEntitlements();
  const syncMutation = useMutation({
    mutationFn: () => instanceSettingsApi.syncEntitlements(),
    onSuccess: async (result) => {
      queryClient.setQueryData(queryKeys.instance.entitlements, result.entitlements);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.experimentalSettings });
    },
  });
  if (!data || data.state === "disabled") return null;
  const syncError = syncMutation.error instanceof Error ? syncMutation.error.message : null;
  const summary =
    data.state === "floor"
      ? "No valid plan document. Only the base features are on."
      : data.state === "grace"
        ? `Plan v${data.document?.version} has expired. It stays on until ${formatActivationTimestamp(data.document?.graceEndsAt ?? "")}.`
        : `Plan v${data.document?.version} for ${data.document?.client}, valid until ${formatActivationTimestamp(data.document?.validUntil ?? "")}.`;
  return (
    <Card className="block bg-transparent p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1 text-sm">
          <p className="font-medium">Your plan</p>
          <p className="text-muted-foreground">{summary}</p>
          {data.lastError ? <p className="text-xs text-muted-foreground">Last check: {data.lastError}</p> : null}
          {syncError ? <p className="text-xs text-destructive">{syncError}</p> : null}
        </div>
        <Button size="sm" variant="outline" disabled={syncMutation.isPending} onClick={() => syncMutation.mutate()}>
          {syncMutation.isPending ? "Syncing..." : "Sync now"}
        </Button>
      </div>
    </Card>
  );
}

export function InstanceExperimentalSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { hidden: hiddenSettings } = useHiddenSettings();
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Experimental" },
    ]);
  }, [setBreadcrumbs]);

  // GRE-1743: model checks spend money, so turning them on asks first.
  const [confirmPromptInjectionSpend, setConfirmPromptInjectionSpend] = useState(false);

  const experimentalQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  const toggleMutation = useMutation<
    InstanceExperimentalSettingsWithManaged,
    Error,
    PatchInstanceExperimentalSettings,
    { previousSettings?: InstanceExperimentalSettingsWithManaged }
  >({
    mutationFn: async (patch: PatchInstanceExperimentalSettings) =>
      instanceSettingsApi.updateExperimental(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.instance.experimentalSettings });
      const previousSettings = queryClient.getQueryData<InstanceExperimentalSettingsWithManaged>(
        queryKeys.instance.experimentalSettings,
      );
      if (previousSettings) {
        queryClient.setQueryData<InstanceExperimentalSettingsWithManaged>(
          queryKeys.instance.experimentalSettings,
          { ...previousSettings, ...patch },
        );
      }
      return { previousSettings };
    },
    onSuccess: async (updatedSettings) => {
      setActionError(null);
      queryClient.setQueryData(queryKeys.instance.experimentalSettings, updatedSettings);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.experimentalSettings }),
        queryClient.invalidateQueries({ queryKey: queryKeys.adapters.all }),
        queryClient.invalidateQueries({ queryKey: ["built-in-agents"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.health }),
        queryClient.invalidateQueries({ queryKey: ["apps"] }),
      ]);
    },
    onError: (error, _patch, context) => {
      if (context?.previousSettings) {
        queryClient.setQueryData(queryKeys.instance.experimentalSettings, context.previousSettings);
      }
      setActionError(error instanceof Error ? error.message : "Could not save experimental settings.");
    },
  });

  if (experimentalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading experimental settings...</div>;
  }

  if (experimentalQuery.error) {
    return (
      <ErrorState
        error={experimentalQuery.error}
        title="Experimental settings did not load"
        onRetry={() => void experimentalQuery.refetch()}
        retrying={experimentalQuery.isFetching}
      />
    );
  }

  const inWorktree = isWorktreeRuntime();
  // Present only on cloud-managed instances: keys the managed overlay controls
  // render locked with the "Managed by your hosting service" badge. Self-hosted
  // responses carry no `managedKeys`, so every card stays editable.
  const managedKeys = experimentalQuery.data?.managedKeys ?? {};
  const enableWorktreeRunExecution = experimentalQuery.data?.enableWorktreeRunExecution === true;
  const worktreeRunExecutionManaged = managedKeys.enableWorktreeRunExecution?.managed === true;
  const worktreeRunExecutionState = resolveWorktreeRunExecutionDisplayState(
    experimentalQuery.data,
    getWorktreeInstanceId(),
  );
  const enableManagedSandboxOnly = experimentalQuery.data?.enableManagedSandboxOnly === true;
  const enableIsolatedWorkspacesByDefault =
    experimentalQuery.data?.enableIsolatedWorkspacesByDefault === true;
  // Streamlined left navigation is now the standard sidebar (PAP-12472); the
  // experimental opt-out was retired, so it no longer surfaces a toggle here.
  const enableClassicTaskInterface = experimentalQuery.data?.enableClassicTaskInterface === true;
  const enableWebsiteView = experimentalQuery.data?.enableWebsiteView === true;
  const enableIntelligence = experimentalQuery.data?.enableIntelligence === true;
  const enableGoalsSidebarLink = experimentalQuery.data?.enableGoalsSidebarLink === true;
  const enablePromptInjectionModelChecks = experimentalQuery.data?.enablePromptInjectionModelChecks === true;
  const enableDeepDive = experimentalQuery.data?.enableDeepDive === true;
  // GRE-1382: the Board add-on needs the Strategy module.
  const enableStrategy = experimentalQuery.data?.enableStrategy === true;
  const enableStrategyBoard = experimentalQuery.data?.enableStrategyBoard === true;
  const boardBlockedByManagedStrategy = managedKeys.enableStrategy?.managed === true && !enableStrategy;
  const strategyRequiredByManagedBoard = managedKeys.enableStrategyBoard?.managed === true && enableStrategyBoard;
  const enablePaperclipDeveloperMode =
    experimentalQuery.data?.enablePaperclipDeveloperMode === true;
  const enableFirstTaskPlanProposal =
    experimentalQuery.data?.enableFirstTaskPlanProposal === true;
  const enableSmokeLab = experimentalQuery.data?.enableSmokeLab === true;
  const autoRestartDevServerWhenIdle = experimentalQuery.data?.autoRestartDevServerWhenIdle === true;
  const isVisible = (key: InstanceFeatureKey) =>
    !isRetiredInstanceFeatureKey(key) && !isGraduatedInstanceFeatureKey(key) && !hiddenSettings.has(experimentalSettingKey(key));
  const showWorktreeRunExecution = inWorktree && isVisible("enableWorktreeRunExecution");
  const showDeveloperSection = showWorktreeRunExecution || ([
    "autoRestartDevServerWhenIdle",
    "enableManagedSandboxOnly",
    "enablePaperclipDeveloperMode",
    "enableSmokeLab",
  ] satisfies InstanceFeatureKey[]).some(isVisible);
  const showLegacySection = isVisible("enableClassicTaskInterface") || isVisible("enableGoalsSidebarLink");
  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Experimental</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Opt into features that are still being evaluated before they become default behavior.
        </p>
      </div>

      <div
        role="alert"
        className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <div className="space-y-1 text-sm">
            <p className="font-medium text-foreground">Experimental features may break at any time.</p>
            <p className="text-muted-foreground">
              These features are opt-in and come with no compatibility guarantees. They may change, break, or be
              removed without notice. Avoid relying on them for critical or production workflows.
            </p>
          </div>
        </div>
      </div>

      <EntitlementPlanStatus />

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="space-y-3" aria-labelledby="experimental-features-heading">
        <div className="space-y-1">
          <h2 id="experimental-features-heading" className="text-sm font-semibold">
            Experimental features
          </h2>
          <p className="text-sm text-muted-foreground">
            Optional product features that are still being evaluated.
          </p>
        </div>



        <ExperimentalToggleCard
          title="Board control panel"
          description="The board's view of the strategy: status by area, biggest slippages first, changes since the last board pack, slippage alerts to the chair, “Why?” requests and the quarterly board pack."
          footnote="Turning it on also turns Strategy on. Turning it off hides the Board page, the alerts and the board packs; nothing is deleted."
          checked={enableStrategyBoard}
          onCheckedChange={(checked) =>
            toggleMutation.mutate(
              checked ? { enableStrategy: true, enableStrategyBoard: true } : { enableStrategyBoard: false },
            )
          }
          disabled={toggleMutation.isPending || boardBlockedByManagedStrategy}
          settingKey="enableStrategyBoard"
          managed={managedKeys.enableStrategyBoard}
          ariaLabel="Toggle board control panel experimental setting"
        />

        {enableStrategyBoard ? (
          <BoardSecretarySetting
            value={experimentalQuery.data?.strategyBoardSecretaryAgentId ?? null}
            onChange={(agentId) => toggleMutation.mutate({ strategyBoardSecretaryAgentId: agentId })}
            disabled={toggleMutation.isPending}
          />
        ) : null}



        <ExperimentalToggleCard
          title="Deep Dive"
          description="Record a client deep dive as Cases: the nine Investigation Streams by the five GIF questions, with status, depth and visibility for each stream. Adds the Deep Dive page."
          footnote="Turning it off hides the page; the deep dive cases are kept."
          checked={enableDeepDive}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableDeepDive: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableDeepDive"
          managed={managedKeys.enableDeepDive}
          ariaLabel="Toggle deep dive experimental setting"
        />

        <ExperimentalToggleCard
          title="First task: propose with a plan document"
          description="When the user's first request is a single task, the chief of staff writes a short plan document and a checkbox card instead of a one-card confirmation. Applies to organisations created after this is switched on."
          checked={enableFirstTaskPlanProposal}
          onCheckedChange={(checked) =>
            toggleMutation.mutate({ enableFirstTaskPlanProposal: checked })
          }
          disabled={toggleMutation.isPending}
          settingKey="enableFirstTaskPlanProposal"
          managed={managedKeys.enableFirstTaskPlanProposal}
          ariaLabel="Toggle first task plan proposal experimental setting"
        />

        <ExperimentalToggleCard
          title="Intelligence"
          description="The Intelligence page: the Daily Pulse, the AI leaderboards with movement, compare, radar and news, and GSAM feature and skill recommendations. An agent with the intelligence:write permission writes it every day."
          footnote="Turning this off hides the Intelligence page and blocks its API; stored reports are kept."
          checked={enableIntelligence}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableIntelligence: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableIntelligence"
          managed={managedKeys.enableIntelligence}
          ariaLabel="Toggle intelligence experimental setting"
        />

        <ExperimentalToggleCard
          title="Prompt injection model checks"
          description="Check each tool result for prompt injection with a model before an agent reads it. Without it, only the built-in pattern check runs."
          footnote="Paid: every check is one OpenRouter call, billed to the company's shared OpenRouter connection and shown in Costs. Without that connection, or when a check fails, the built-in pattern check is used."
          checked={enablePromptInjectionModelChecks}
          onCheckedChange={(checked) =>
            checked
              ? setConfirmPromptInjectionSpend(true)
              : toggleMutation.mutate({ enablePromptInjectionModelChecks: false })
          }
          disabled={toggleMutation.isPending}
          settingKey="enablePromptInjectionModelChecks"
          managed={managedKeys.enablePromptInjectionModelChecks}
          ariaLabel="Toggle prompt injection model checks experimental setting"
        />

        <AlertDialog open={confirmPromptInjectionSpend} onOpenChange={setConfirmPromptInjectionSpend}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Turn on paid model checks?</AlertDialogTitle>
              <AlertDialogDescription>
                Every tool result an agent gets is sent, with secrets removed, to OpenRouter for one model check.
                Each check costs money. It is billed to the company's shared OpenRouter connection and shows in
                Costs under the agent that called the tool. No check runs until you turn this on.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirmPromptInjectionSpend(false);
                  toggleMutation.mutate({ enablePromptInjectionModelChecks: true });
                }}
              >
                Turn on paid checks
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>



        <ExperimentalToggleCard
          title="Strategy"
          description="The one-page strategic plan (vision down to KPIs), KPI readings with on and off track status, and KPI drafts from a research pack. Plain goals work without it."
          footnote="Turning it off hides the plan and the KPI parts of each goal; nothing is deleted. The Board control panel needs Strategy, so turning Strategy off also turns the Board off."
          checked={enableStrategy}
          onCheckedChange={(checked) =>
            toggleMutation.mutate(
              checked || !enableStrategyBoard
                ? { enableStrategy: checked }
                : { enableStrategy: false, enableStrategyBoard: false },
            )
          }
          disabled={toggleMutation.isPending || strategyRequiredByManagedBoard}
          settingKey="enableStrategy"
          managed={managedKeys.enableStrategy}
          ariaLabel="Toggle strategy setting"
        />


        <ExperimentalToggleCard
          title="Team Chat"
          description="Message colleagues directly, and start group chats with people and agents. Agents in a group reply only when you @mention them."
          footnote="Turning this off hides Chats and blocks new team chat messages; existing chats are kept."
          checked={experimentalQuery.data?.enableTeamChat ?? false}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableTeamChat: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableTeamChat"
          managed={managedKeys.enableTeamChat}
          ariaLabel="Toggle team chat experimental setting"
        />

        <ExperimentalToggleCard
          title="Use Isolated Workspaces By Default"
          description="Treat a project that has no execution workspace policy of its own as if it selected isolated workspaces, so its tasks get a per-task worktree instead of sharing the project checkout. A project that carries its own policy keeps it."
          checked={enableIsolatedWorkspacesByDefault}
          onCheckedChange={(checked) =>
            toggleMutation.mutate({ enableIsolatedWorkspacesByDefault: checked })
          }
          disabled={toggleMutation.isPending}
          settingKey="enableIsolatedWorkspacesByDefault"
          managed={managedKeys.enableIsolatedWorkspacesByDefault}
          ariaLabel="Toggle isolated workspaces by default experimental setting"
        />

        <ExperimentalToggleCard
          title="Website view"
          description="A read-only Website page built from Google Analytics 4 and Search Console, with a daily pull stored in this instance."
          footnote="Turning this off hides the Website page and blocks the Website API; stored reports are kept."
          checked={enableWebsiteView}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableWebsiteView: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableWebsiteView"
          managed={managedKeys.enableWebsiteView}
          ariaLabel="Toggle website view experimental setting"
        />
      </section>

      {showDeveloperSection ? (
        <section className="space-y-3" aria-labelledby="developer-mode-heading">
          <div className="space-y-1">
            <h2 id="developer-mode-heading" className="text-sm font-semibold">
              GS Agentic Manager Developer Mode
            </h2>
            <p className="text-sm text-muted-foreground">
              Internal tools for developing, testing, and debugging GS Agentic Manager.
            </p>
          </div>

          <ExperimentalToggleCard
            title="Auto-Restart Dev Server When Idle"
            description="In `pnpm dev:once`, wait for all queued and running local agent runs to finish, then restart the server automatically when backend changes or migrations make the current boot stale."
            checked={autoRestartDevServerWhenIdle}
            onCheckedChange={(checked) =>
              toggleMutation.mutate({ autoRestartDevServerWhenIdle: checked })
            }
            disabled={toggleMutation.isPending}
            settingKey="autoRestartDevServerWhenIdle"
            managed={managedKeys.autoRestartDevServerWhenIdle}
            ariaLabel="Toggle guarded dev-server auto-restart"
          />
          <ExperimentalToggleCard
            title="GS Agentic Manager Developer Mode"
            description="Show internal GS Agentic Manager maintainer tools and observability links, including Honeycomb trace queries on run pages."
            checked={enablePaperclipDeveloperMode}
            onCheckedChange={(checked) =>
              toggleMutation.mutate({ enablePaperclipDeveloperMode: checked })
            }
            disabled={toggleMutation.isPending}
            settingKey="enablePaperclipDeveloperMode"
            managed={managedKeys.enablePaperclipDeveloperMode}
            ariaLabel="Toggle GS Agentic Manager developer mode experimental setting"
          />


          <ExperimentalToggleCard
            title="Managed Environment Only"
            description="Hide the local environment and run all agents in the platform-managed environment."
            checked={enableManagedSandboxOnly}
            onCheckedChange={(checked) =>
              toggleMutation.mutate({ enableManagedSandboxOnly: checked })
            }
            disabled={toggleMutation.isPending}
            settingKey="enableManagedSandboxOnly"
            managed={managedKeys.enableManagedSandboxOnly}
            ariaLabel="Toggle managed environment only experimental setting"
          />

          {showWorktreeRunExecution ? (
            <Card className="block bg-transparent p-5">
              <div className="flex flex-col gap-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold">Run tasks in this worktree</h3>
                      {worktreeRunExecutionManaged ? <ManagedByCloudBadge /> : null}
                    </div>
                    <p className="max-w-2xl text-sm text-muted-foreground">
                      This is an isolated git-worktree preview instance. Turn this on to let the scheduler execute runs
                      here. Only tasks created after enabling will run automatically. Copied/pre-existing tasks stay
                      parked. Toggling off and on resets the cutoff.
                    </p>
                  </div>
                  <ToggleSwitch
                    checked={enableWorktreeRunExecution}
                    onCheckedChange={(checked) => {
                      if (worktreeRunExecutionManaged) return;
                      toggleMutation.mutate({ enableWorktreeRunExecution: checked });
                    }}
                    disabled={toggleMutation.isPending || worktreeRunExecutionManaged}
                    aria-label="Toggle worktree run execution setting"
                  />
                </div>

                {worktreeRunExecutionState.kind === "armed" ? (
                  <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-foreground">
                    <Play className="h-4 w-4 shrink-0 text-emerald-600" />
                    <span>
                      Running tasks created after{" "}
                      <span className="font-medium">
                        {formatActivationTimestamp(worktreeRunExecutionState.activatedAt)}
                      </span>
                      .
                    </span>
                  </div>
                ) : null}

                {worktreeRunExecutionState.kind === "fail_closed" ? (
                  <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                    <div className="space-y-0.5">
                      <p className="font-medium text-foreground">Execution is suppressed (effectively off).</p>
                      <p className="text-muted-foreground">
                        {worktreeRunExecutionState.reason === "instance_mismatch"
                          ? "This setting was armed in a different instance and copied here, so no tasks run automatically."
                          : "This setting is missing its activation cutoff, so no tasks run automatically."}{" "}
                        Toggle it off and back on to arm execution for tasks created here.
                      </p>
                    </div>
                  </div>
                ) : null}
              </div>
            </Card>
          ) : null}

          <ExperimentalToggleCard
            title="Smoke Lab"
            description='Add a "Smoke Lab" tab under Apps → Developer and an "Integration smoke" card on the dashboard for exercising every integration path against deterministic local fixtures (fake OAuth provider + loopback MCP servers). Private (non-public) deployments only.'
            checked={enableSmokeLab}
            onCheckedChange={(checked) => toggleMutation.mutate({ enableSmokeLab: checked })}
            disabled={toggleMutation.isPending}
            settingKey="enableSmokeLab"
            managed={managedKeys.enableSmokeLab}
            ariaLabel="Toggle smoke lab experimental setting"
          />

        </section>
      ) : null}

      {showLegacySection ? (
        <section className="space-y-3" aria-labelledby="legacy-heading">
          <div className="space-y-1">
            <h2 id="legacy-heading" className="text-sm font-semibold">
              Legacy
            </h2>
            <p className="text-sm text-muted-foreground">These features are going to be removed.</p>
          </div>

          <ExperimentalToggleCard
            title="Classic Task Interface"
            description="Restores the previous task detail page: the page-level header with inline description editing, the plain comment thread, and the fixed Properties sidebar. Chat-only features (streaming activity folding, inline plan and question cards, the three-mode composer) are unavailable in the classic view."
            footnote="Switching takes effect immediately. No task data is affected."
            checked={enableClassicTaskInterface}
            onCheckedChange={(checked) =>
              toggleMutation.mutate({ enableClassicTaskInterface: checked })
            }
            disabled={toggleMutation.isPending}
            settingKey="enableClassicTaskInterface"
            managed={managedKeys.enableClassicTaskInterface}
            ariaLabel="Toggle classic task interface experimental setting"
          />

          <ExperimentalToggleCard
            title="Goals Sidebar Link"
            description="Restore the Goals item in the main sidebar while the goals surface is being evaluated."
            checked={enableGoalsSidebarLink}
            onCheckedChange={(checked) =>
              toggleMutation.mutate({ enableGoalsSidebarLink: checked })
            }
            disabled={toggleMutation.isPending}
            settingKey="enableGoalsSidebarLink"
            managed={managedKeys.enableGoalsSidebarLink}
            ariaLabel="Toggle goals sidebar link experimental setting"
          />
        </section>
      ) : null}
    </div>
  );
}
