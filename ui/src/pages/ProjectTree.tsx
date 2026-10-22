import { useEffect, useMemo, useState, type SyntheticEvent } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IssueTreeNode, ProjectTree as ProjectTreeData } from "@greatstone/shared";
import { List, Sparkles } from "lucide-react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { projectsApi } from "../api/projects";
import { ApiError } from "../api/client";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { projectRouteRef } from "../lib/utils";
import { useIsPhone } from "../hooks/useIsPhone";
import { useTaskTreePeople } from "../hooks/useTaskTreePeople";
import { indexTaskTree, type VisibleTaskItem } from "../lib/task-tree";
import { initiallyCollapsed, isSyntheticNode, projectRootId, projectTreeAsTaskTree, unsortedId } from "../lib/project-tree";
import { TASK_PAGE_QUERY } from "./TaskDefaultView";
import { PageSkeleton } from "../components/PageSkeleton";
import { ErrorState } from "../components/ErrorState";
import { TaskTreeCanvas } from "../components/task-tree/TaskTreeCanvas";
import { TaskTreeHeader } from "../components/task-tree/TaskTreeHeader";
import { TaskTreeOutline } from "../components/task-tree/TaskTreeOutline";
import { TaskTreeOwner } from "../components/task-tree/TaskTreeOwner";
import { useTaskTreeView } from "../components/task-tree/useTaskTreeView";

/** The tree refreshes on its own so statuses stay current. */
const TREE_REFETCH_MS = 60_000;

/** From the project tree a task opens on its default view: its own tree when it has one. */
function taskHref(node: Pick<IssueTreeNode, "id" | "identifier">) {
  return `/issues/${node.identifier ?? node.id}`;
}

/** Keeps a click on a control inside a card from opening the card. */
function stop(event: SyntheticEvent) {
  event.stopPropagation();
}

/**
 * The project tree (/:prefix/projects/:projectId/tree): the project at the
 * top, the key tasks that drive it as branches with their open work, and the
 * open work under no key task in "Unsorted", where Tidy asks the lead to
 * place it.
 */
export function ProjectTree() {
  const { projectId: projectRef = "" } = useParams<{ projectId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { openNewIssue } = useDialogActions();
  const isPhone = useIsPhone();

  const projectQuery = useQuery({
    queryKey: [...queryKeys.projects.detail(projectRef), selectedCompanyId ?? null],
    queryFn: () => projectsApi.get(projectRef, selectedCompanyId ?? undefined),
    enabled: !!projectRef,
  });
  const project = projectQuery.data;
  const people = useTaskTreePeople(project?.companyId ?? selectedCompanyId);
  const [showFinished, setShowFinished] = useState(false);
  const treeQuery = useQuery({
    queryKey: queryKeys.projectTree(project?.id ?? "", showFinished),
    queryFn: () => projectsApi.getTree(project!.id, showFinished),
    enabled: !!project?.id,
    refetchInterval: TREE_REFETCH_MS,
    placeholderData: keepPreviousData,
  });
  const data: ProjectTreeData | undefined = treeQuery.data;
  const shaped = useMemo(() => (data ? projectTreeAsTaskTree(data) : null), [data]);
  const index = useMemo(() => (shaped ? indexTaskTree(shaped.tree, shaped.hiddenDone) : null), [shaped]);
  const view = useTaskTreeView(index, { viewerUserId: people.viewerUserId ?? null, isPhone, showFinished });
  const { setCollapsed } = view;

  // Key tasks whose work is all done start folded, once per visit.
  const [foldedFor, setFoldedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!data || foldedFor === data.project.id) return;
    setFoldedFor(data.project.id);
    setCollapsed(initiallyCollapsed(data));
  }, [data, foldedFor, setCollapsed]);

  const ref = project ? projectRouteRef(project) : projectRef;
  const listHref = `/projects/${ref}/issues`;
  useEffect(() => {
    setBreadcrumbs([
      { label: "Projects", href: "/projects" },
      { label: project?.name ?? "Project", href: listHref },
      { label: "Tree" },
    ]);
  }, [setBreadcrumbs, project?.name, listHref]);

  const tidy = useMutation({
    mutationFn: () => projectsApi.tidy(project!.id),
    onSuccess: () => {
      const lead = data?.project.lead.agentId ? people.agents.get(data.project.lead.agentId)?.name : null;
      pushToast({
        title: "Tidy asked",
        body: `${lead ?? "The project lead"} will place the unsorted tasks and say where each one went.`,
        tone: "success",
      });
      void queryClient.invalidateQueries({ queryKey: ["project-tree", project!.id] });
    },
    onError: (error) => {
      pushToast({
        title: "Tidy did not start",
        body: error instanceof ApiError ? error.message : "Try again in a moment.",
        tone: "error",
      });
      void queryClient.invalidateQueries({ queryKey: ["project-tree", project!.id] });
    },
  });

  if (projectQuery.isLoading || (treeQuery.isLoading && !data)) return <PageSkeleton variant="detail" />;
  const { visibleRoot, trace } = view;
  if (projectQuery.error || treeQuery.error || !project || !data || !index || !visibleRoot || !trace) {
    return (
      <ErrorState
        error={projectQuery.error ?? treeQuery.error ?? new Error("This project could not be found.")}
        title="The project tree did not load"
        onRetry={() => void (projectQuery.error ? projectQuery.refetch() : treeQuery.refetch())}
        retrying={projectQuery.isFetching || treeQuery.isFetching}
      />
    );
  }

  const sortId = unsortedId(project.id);
  const rootId = projectRootId(project.id);
  const openTask = (node: IssueTreeNode) => {
    if (node.id === rootId) navigate(listHref);
    else if (node.id === sortId) view.toggleCollapsed(sortId);
    else if (!isSyntheticNode(node.id)) navigate(taskHref(node));
  };
  const hrefFor = (item: VisibleTaskItem) => (isSyntheticNode(item.node.id) ? listHref : taskHref(item.node));

  const tidyAction = (node: IssueTreeNode) => {
    if (node.id !== sortId) return null;
    const common = { onClick: stop, onPointerDown: stop, onKeyDown: stop } as const;
    if (data.openTidyTaskId) {
      return (
        <Button asChild variant="outline" size="xs" className="ml-auto shrink-0" {...common}>
          <Link to={`/issues/${data.openTidyTaskId}${TASK_PAGE_QUERY}`} title="A tidy is under way: open its task">
            Tidy asked
          </Link>
        </Button>
      );
    }
    return (
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="ml-auto shrink-0"
        data-tidy-button=""
        disabled={tidy.isPending}
        title="Ask the project lead to place every unsorted task"
        {...common}
        onClick={(event) => {
          stop(event);
          tidy.mutate();
        }}
      >
        <Sparkles />
        Tidy
      </Button>
    );
  };

  const lead = data.project.lead;
  const subtitle = (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5" data-project-lead="">
      <span>Lead:</span>
      {lead.agentId ? (
        <TaskTreeOwner people={people} owner={{ assigneeAgentId: lead.agentId, assigneeUserId: null }} />
      ) : (
        <span>none yet</span>
      )}
      {lead.covering && lead.agentId ? <span>(covering: this project has no lead)</span> : null}
    </span>
  );

  const truncatedNote = data.truncated
    ? `Showing the first ${data.limits.maxNodes} tasks, up to ${data.limits.maxDepth} levels down. Open a key task's own tree to see the rest.`
    : null;

  const actions = (
    <>
      <label className="inline-flex items-center gap-2 text-sm">
        <ToggleSwitch checked={showFinished} onCheckedChange={setShowFinished} aria-label="Show finished work" />
        <span>Show finished work</span>
      </label>
      <Button asChild variant="outline" size="sm">
        <Link to={listHref}>
          <List />
          Task list
        </Link>
      </Button>
    </>
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-6" data-project-tree-page="">
      <TaskTreeHeader
        root={index.root}
        counts={data.counts}
        rootBlockers={trace.rootBlockers}
        people={people}
        onSelectBlocker={view.selectBlocker}
        truncatedNote={truncatedNote}
        subtitle={subtitle}
        actions={actions}
      />
      {data.nodes.length === 0 && data.keyTaskIds.length === 0 ? (
        <div className="flex flex-wrap items-center gap-3" data-no-key-tasks="">
          <p className="text-sm text-muted-foreground">
            No tasks in this project yet. The tree shows the project's work, branch by branch, as tasks are added.
          </p>
          <Button size="sm" onClick={() => openNewIssue({ projectId: data.project.id })}>
            New task
          </Button>
        </div>
      ) : data.keyTaskIds.length === 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-no-key-tasks="">
          <p className="text-sm text-muted-foreground">
            No key tasks yet. The project lead marks the 3 to 7 tasks that drive the project; you can mark one from its
            properties.
          </p>
          <Link to={listHref} className="text-sm font-medium text-foreground underline underline-offset-2">
            Open the task list
          </Link>
        </div>
      ) : null}
      {isPhone ? (
        <TaskTreeOutline
          visibleRoot={visibleRoot}
          trace={trace}
          people={people}
          hrefFor={hrefFor}
          waitingOnById={view.waitingOnById}
          onToggleCollapsed={view.toggleCollapsed}
          onShowFinished={() => setShowFinished(true)}
          highlightId={view.focusRequest?.id ?? null}
          actionFor={tidyAction}
        />
      ) : (
        <TaskTreeCanvas
          className="min-h-96 flex-1"
          visibleRoot={visibleRoot}
          trace={trace}
          people={people}
          waitingOnById={view.waitingOnById}
          onOpen={openTask}
          onToggleCollapsed={view.toggleCollapsed}
          onShowFinished={() => setShowFinished(true)}
          focusRequest={view.focusRequest}
          actionFor={tidyAction}
        />
      )}
    </div>
  );
}
