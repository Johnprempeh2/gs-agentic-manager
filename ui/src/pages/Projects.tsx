import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Project } from "@greatstone/shared";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EntityRow } from "../components/EntityRow";
import { ProjectTile } from "../components/ProjectTile";
import { StatusBadge } from "../components/StatusBadge";
import { MembershipAction } from "../components/MembershipAction";
import { StarToggle } from "../components/StarToggle";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { formatDate, formatProjectBudget, projectUrl } from "../lib/utils";
import { isProjectLate, projectTargetLabel, projectsForUpdate, projectsToCsv, projectsUpdateText } from "../lib/projects-text";
import { downloadTextFile } from "../lib/issues-csv";
import { projectProgress } from "../lib/project-progress";
import { exportFileName, localToday } from "../lib/spreadsheet-export";
import { useCopyAction } from "../lib/use-copy-action";
import {
  isStarred,
  resourceMembershipState,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "../hooks/useResourceMemberships";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AlertTriangle, ArrowUpDown, Check, ClipboardList, Download, Hexagon, Plus } from "lucide-react";
import { Card } from "@/components/ui/card";
import { ErrorState } from "../components/ErrorState";
import { HelpTerm } from "../components/HelpTerm";

type ProjectSortField = "name" | "updated" | "created" | "targetDate";
type ProjectSortDir = "asc" | "desc";

const PROJECT_SORT_OPTIONS: Array<{ field: ProjectSortField; label: string }> = [
  { field: "name", label: "Name" },
  { field: "updated", label: "Updated" },
  { field: "created", label: "Created" },
  { field: "targetDate", label: "Target date" },
];

function compareProjectNames(left: Project, right: Project) {
  const nameDiff = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  return nameDiff !== 0 ? nameDiff : left.id.localeCompare(right.id);
}

function projectTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function compareOptionalTime(
  left: Date | string | null | undefined,
  right: Date | string | null | undefined,
  sortDir: ProjectSortDir,
) {
  const leftTime = projectTime(left);
  const rightTime = projectTime(right);
  if (leftTime === null && rightTime === null) return 0;
  if (leftTime === null) return 1;
  if (rightTime === null) return -1;
  return sortDir === "asc" ? leftTime - rightTime : rightTime - leftTime;
}

function sortProjects(projects: Project[], sortField: ProjectSortField, sortDir: ProjectSortDir) {
  return [...projects].sort((left, right) => {
    let comparison = 0;
    if (sortField === "name") {
      comparison = compareProjectNames(left, right);
      return sortDir === "asc" ? comparison : -comparison;
    }

    if (sortField === "updated") comparison = compareOptionalTime(left.updatedAt, right.updatedAt, sortDir);
    else if (sortField === "created") comparison = compareOptionalTime(left.createdAt, right.createdAt, sortDir);
    else comparison = compareOptionalTime(left.targetDate, right.targetDate, sortDir);

    if (comparison === 0) comparison = compareProjectNames(left, right);
    return comparison;
  });
}

export function Projects() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { openNewProject } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [sortField, setSortField] = useState<ProjectSortField>("name");
  const [sortDir, setSortDir] = useState<ProjectSortDir>("asc");
  const [lateOnly, setLateOnly] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Projects" }]);
  }, [setBreadcrumbs]);

  const { data: allProjects, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const projectsCopy = useCopyAction();
  const membershipsQuery = useResourceMemberships(selectedCompanyId);
  const membershipMutation = useResourceMembershipMutation(selectedCompanyId);
  const projects = useMemo(
    () => allProjects ?? [],
    [allProjects],
  );
  const lateCount = useMemo(() => projects.filter((project) => isProjectLate(project)).length, [projects]);
  const showLateOnly = lateOnly && lateCount > 0;
  const sortedProjects = useMemo(
    () => sortProjects(showLateOnly ? projects.filter((project) => isProjectLate(project)) : projects, sortField, sortDir),
    [projects, showLateOnly, sortDir, sortField],
  );
  const groupedProjects = useMemo(() => {
    const groups = {
      mine: [] as typeof sortedProjects,
      other: [] as typeof sortedProjects,
    };

    for (const project of sortedProjects) {
      const state = resourceMembershipState(membershipsQuery.data, "project", project.id);
      if (state === "left") groups.other.push(project);
      else groups.mine.push(project);
    }

    return groups;
  }, [membershipsQuery.data, sortedProjects]);
  const agentNames = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent.name])), [agents]);
  const textLookups = { agentName: (id: string) => agentNames.get(id) };
  const hasLiveProjects = projectsForUpdate(projects).length > 0;
  const copyProjectsUpdate = () => {
    void projectsCopy.copy(projectsUpdateText(projects, textLookups, localToday()));
  };
  const downloadProjects = () => {
    downloadTextFile(exportFileName(selectedCompany?.issuePrefix, "projects", localToday(), "csv"), projectsToCsv(projects, textLookups));
  };
  const sortLabel = PROJECT_SORT_OPTIONS.find((option) => option.field === sortField)?.label ?? "Name";

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Choose an organisation to view projects." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (error && !allProjects) {
    return <ErrorState error={error} onRetry={() => void refetch()} />;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground" data-testid="projects-intro">
        Each <HelpTerm term="project" /> groups the <HelpTerm term="task">tasks</HelpTerm> that work towards one result.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="w-fit text-xs" title="Sort">
              <ArrowUpDown className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
              <span>Sort: {sortLabel}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-44 p-0">
            <div className="p-2 space-y-0.5">
              {PROJECT_SORT_OPTIONS.map((option) => (
                <button
                  key={option.field}
                  type="button"
                  className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm ${
                    sortField === option.field
                      ? "bg-accent/50 text-foreground"
                      : "text-muted-foreground hover:bg-accent/50"
                  }`}
                  onClick={() => {
                    if (sortField === option.field) {
                      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
                      return;
                    }
                    setSortField(option.field);
                    setSortDir(option.field === "name" || option.field === "targetDate" ? "asc" : "desc");
                  }}
                >
                  <span>{option.label}</span>
                  {sortField === option.field ? (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Check className="h-3 w-3" />
                      {sortDir === "asc" ? "Asc" : "Desc"}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <div className="flex flex-wrap items-center gap-2">
          {lateCount > 0 ? (
            <Button
              size="sm"
              variant={showLateOnly ? "secondary" : "outline"}
              aria-pressed={showLateOnly}
              title={showLateOnly ? "Show every project again" : "Show only open projects past their target date"}
              onClick={() => setLateOnly((current) => !current)}
            >
              <AlertTriangle className="h-4 w-4 mr-1" />
              {showLateOnly ? "Show every project" : `Late (${lateCount})`}
            </Button>
          ) : null}
          {hasLiveProjects ? (
            <Button
              size="sm"
              variant="outline"
              title="Copy every open project and how it is going, to paste into an email or a board pack"
              onClick={copyProjectsUpdate}
            >
              {projectsCopy.copied ? <Check className="h-4 w-4 mr-1" /> : <ClipboardList className="h-4 w-4 mr-1" />}
              {projectsCopy.copied ? "Copied" : projectsCopy.failed ? "Could not copy" : "Copy as an update"}
            </Button>
          ) : null}
          {hasLiveProjects ? (
            <Button
              size="sm"
              variant="outline"
              title="Download every open project as a spreadsheet that opens in Excel or Google Sheets"
              onClick={downloadProjects}
            >
              <Download className="h-4 w-4 sm:mr-1" />
              <span className="hidden sm:inline">Download as spreadsheet</span>
              <span className="sr-only sm:hidden">Download as spreadsheet</span>
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => openNewProject()}>
            <Plus className="h-4 w-4 mr-1" />
            Add project
          </Button>
        </div>
      </div>

      {error && <ErrorState error={error} onRetry={() => void refetch()} compact />}

      {!isLoading && projects.length === 0 && (
        <EmptyState
          icon={Hexagon}
          message="No projects yet."
          description="A project groups related tasks, like a client engagement or a launch, so you can see progress in one place."
          action="Add project"
          onAction={() => openNewProject()}
        />
      )}

      {projects.length > 0 && (
        <div className="space-y-6">
          {([
            ["My Projects", groupedProjects.mine],
            ["Other Projects", groupedProjects.other],
          ] as const).map(([label, sectionProjects]) => {
            if (sectionProjects.length === 0) return null;

            return (
              <section key={label} className="space-y-2">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium">{label}</h2>
                  <span className="text-xs text-muted-foreground">
                    {sectionProjects.length} project{sectionProjects.length === 1 ? "" : "s"}
                  </span>
                </div>
                <Card className="block py-0 overflow-hidden divide-y divide-border">
                  {sectionProjects.map((project) => {
                    const state = resourceMembershipState(membershipsQuery.data, "project", project.id);
                    const pending = membershipMutation.isPending &&
                      membershipMutation.variables?.resourceType === "project" &&
                      membershipMutation.variables.resourceId === project.id;
                    const starPending = pending && membershipMutation.variables?.starred !== undefined;
                    const joinLeavePending = pending && membershipMutation.variables?.starred === undefined;
                    const starred = isStarred(membershipsQuery.data, "project", project.id);
                    return (
                      <EntityRow
                        key={project.id}
                        leading={<ProjectTile color={project.color ?? null} icon={project.icon ?? null} size="sm" />}
                        title={project.name}
                        subtitle={project.description ?? undefined}
                        reserveSubtitleSpace
                        to={projectUrl(project)}
                        className={state === "left" ? "group text-muted-foreground" : "group"}
                        trailing={
                          <div className="flex items-center gap-3">
                            <ProjectProgressCell project={project} />
                            {project.budget && (
                              <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">
                                {formatProjectBudget(project.budget)}
                              </span>
                            )}
                            {project.targetDate && (
                              <span
                                className="hidden text-xs text-muted-foreground md:inline"
                                title={`Target date ${formatDate(project.targetDate)}`}
                              >
                                {projectTargetLabel(project) ?? formatDate(project.targetDate)}
                              </span>
                            )}
                            <StatusBadge status={project.status} />
                            <MembershipAction
                              state={state}
                              pending={joinLeavePending}
                              pendingState={joinLeavePending ? membershipMutation.variables?.state : null}
                              resourceName={project.name}
                              onJoin={() => membershipMutation.mutate({
                                resourceType: "project",
                                resourceId: project.id,
                                resourceName: project.name,
                                state: "joined",
                              })}
                              onLeave={() => membershipMutation.mutate({
                                resourceType: "project",
                                resourceId: project.id,
                                resourceName: project.name,
                                state: "left",
                              })}
                            />
                            <StarToggle
                              size="row"
                              starred={starred}
                              pending={starPending}
                              resourceName={project.name}
                              onToggle={(next) => membershipMutation.mutate({
                                resourceType: "project",
                                resourceId: project.id,
                                resourceName: project.name,
                                starred: next,
                              })}
                            />
                          </div>
                        }
                      />
                    );
                  })}
                </Card>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ProjectProgressCell({ project }: { project: { taskCount?: number; doneTaskCount?: number } }) {
  const progress = projectProgress(project);
  return (
    <span className="hidden items-center gap-2 text-xs text-muted-foreground tabular-nums sm:inline-flex" title={progress.label}>
      {progress.percent !== null ? (
        <span
          className="h-1 w-10 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label="Tasks done"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress.percent}
        >
          <span className="block h-full rounded-full bg-primary" style={{ width: `${progress.percent}%` }} />
        </span>
      ) : null}
      {progress.label}
    </span>
  );
}
