import { useMemo } from "react";
import { NavLink, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { instanceSettingsApi } from "../api/instanceSettings";
import { pipelinesApi, type PipelineListItem } from "../api/pipelines";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { queryKeys } from "../lib/queryKeys";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";
import {
  starredResourceIds,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "../hooks/useResourceMemberships";
import { StarToggle } from "./StarToggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// Desktop reveals the unpin star on hover/focus; touch has no hover, so it stays visible.
const STAR_ROW_REVEAL =
  "opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover/starred-pipeline:opacity-100 sm:group-focus-within/starred-pipeline:opacity-100";

/**
 * Pinned pipelines, rendered directly below the `Pipelines` nav row. Pinning
 * happens on the Pipelines list and the pipeline page; here a pin can only be
 * removed. Only pipelines the viewer can list are shown (the starred ids are
 * intersected with the company's pipelines), and nothing renders while
 * enablePipelines is off.
 */
export function SidebarStarredPipelines() {
  const { selectedCompanyId } = useCompany();
  const { isMobile, setSidebarOpen, collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  const location = useLocation();

  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const enabled = experimentalSettings?.enablePipelines === true;
  const membershipsQuery = useResourceMemberships(enabled ? selectedCompanyId : null);
  const membershipMutation = useResourceMembershipMutation(selectedCompanyId);
  const starredIds = enabled ? starredResourceIds(membershipsQuery.data, "pipeline") : [];

  const { data: pipelines } = useQuery({
    queryKey: queryKeys.pipelines.list(selectedCompanyId ?? "__none__"),
    queryFn: () => pipelinesApi.list(selectedCompanyId!),
    enabled: enabled && !!selectedCompanyId && starredIds.length > 0,
  });

  const starredPipelines = useMemo(() => {
    const ids = new Set(starredIds);
    return (pipelines ?? [])
      .filter((pipeline) => ids.has(pipeline.id) && !pipeline.archivedAt)
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
    // starredIds is rebuilt each render; its contents are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelines, starredIds.join(",")]);

  if (!enabled || starredPipelines.length === 0) return null;

  const activeId = location.pathname.match(/^\/(?:[^/]+\/)?pipelines\/([^/]+)/)?.[1] ?? null;

  const unpin = (pipeline: PipelineListItem) =>
    membershipMutation.mutate({
      resourceType: "pipeline",
      resourceId: pipeline.id,
      resourceName: pipeline.name,
      starred: false,
    });

  return (
    <div className="flex flex-col gap-0.5" aria-label="Starred pipelines">
      {starredPipelines.map((pipeline) => {
        const isActive = activeId === pipeline.id;
        const pending =
          membershipMutation.isPending &&
          membershipMutation.variables?.resourceType === "pipeline" &&
          membershipMutation.variables.resourceId === pipeline.id;

        const link = (
          <NavLink
            to={`/pipelines/${pipeline.id}`}
            state={SIDEBAR_SCROLL_RESET_STATE}
            aria-current={isActive ? "page" : undefined}
            onClick={() => {
              if (isMobile) setSidebarOpen(false);
            }}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 pr-8 text-(length:--text-compact) font-medium transition-colors",
              !rail && "pl-6",
              isActive
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            )}
          >
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : "flex-1 truncate"}>{pipeline.name}</span>
          </NavLink>
        );

        return (
          <div key={pipeline.id} className="group/starred-pipeline relative flex items-center">
            {rail ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="min-w-0 flex-1">{link}</div>
                </TooltipTrigger>
                <TooltipContent side="right">{pipeline.name}</TooltipContent>
              </Tooltip>
            ) : (
              link
            )}
            {rail ? null : (
              <span className="absolute right-3 top-1/2 -translate-y-1/2">
                <StarToggle
                  size="row"
                  quiet
                  starred
                  pending={pending}
                  resourceName={pipeline.name}
                  onToggle={() => unpin(pipeline)}
                  revealClassName={STAR_ROW_REVEAL}
                />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
