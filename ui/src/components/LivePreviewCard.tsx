import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ExecutionWorkspace,
  Project,
  ProjectWorkspace,
  ProjectWorkspaceCheckoutHead,
  ProjectWorkspacePreviewUpdateState,
  WorkspaceRuntimeService,
} from "@greatstone/shared";
import {
  findPreviewUpdateJob,
  listWorkspaceCommandDefinitions,
  readProjectWorkspacePreviewUpdate,
} from "@greatstone/shared";
import { ExternalLink, GitBranch, GitCommitHorizontal, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { projectsApi } from "@/api/projects";
import { queryKeys } from "@/lib/queryKeys";
import { timeAgo } from "@/lib/timeAgo";
import { Link } from "@/lib/router";
import { cn, formatDateTime, projectUrl, projectWorkspaceUrl } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  buildWorkspaceRuntimeControlSections,
  buildWorkspaceServiceControlEntries,
  resolveWorkspaceServiceControlRequests,
  type WorkspaceRuntimeControlRequest,
} from "@/components/WorkspaceRuntimeControls";
import {
  WorkspaceServiceControlBar,
  type WorkspaceServiceControlAction,
  type WorkspaceServiceControlEntry,
} from "@/components/WorkspaceServiceControlBar";

function hasUrlConfig(rawConfig: Record<string, unknown>) {
  const readiness = rawConfig.readiness as { urlTemplate?: unknown } | null | undefined;
  return rawConfig.port != null || rawConfig.expose != null || Boolean(readiness?.urlTemplate);
}

/**
 * A workspace has a preview when one of its services serves a URL, or is
 * configured to. Workspaces with only background services get no card.
 */
export function workspaceHasPreview(input: {
  runtimeConfig: Record<string, unknown> | null | undefined;
  runtimeServices: WorkspaceRuntimeService[] | null | undefined;
}) {
  if ((input.runtimeServices ?? []).some((service) => Boolean(service.url))) return true;
  return listWorkspaceCommandDefinitions(input.runtimeConfig).some((command) =>
    command.kind === "service" && (command.port != null || hasUrlConfig(command.rawConfig)));
}

/** The running service with a URL, if any: what "Open preview" links to. */
export function pickLivePreviewService(runtimeServices: WorkspaceRuntimeService[] | null | undefined) {
  return (runtimeServices ?? []).find((service) => service.status === "running" && Boolean(service.url)) ?? null;
}

function latestService(runtimeServices: WorkspaceRuntimeService[]) {
  return [...runtimeServices].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] ?? null;
}

export function describeLastActivity(runtimeServices: WorkspaceRuntimeService[] | null | undefined): string | null {
  const service = latestService(runtimeServices ?? []);
  if (!service) return "Never started";
  switch (service.status) {
    case "running":
      return `Started ${timeAgo(service.startedAt)}`;
    case "stopped":
      return service.stoppedAt ? `Stopped ${timeAgo(service.stoppedAt)}` : `Updated ${timeAgo(service.updatedAt)}`;
    case "failed":
      return `Failed ${timeAgo(service.stoppedAt ?? service.updatedAt)}`;
    default:
      return `Starting since ${timeAgo(service.updatedAt)}`;
  }
}

function displayUrl(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** One line about the last update: what it moved to, or why it did not. */
export function describePreviewUpdate(state: ProjectWorkspacePreviewUpdateState, updating: boolean): {
  text: string;
  tone: "muted" | "warning" | "error";
} | null {
  if (updating || state.status === "updating") {
    return { text: "Updating: pulling the latest code and restarting the preview…", tone: "muted" };
  }
  if (state.status === "failed") return { text: state.message ?? "The last update failed.", tone: "error" };
  if (state.status === "skipped") return { text: state.message ?? "The last update was skipped.", tone: "warning" };
  if (state.commit && state.updatedAt) {
    return { text: `Updated to ${state.commit} at ${formatDateTime(state.updatedAt)}`, tone: "muted" };
  }
  if (state.status === "up_to_date") return { text: "Up to date", tone: "muted" };
  return null;
}

export type LivePreviewUpdateControls = {
  state: ProjectWorkspacePreviewUpdateState;
  /** True from the click until the server reports a result. */
  updating: boolean;
  onUpdate: () => void;
  onAutoUpdateChange: (enabled: boolean) => void;
};

export type LivePreviewCardViewProps = {
  services: WorkspaceServiceControlEntry[];
  liveUrl: string | null;
  head: ProjectWorkspaceCheckoutHead | null;
  fallbackBranch: string | null;
  lastActivity: string | null;
  errorMessage: string | null;
  /** Where the workspace's service logs live; shown next to an error. */
  logsHref?: string | null;
  onAction: (action: WorkspaceServiceControlAction, serviceKey: string | null) => void;
  /** Shown when the workspace has an update job. */
  update?: LivePreviewUpdateControls | null;
  /** Names the project when several cards share a page. */
  projectName?: string | null;
  projectHref?: string | null;
  className?: string;
};

export function LivePreviewCardView({
  services,
  liveUrl,
  head,
  fallbackBranch,
  lastActivity,
  errorMessage,
  logsHref,
  onAction,
  update,
  projectName,
  projectHref,
  className,
}: LivePreviewCardViewProps) {
  const branch = head?.branch ?? fallbackBranch;
  const updateLine = update ? describePreviewUpdate(update.state, update.updating) : null;
  const updating = Boolean(update && (update.updating || update.state.status === "updating"));
  return (
    <section
      aria-label="Live preview"
      className={cn("space-y-3 rounded-lg border border-border bg-background p-3 sm:p-4", className)}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="text-xs font-medium uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
            Live preview
            {projectName ? (
              <>
                {" · "}
                {projectHref ? (
                  <Link to={projectHref} className="normal-case tracking-normal text-foreground hover:underline">
                    {projectName}
                  </Link>
                ) : (
                  <span className="normal-case tracking-normal text-foreground">{projectName}</span>
                )}
              </>
            ) : null}
          </div>
          {liveUrl ? (
            <a
              href={liveUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-full items-center gap-1.5 text-sm font-medium text-foreground hover:underline"
            >
              <span className="truncate">Open preview · {displayUrl(liveUrl)}</span>
              <ExternalLink className="size-3.5 shrink-0" aria-hidden />
            </a>
          ) : (
            <p className="text-sm text-muted-foreground">Not running. Start it to open the latest version.</p>
          )}
        </div>
        <WorkspaceServiceControlBar services={services} onAction={onAction} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {branch ? (
          <span className="inline-flex min-w-0 items-center gap-1" title="Branch">
            <GitBranch className="size-3 shrink-0" aria-hidden />
            <span className="truncate font-mono">{branch}</span>
          </span>
        ) : null}
        {head?.commit ? (
          <span className="inline-flex min-w-0 items-center gap-1" title={head.commitSubject ?? "Commit"}>
            <GitCommitHorizontal className="size-3 shrink-0" aria-hidden />
            <span className="font-mono">{head.commit}</span>
            {head.commitSubject ? <span className="max-w-64 truncate">{head.commitSubject}</span> : null}
          </span>
        ) : null}
        {lastActivity ? <span>{lastActivity}</span> : null}
      </div>
      {update ? (
        <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-2">
            <Button
              variant="outline"
              size="xs"
              disabled={updating}
              onClick={update.onUpdate}
              className="shrink-0"
            >
              {updating ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
              {updating ? "Updating…" : "Update now"}
            </Button>
            {updateLine ? (
              <p
                aria-live="polite"
                className={cn(
                  "min-w-0 pt-0.5 text-xs",
                  updateLine.tone === "error" && "text-destructive",
                  updateLine.tone === "warning" && "text-amber-700 dark:text-amber-300",
                  updateLine.tone === "muted" && "text-muted-foreground",
                )}
              >
                {updateLine.tone === "warning" ? <TriangleAlert className="mr-1 inline size-3 align-[-2px]" aria-hidden /> : null}
                {updateLine.text}
              </p>
            ) : null}
          </div>
          <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            <ToggleSwitch
              checked={update.state.autoUpdate}
              onCheckedChange={update.onAutoUpdateChange}
              aria-label="Auto-update on new commits"
            />
            Auto-update on new commits
          </label>
        </div>
      ) : null}
      {errorMessage ? (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage}
          {logsHref ? (
            <>
              {" "}
              <Link to={logsHref} className="font-medium text-foreground underline underline-offset-2">
                View workspace logs
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The primary workspace's preview, with start, stop and restart, and "Update now" plus
 * the auto-update switch when the workspace has an update job. Used on the project page
 * and, with `showProjectName`, on the Deliverables page.
 */
export function LivePreviewCard({
  project,
  companyId,
  showProjectName = false,
  className,
}: {
  project: Project;
  companyId?: string | null;
  showProjectName?: boolean;
  className?: string;
}) {
  const workspace: ProjectWorkspace | null = project.primaryWorkspace ?? null;
  const queryClient = useQueryClient();
  const [pendingRequests, setPendingRequests] = useState<WorkspaceRuntimeControlRequest[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const runtimeConfig = workspace?.runtimeConfig?.workspaceRuntime ?? null;
  const runtimeServices = workspace?.runtimeServices ?? [];
  const visible = Boolean(workspace) && workspaceHasPreview({ runtimeConfig, runtimeServices });
  const hasUpdateJob = Boolean(findPreviewUpdateJob(runtimeConfig));
  const updateState = readProjectWorkspacePreviewUpdate(workspace?.metadata);
  const invalidateProject = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.urlKey) });
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(project.companyId) });
  };

  const headQuery = useQuery({
    queryKey: queryKeys.projects.checkoutHead(project.id, workspace?.id ?? ""),
    queryFn: () => projectsApi.checkoutHead(project.id, workspace!.id, companyId ?? undefined),
    enabled: visible,
    staleTime: 30_000,
  });

  const control = useMutation({
    mutationFn: (request: WorkspaceRuntimeControlRequest) =>
      projectsApi.controlWorkspaceRuntimeServices(
        project.id,
        workspace!.id,
        request.action as "start" | "stop" | "restart",
        companyId ?? undefined,
        request,
      ),
    onSuccess: () => setErrorMessage(null),
    onError: (error, request) =>
      setErrorMessage(`Could not ${request.action} the preview: ${error instanceof Error ? error.message : "unknown error"}.`),
    onSettled: (_result, _error, request) => {
      setPendingRequests((current) => current.filter((pending) => pending !== request));
      invalidateProject();
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.checkoutHead(project.id, workspace?.id ?? "") });
    },
  });

  const updateNow = useMutation({
    mutationFn: () => projectsApi.updatePreview(project.id, workspace!.id, companyId ?? undefined),
    onSuccess: () => setErrorMessage(null),
    onError: (error) =>
      setErrorMessage(`Could not update the preview: ${error instanceof Error ? error.message : "unknown error"}.`),
    onSettled: invalidateProject,
  });

  const autoUpdate = useMutation({
    mutationFn: (enabled: boolean) =>
      projectsApi.setPreviewAutoUpdate(project.id, workspace!.id, enabled, companyId ?? undefined),
    onError: (error) =>
      setErrorMessage(`Could not change auto-update: ${error instanceof Error ? error.message : "unknown error"}.`),
    onSettled: invalidateProject,
  });

  // The server reports "starting" until the readiness check passes, and "updating" until
  // the update job and restart finish; refresh until it settles.
  const updating = updateNow.isPending || updateState.status === "updating";
  const settling = visible && (updating || runtimeServices.some((service) =>
    service.status === "starting" || service.status === "provisioning"));
  useEffect(() => {
    if (!settling) return;
    const timer = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.urlKey) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(project.companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.checkoutHead(project.id, workspace?.id ?? "") });
    }, 3_000);
    return () => clearInterval(timer);
  }, [settling, queryClient, project.id, project.urlKey, project.companyId, workspace?.id]);

  if (!workspace || !visible) return null;

  // The server falls back to the managed checkout when cwd is empty, so only
  // a missing runtime config stops Start here; other refusals come back as errors.
  const sections = buildWorkspaceRuntimeControlSections({
    runtimeConfig,
    runtimeServices,
    canStartServices: Boolean(runtimeConfig),
  });
  const services = buildWorkspaceServiceControlEntries({ sections, runtimeServices, pendingRequests });
  const liveService = pickLivePreviewService(runtimeServices);

  return (
    <LivePreviewCardView
      services={services}
      liveUrl={liveService?.url ?? null}
      head={headQuery.data ?? null}
      fallbackBranch={workspace.defaultRef ?? workspace.repoRef ?? null}
      lastActivity={describeLastActivity(runtimeServices)}
      errorMessage={errorMessage}
      logsHref={projectWorkspaceUrl(project, workspace.id)}
      projectName={showProjectName ? project.name : null}
      projectHref={showProjectName ? projectUrl(project) : null}
      className={className}
      update={hasUpdateJob ? {
        state: autoUpdate.isPending && autoUpdate.variables !== undefined
          ? { ...updateState, autoUpdate: autoUpdate.variables }
          : updateState,
        updating,
        onUpdate: () => updateNow.mutate(),
        onAutoUpdateChange: (enabled) => autoUpdate.mutate(enabled),
      } : null}
      onAction={(action, serviceKey) => {
        const requests = resolveWorkspaceServiceControlRequests(sections, action, serviceKey);
        if (requests.length === 0) return;
        setPendingRequests((current) => [...current, ...requests]);
        for (const request of requests) control.mutate(request);
      }}
    />
  );
}

/** Compact preview link for an issue whose execution workspace is serving a site. */
export function TaskPreviewLink({
  workspace,
  className,
}: {
  workspace: Pick<ExecutionWorkspace, "runtimeServices" | "branchName"> | null | undefined;
  className?: string;
}) {
  const service = pickLivePreviewService(workspace?.runtimeServices);
  if (!service?.url) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-sm", className)}>
      <span className="size-2 shrink-0 rounded-full bg-emerald-500" aria-hidden />
      <span className="text-muted-foreground">Preview</span>
      <a
        href={service.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex min-w-0 items-center gap-1 font-medium text-foreground hover:underline"
      >
        <span className="truncate">{displayUrl(service.url)}</span>
        <ExternalLink className="size-3.5 shrink-0" aria-hidden />
      </a>
      {workspace?.branchName ? (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <GitBranch className="size-3" aria-hidden />
          <span className="font-mono">{workspace.branchName}</span>
        </span>
      ) : null}
    </div>
  );
}
