import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ExecutionWorkspace,
  Project,
  ProjectWorkspace,
  ProjectWorkspaceCheckoutHead,
  WorkspaceRuntimeService,
} from "@greatstone/shared";
import { listWorkspaceCommandDefinitions } from "@greatstone/shared";
import { ExternalLink, GitBranch, GitCommitHorizontal } from "lucide-react";
import { projectsApi } from "@/api/projects";
import { queryKeys } from "@/lib/queryKeys";
import { timeAgo } from "@/lib/timeAgo";
import { Link } from "@/lib/router";
import { cn, projectWorkspaceUrl } from "@/lib/utils";
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
  className,
}: LivePreviewCardViewProps) {
  const branch = head?.branch ?? fallbackBranch;
  return (
    <section
      aria-label="Live preview"
      className={cn("space-y-3 rounded-lg border border-border bg-background p-3 sm:p-4", className)}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="text-xs font-medium uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
            Live preview
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

/** Project page card: the primary workspace's preview, with start, stop and restart. */
export function LivePreviewCard({ project, companyId }: { project: Project; companyId?: string | null }) {
  const workspace: ProjectWorkspace | null = project.primaryWorkspace ?? null;
  const queryClient = useQueryClient();
  const [pendingRequests, setPendingRequests] = useState<WorkspaceRuntimeControlRequest[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const runtimeConfig = workspace?.runtimeConfig?.workspaceRuntime ?? null;
  const runtimeServices = workspace?.runtimeServices ?? [];
  const visible = Boolean(workspace) && workspaceHasPreview({ runtimeConfig, runtimeServices });

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
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.urlKey) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.checkoutHead(project.id, workspace?.id ?? "") });
    },
  });

  // The server reports "starting" until the readiness check passes; refresh until it settles.
  const settling = visible && runtimeServices.some((service) =>
    service.status === "starting" || service.status === "provisioning");
  useEffect(() => {
    if (!settling) return;
    const timer = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.urlKey) });
    }, 3_000);
    return () => clearInterval(timer);
  }, [settling, queryClient, project.id, project.urlKey]);

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
