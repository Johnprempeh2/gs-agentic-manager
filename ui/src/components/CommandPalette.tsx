import { AgentIdentity } from "@/components/AgentIdentity";
import { useState, useEffect, useMemo } from "react";
import { useLocation, useNavigate } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Issue } from "@greatstone/shared";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { useToastActions } from "../context/ToastContext";
import { issuesApi } from "../api/issues";
import { authApi } from "../api/auth";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  CircleDot,
  Bot,
  Hexagon,
  Target,
  LayoutDashboard,
  Inbox,
  DollarSign,
  History,
  SquarePen,
  FileCode2,
  Plus,
  Search,
  ArrowLeft,
  CheckCircle2,
  UserRound,
  ExternalLink,
  ChevronRight,
  MessageCircle,
  Keyboard,
  Pin,
  Star,
} from "lucide-react";
import { Identity } from "./Identity";
import { openShortcutsSheet } from "./KeyboardShortcutsCheatsheet";
import { useOptionalBreadcrumbs } from "../context/BreadcrumbContext";
import { toCompanyRelativePath } from "../lib/company-routes";
import {
  isSaved,
  loadSavedSearches,
  removeSavedSearch,
  saveSearchItem,
  viewLabel,
  type NewSavedSearchItem,
  type SavedSearchItem,
} from "../lib/saved-searches";
import { agentUrl, projectUrl } from "../lib/utils";
import {
  SEARCH_OPERATOR_QUICK_FILTERS,
  buildSearchPathFromQuery,
  parseSearchQuery,
  type SearchQueryParserContext,
} from "../lib/search-query-parser";
import {
  OPEN_COMMAND_PALETTE_EVENT,
  isOpenTaskStatus,
  plainTaskStatus,
} from "../lib/global-search";
import { GlobalSearchSources } from "./search/GlobalSearchSources";
import { GlobalSearchEmptyState } from "./search/GlobalSearchEmptyState";
import { pushRecentSearch } from "../lib/recent-searches";
import { openAskEverest } from "../lib/ask-everest-events";
import { resolveLeadAgent } from "./MobileEverestButton";
import { decisionsFeedApi } from "../api/decisionsFeed";
import { parseCommand, type PaletteCommand } from "../lib/palette-commands";
import { CommandPreviewPanel, CommandSuggestion } from "./search/CommandPreview";

const SEARCH_ALL_VALUE = "__paperclip-search-all__";

export function buildFullSearchPath(query: string, context: SearchQueryParserContext = {}) {
  return buildSearchPathFromQuery(query, context);
}

const ISSUE_DETAIL_PATH_RE = /\/issues\/[^/?#]+(?:$|\?|#|\/)/;

function isOnIssueDetail(pathname: string): boolean {
  return ISSUE_DETAIL_PATH_RE.test(pathname);
}

/** The task reference in the address, such as GRE-12, when a task is open. */
function issueRefFromPath(pathname: string): string | null {
  const match = /\/issues\/([^/?#]+)/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

/** Max promoted project matches kept when typing in the palette. */
const MAX_MATCHED_PROJECTS = 5;
/** Task cap when projects are also promoted, so Tasks can't crowd them out. */
const TASK_LIMIT_WITH_PROJECTS = 6;
const TASK_LIMIT = 10;

/** True when every char of `needle` appears in `haystack` in order (fuzzy). */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j += 1) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

/**
 * Score a project against a lowercased query. Higher is a better match;
 * `null` means no match. Prefers name hits (exact > prefix > substring) over
 * description hits, with fuzzy subsequence as a last resort.
 */
function scoreProjectMatch(name: string, description: string, q: string): number | null {
  if (name === q) return 1000;
  // Shorter names rank first, but clamp the length penalty so a prefix match can
  // never sink below the substring band (max 699) for unusually long names —
  // keeps the prefix > substring > description > fuzzy ordering invariant.
  if (name.startsWith(q)) return Math.max(700, 900 - name.length);
  const nameIdx = name.indexOf(q);
  if (nameIdx >= 0) return 700 - nameIdx;
  if (description.includes(q)) return 400;
  if (isSubsequence(q, name)) return 200;
  return null;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The task whose quick actions are showing (Tab or the arrow on a task row).
  const [actionIssue, setActionIssue] = useState<Issue | null>(null);
  // A plain-English command waiting for confirmation ("create a task for Mason...").
  const [pendingCommand, setPendingCommand] = useState<PaletteCommand | null>(null);
  const [commandText, setCommandText] = useState("");
  const [savedItems, setSavedItems] = useState<SavedSearchItem[]>([]);
  const breadcrumbs = useOptionalBreadcrumbs();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const navigate = useNavigate();
  const location = useLocation();
  const { selectedCompanyId } = useCompany();
  const { openNewIssue, openNewAgent } = useDialogActions();
  const { isMobile, setSidebarOpen } = useSidebar();
  const searchQuery = query.trim();
  const onIssueDetail = isOnIssueDetail(location.pathname);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(true);
        if (isMobile) setSidebarOpen(false);
      }
    }
    function handleOpenRequest(event: Event) {
      const preset = (event as CustomEvent<{ query?: string }>).detail?.query ?? "";
      setOpen(true);
      if (preset) setQuery(preset);
      if (isMobile) setSidebarOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, handleOpenRequest);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, handleOpenRequest);
    };
  }, [isMobile, setSidebarOpen]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActionIssue(null);
      setPendingCommand(null);
    }
  }, [open]);

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && open,
  });

  const leadAgent = useMemo(() => resolveLeadAgent(agents), [agents]);

  const { data: allProjects = [] } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && open,
  });
  const projects = useMemo(
    () => allProjects,
    [allProjects],
  );

  const { data: labels = [] } = useQuery({
    queryKey: queryKeys.issues.labels(selectedCompanyId!),
    queryFn: () => issuesApi.listLabels(selectedCompanyId!),
    enabled: !!selectedCompanyId && open,
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: open,
  });

  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  useEffect(() => {
    if (open && selectedCompanyId) setSavedItems(loadSavedSearches(selectedCompanyId, currentUserId));
  }, [open, selectedCompanyId, currentUserId]);

  const currentViewPath = `${toCompanyRelativePath(location.pathname)}${location.search ?? ""}`;
  const searchIsSaved = isSaved(savedItems, { kind: "search", label: searchQuery, query: searchQuery });
  const viewIsPinned = isSaved(savedItems, { kind: "view", label: "", path: currentViewPath });

  function saveItem(item: NewSavedSearchItem, doneLabel: string) {
    if (!selectedCompanyId) return;
    setSavedItems(saveSearchItem(selectedCompanyId, currentUserId, item));
    pushToast({ title: doneLabel, body: item.label, tone: "success" });
  }

  function removeItem(id: string) {
    if (!selectedCompanyId) return;
    setSavedItems(removeSavedSearch(selectedCompanyId, currentUserId, id));
  }
  const parserContext = useMemo<SearchQueryParserContext>(() => ({
    currentUserId,
    agents,
    projects,
    labels,
  }), [agents, currentUserId, labels, projects]);
  const parsedQuery = useMemo(() => parseSearchQuery(query, parserContext), [parserContext, query]);
  const quickSearchQuery = parsedQuery.query.trim();

  const { data: issues = [] } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && open && searchQuery.length === 0,
  });

  const { data: searchedIssues = [] } = useQuery({
    queryKey: queryKeys.issues.search(selectedCompanyId!, quickSearchQuery, undefined, 10),
    queryFn: () => issuesApi.list(selectedCompanyId!, { q: quickSearchQuery, limit: 10, includeRoutineExecutions: true }),
    enabled: !!selectedCompanyId && open && quickSearchQuery.length > 0,
  });

  const updateIssue = useMutation({
    mutationFn: ({ issue, patch }: { issue: Issue; patch: Record<string, unknown>; doneLabel: string }) =>
      issuesApi.update(issue.id, patch),
    onSuccess: (_result, { issue, doneLabel }) => {
      void queryClient.invalidateQueries({ queryKey: ["issues", selectedCompanyId] });
      pushToast({ title: doneLabel, body: issue.title, tone: "success" });
      setOpen(false);
    },
    onError: (error, { issue }) => {
      pushToast({
        title: `Could not update ${issue.identifier ?? "the task"}`,
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      });
    },
  });

  const currentTaskRef = onIssueDetail ? issueRefFromPath(location.pathname) : null;
  const typedCommand = useMemo(
    () => (actionIssue || pendingCommand ? null : parseCommand(searchQuery, agents)),
    [actionIssue, pendingCommand, searchQuery, agents],
  );

  const runCommand = useMutation({
    mutationFn: async (command: PaletteCommand): Promise<{ title: string; issue: Issue }> => {
      const companyId = selectedCompanyId!;
      if (command.kind === "create") {
        const owner = command.agent ?? leadAgent;
        const issue = await issuesApi.create(companyId, {
          title: command.title,
          status: "todo",
          ...(owner ? { assigneeAgentId: owner.id } : {}),
          ...(command.due ? { description: `Due by ${command.due.label}.` } : {}),
        });
        return { title: owner ? `Task created for ${owner.name}` : "Task created", issue };
      }
      if (command.kind === "assign") {
        const ref = command.taskRef === "this" ? currentTaskRef : command.taskRef;
        if (!ref) throw new Error("Open a task first, then try again.");
        const target = await issuesApi.get(ref);
        const patch = command.toMe
          ? { assigneeUserId: currentUserId, assigneeAgentId: null }
          : { assigneeAgentId: command.agent!.id, assigneeUserId: null };
        const issue = await issuesApi.update(target.id, patch);
        const label = target.identifier ?? "The task";
        return { title: command.toMe ? `${label} is now yours` : `${label} handed to ${command.agent!.name}`, issue };
      }
      const issue = await issuesApi.create(companyId, {
        title: command.title,
        status: "todo",
        ...(currentUserId ? { assigneeUserId: currentUserId } : {}),
      });
      const returnAt = new Date(command.when.date);
      returnAt.setHours(9, 0, 0, 0);
      await decisionsFeedApi.table(issue.id, returnAt.toISOString());
      return { title: `Reminder set for ${command.when.label}`, issue };
    },
    onSuccess: ({ title, issue }) => {
      void queryClient.invalidateQueries({ queryKey: ["issues", selectedCompanyId] });
      pushToast({ title, body: issue.title, tone: "success" });
      setOpen(false);
      navigate(`/issues/${issue.identifier ?? issue.id}`);
    },
    onError: (error) => {
      pushToast({
        title: "That did not work",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      });
    },
  });

  function leaveCommandPreview() {
    setPendingCommand(null);
    setQuery(commandText);
  }

  function openActionsFor(issue: Issue) {
    setActionIssue(issue);
    setQuery("");
  }

  function go(path: string) {
    if (selectedCompanyId && searchQuery.length > 0) pushRecentSearch(selectedCompanyId, searchQuery);
    setOpen(false);
    navigate(path);
  }

  function goFullSearch() {
    go(buildFullSearchPath(searchQuery, parserContext));
  }

  const agentName = (id: string | null) => {
    if (!id) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  const visibleIssues = useMemo(
    () => (quickSearchQuery.length > 0 ? searchedIssues : issues),
    [issues, searchedIssues, quickSearchQuery],
  );

  // Client-side typeahead ranking over the already-loaded projects. cmdk ranks
  // items by their `value` (which defaults to the rendered name) and would bury
  // or drop description-only matches, so we rank in JS and force-match below.
  const matchedProjects = useMemo(() => {
    if (quickSearchQuery.length === 0) return [];
    const q = quickSearchQuery.toLowerCase();
    return projects
      .map((project) => ({
        project,
        score: scoreProjectMatch(
          project.name.toLowerCase(),
          (project.description ?? "").toLowerCase(),
          q,
        ),
      }))
      .filter((entry): entry is { project: (typeof projects)[number]; score: number } => entry.score !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_MATCHED_PROJECTS)
      .map((entry) => entry.project);
  }, [projects, quickSearchQuery]);

  const showSearchAll = searchQuery.length > 0;
  const titleMatchIds = useMemo(() => new Set(visibleIssues.map((issue) => issue.id)), [visibleIssues]);
  const showPromotedProjects = showSearchAll && matchedProjects.length > 0;
  const taskLimit = showPromotedProjects ? TASK_LIMIT_WITH_PROJECTS : TASK_LIMIT;
  const showEmptyHint =
    showSearchAll && visibleIssues.length === 0 && matchedProjects.length === 0;

  return (
    <CommandDialog className="sm:max-w-2xl" open={open} onOpenChange={(v) => {
        setOpen(v);
        if (v && isMobile) setSidebarOpen(false);
      }}>
      <CommandInput
        placeholder={pendingCommand
          ? "Check the details, then confirm. Esc goes back."
          : actionIssue
          ? `What should happen to ${actionIssue.identifier ?? "this task"}? Type to find an agent`
          : "Search tasks, clients, documents, agents, memory..."}
        value={query}
        onValueChange={setQuery}
        onKeyDown={(event) => {
          if (pendingCommand) {
            if (event.key === "Escape" || event.key === "Backspace") {
              event.preventDefault();
              event.stopPropagation();
              leaveCommandPreview();
            }
            return;
          }
          if (actionIssue) {
            if (event.key === "Escape" || (event.key === "Backspace" && query.length === 0)) {
              event.preventDefault();
              event.stopPropagation();
              setActionIssue(null);
            }
            return;
          }
          if (event.key === "Tab" && !event.shiftKey) {
            const selectedId = document
              .querySelector('[cmdk-item][data-selected="true"]')
              ?.getAttribute("data-issue-id");
            const issue = selectedId ? visibleIssues.find((candidate) => candidate.id === selectedId) : undefined;
            if (issue) {
              event.preventDefault();
              openActionsFor(issue);
              return;
            }
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            goFullSearch();
            return;
          }
          if (event.key === "Enter" && showEmptyHint) {
            event.preventDefault();
            goFullSearch();
          }
        }}
      />
      <CommandList className="max-h-(--sz-480px)">
        {pendingCommand ? (
          <CommandPreviewPanel
            command={pendingCommand}
            lead={leadAgent}
            currentTaskRef={currentTaskRef}
            busy={runCommand.isPending}
            onConfirm={() => runCommand.mutate(pendingCommand)}
            onBack={leaveCommandPreview}
          />
        ) : actionIssue ? (
          <TaskQuickActions
            issue={actionIssue}
            query={searchQuery}
            agents={agents}
            currentUserId={currentUserId}
            busy={updateIssue.isPending}
            onBack={() => setActionIssue(null)}
            onOpen={() => go(`/issues/${actionIssue.identifier ?? actionIssue.id}`)}
            onUpdate={(patch, doneLabel) => updateIssue.mutate({ issue: actionIssue, patch, doneLabel })}
          />
        ) : (
        <>
        <CommandEmpty>
          {showSearchAll ? (
            <span>
              No quick task matches. Press{" "}
              <kbd className="rounded border border-border bg-muted px-1 py-0.5 text-(length:--text-nano)">↵</kbd>{" "}
              to <span className="font-medium">search all</span> or keep typing to refine.
            </span>
          ) : (
            "No results found."
          )}
        </CommandEmpty>

        {typedCommand ? (
          <CommandSuggestion
            command={typedCommand}
            lead={leadAgent}
            currentTaskRef={currentTaskRef}
            typed={searchQuery}
            onSelect={() => {
              // Clear the box so the confirm buttons are not filtered by the typed words.
              setCommandText(query);
              setPendingCommand(typedCommand);
              setQuery("");
            }}
          />
        ) : null}

        {showSearchAll ? (
          <CommandGroup heading="Search">
            <CommandItem
              value={`${SEARCH_ALL_VALUE} ${searchQuery}`}
              onSelect={goFullSearch}
              className="bg-accent/40 border border-accent data-[selected=true]:bg-accent/60"
              data-testid="command-search-all"
            >
              <Search className="mr-2 h-4 w-4" />
              <span className="flex-1 truncate">
                Search all for <span className="font-semibold">&ldquo;{searchQuery}&rdquo;</span>
              </span>
              <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
                <span>open full search</span>
                <kbd className="rounded border border-border bg-background px-1 py-0.5 text-(length:--text-nano)">↵</kbd>
              </span>
            </CommandItem>
            {!searchIsSaved ? (
              <CommandItem
                value={`__save-search ${searchQuery}`}
                onSelect={() => saveItem({ kind: "search", label: searchQuery, query: searchQuery }, "Search saved")}
                data-testid="command-save-search"
              >
                <Star className="mr-2 h-4 w-4" />
                <span className="flex-1 truncate">
                  Save this search: <span className="font-semibold">&ldquo;{searchQuery}&rdquo;</span>
                </span>
              </CommandItem>
            ) : null}
            {leadAgent ? (
              <CommandItem
                value={`__ask-everest ${searchQuery}`}
                onSelect={() => {
                  setOpen(false);
                  openAskEverest(searchQuery);
                }}
                data-testid="command-ask-everest"
              >
                <MessageCircle className="mr-2 h-4 w-4" />
                <span className="flex-1 truncate">
                  Ask {leadAgent.name}: <span className="font-semibold">&ldquo;{searchQuery}&rdquo;</span>
                </span>
              </CommandItem>
            ) : null}
          </CommandGroup>
        ) : null}

        {showSearchAll ? <CommandSeparator /> : null}

        {!showSearchAll && selectedCompanyId ? (
          <GlobalSearchEmptyState
            companyId={selectedCompanyId}
            userId={currentUserId}
            leadName={leadAgent?.name ?? null}
            saved={savedItems}
            onRemoveSaved={removeItem}
            onGo={go}
            onSearch={setQuery}
            onAsk={(question) => {
              setOpen(false);
              openAskEverest(question);
            }}
          />
        ) : null}

        <CommandGroup heading="Quick filters">
          {SEARCH_OPERATOR_QUICK_FILTERS.map((chip) => (
            <CommandItem
              key={chip}
              value={`quick-filter ${chip}`}
              onSelect={() => setQuery((current) => current.trim() ? `${current.trim()} ${chip}` : chip)}
              data-testid="command-filter-chip"
            >
              <Search className="mr-2 h-4 w-4" />
              <span className="font-mono text-xs">{chip}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        {showPromotedProjects && (
          <>
            <CommandGroup heading="Projects">
              {matchedProjects.map((project) => (
                <CommandItem
                  key={project.id}
                  value={`${searchQuery} ${project.name}`}
                  onSelect={() => go(projectUrl(project))}
                  data-testid="command-project-match"
                >
                  <Hexagon className="mr-2 h-4 w-4 shrink-0" />
                  <span className="min-w-0 truncate">{project.name}</span>
                  {project.description ? (
                    <span className="ml-2 hidden min-w-0 flex-1 truncate text-xs text-muted-foreground sm:inline">
                      {project.description}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        <CommandGroup heading="Actions">
          <CommandItem
            onSelect={() => {
              setOpen(false);
              openNewIssue();
            }}
          >
            <SquarePen className="mr-2 h-4 w-4" />
            Create new task
            <span className="ml-auto text-xs text-muted-foreground">C</span>
          </CommandItem>
          {onIssueDetail && (
            <CommandItem
              onSelect={() => {
                setOpen(false);
                window.dispatchEvent(new CustomEvent("paperclip:open-file-viewer"));
              }}
            >
              <FileCode2 className="mr-2 h-4 w-4" />
              Open file in this issue...
              <span className="ml-auto text-xs text-muted-foreground">g f</span>
            </CommandItem>
          )}
          <CommandItem
            onSelect={() => {
              setOpen(false);
              openNewAgent();
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            Create new agent
          </CommandItem>
          <CommandItem onSelect={() => go("/projects")}>
            <Plus className="mr-2 h-4 w-4" />
            Create new project
          </CommandItem>
          {!viewIsPinned ? (
            <CommandItem
              value="pin this page view save bookmark"
              onSelect={() => saveItem({ kind: "view", label: viewLabel(breadcrumbs, currentViewPath), path: currentViewPath }, "Page pinned")}
              data-testid="command-pin-view"
            >
              <Pin className="mr-2 h-4 w-4" />
              Pin this page to search
            </CommandItem>
          ) : null}
          <CommandItem
            value="keyboard shortcuts help keys"
            onSelect={() => {
              setOpen(false);
              openShortcutsSheet();
            }}
            data-testid="command-shortcuts"
          >
            <Keyboard className="mr-2 h-4 w-4" />
            Keyboard shortcuts
            <span className="ml-auto text-xs text-muted-foreground">?</span>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Pages">
          <CommandItem onSelect={() => go("/dashboard")}>
            <LayoutDashboard className="mr-2 h-4 w-4" />
            Dashboard
          </CommandItem>
          <CommandItem onSelect={() => go("/inbox")}>
            <Inbox className="mr-2 h-4 w-4" />
            Inbox
          </CommandItem>
          <CommandItem onSelect={() => go("/issues")}>
            <CircleDot className="mr-2 h-4 w-4" />
            Tasks
          </CommandItem>
          <CommandItem onSelect={() => go("/projects")}>
            <Hexagon className="mr-2 h-4 w-4" />
            Projects
          </CommandItem>
          <CommandItem onSelect={() => go("/goals")}>
            <Target className="mr-2 h-4 w-4" />
            Goals
          </CommandItem>
          <CommandItem onSelect={() => go("/agents")}>
            <Bot className="mr-2 h-4 w-4" />
            Agents
          </CommandItem>
          <CommandItem onSelect={() => go("/costs")}>
            <DollarSign className="mr-2 h-4 w-4" />
            Costs
          </CommandItem>
          <CommandItem onSelect={() => go("/activity")}>
            <History className="mr-2 h-4 w-4" />
            Activity
          </CommandItem>
        </CommandGroup>

        {visibleIssues.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Tasks">
              {visibleIssues.slice(0, taskLimit).map((issue) => (
                <CommandItem
                  key={issue.id}
                  value={
                    searchQuery.length > 0
                      ? `${searchQuery} ${issue.identifier ?? ""} ${issue.title}`
                      : undefined
                  }
                  onSelect={() => go(`/issues/${issue.identifier ?? issue.id}`)}
                  data-issue-id={issue.id}
                  className="group/task"
                >
                  <CircleDot className="mr-2 h-4 w-4" />
                  <span className="text-muted-foreground mr-2 font-mono text-xs">
                    {issue.identifier ?? issue.id.slice(0, 8)}
                  </span>
                  <span className="flex-1 truncate">{issue.title}</span>
                  <span className="ml-2 hidden shrink-0 text-xs text-muted-foreground sm:inline">
                    {plainTaskStatus(issue.status)}
                  </span>
                  {issue.assigneeAgentId && (() => {
                    const name = agentName(issue.assigneeAgentId);
                    return name ? <AgentIdentity agent={agents?.find((agent) => agent.id === issue.assigneeAgentId) ?? { id: issue.assigneeAgentId, name }} size="sm" className="ml-2 hidden sm:inline-flex" /> : null;
                  })()}
                  <button
                    type="button"
                    aria-label={`Actions for ${issue.identifier ?? issue.title}`}
                    title="Actions (Tab)"
                    data-testid="command-task-actions"
                    className="ml-1 inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/task:opacity-100 group-data-[selected=true]/task:opacity-100 pointer-coarse:opacity-100"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openActionsFor(issue);
                    }}
                  >
                    Actions
                    <ChevronRight className="h-3 w-3" />
                  </button>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {selectedCompanyId ? (
          <GlobalSearchSources
            companyId={selectedCompanyId}
            query={quickSearchQuery}
            onGo={go}
            excludeIssueIds={titleMatchIds}
          />
        ) : null}

        {agents.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Agents">
              {agents.slice(0, 10).map((agent) => (
                <CommandItem key={agent.id} onSelect={() => go(agentUrl(agent))}>
                  <Bot className="mr-2 h-4 w-4" />
                  {agent.name}
                  <span className="text-xs text-muted-foreground ml-2">{agent.role}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {projects.length > 0 && !showSearchAll && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Projects">
              {projects.slice(0, 10).map((project) => (
                <CommandItem key={project.id} onSelect={() => go(projectUrl(project))}>
                  <Hexagon className="mr-2 h-4 w-4" />
                  {project.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
        </>
        )}
      </CommandList>
    </CommandDialog>
  );
}

type PaletteAgent = { id: string; name: string; role?: string | null; status?: string | null };

/** Quick actions for one task: open, mark done, take it, or hand it to an agent. */
function TaskQuickActions({
  issue,
  query,
  agents,
  currentUserId,
  busy,
  onBack,
  onOpen,
  onUpdate,
}: {
  issue: Issue;
  query: string;
  agents: readonly PaletteAgent[];
  currentUserId: string | null;
  busy: boolean;
  onBack: () => void;
  onOpen: () => void;
  onUpdate: (patch: Record<string, unknown>, doneLabel: string) => void;
}) {
  const label = issue.identifier ?? "Task";
  const q = query.toLowerCase();
  const handOffAgents = agents
    .filter((agent) => agent.status !== "terminated" && agent.id !== issue.assigneeAgentId)
    .filter((agent) => !q || agent.name.toLowerCase().includes(q) || (agent.role ?? "").toLowerCase().includes(q))
    .slice(0, 8);
  const showTaskActions = !q;
  return (
    <>
      <CommandEmpty>No agent matches that name.</CommandEmpty>
      <CommandGroup heading={`${label}: ${issue.title}`}>
        {showTaskActions ? (
          <CommandItem value="__open" onSelect={onOpen} data-testid="command-action-open">
            <ExternalLink className="mr-2 h-4 w-4" />
            Open the task
          </CommandItem>
        ) : null}
        {showTaskActions && isOpenTaskStatus(issue.status) ? (
          <CommandItem
            value="__done"
            disabled={busy}
            onSelect={() => onUpdate({ status: "done" }, `${label} marked as done`)}
            data-testid="command-action-done"
          >
            <CheckCircle2 className="mr-2 h-4 w-4" />
            Mark as done
          </CommandItem>
        ) : null}
        {showTaskActions && currentUserId && issue.assigneeUserId !== currentUserId ? (
          <CommandItem
            value="__mine"
            disabled={busy}
            onSelect={() => onUpdate({ assigneeUserId: currentUserId, assigneeAgentId: null }, `${label} is now yours`)}
            data-testid="command-action-assign-me"
          >
            <UserRound className="mr-2 h-4 w-4" />
            Assign to me
          </CommandItem>
        ) : null}
      </CommandGroup>
      {handOffAgents.length > 0 ? (
        <>
          <CommandSeparator />
          <CommandGroup heading="Hand it to an agent">
            {handOffAgents.map((agent) => (
              <CommandItem
                key={agent.id}
                value={`__agent ${agent.id} ${agent.name}`}
                disabled={busy}
                onSelect={() =>
                  onUpdate({ assigneeAgentId: agent.id, assigneeUserId: null }, `${label} handed to ${agent.name}`)}
                data-testid="command-action-assign-agent"
              >
                <Bot className="mr-2 h-4 w-4" />
                Assign to {agent.name}
                {agent.role ? <span className="ml-2 text-xs text-muted-foreground">{agent.role}</span> : null}
              </CommandItem>
            ))}
          </CommandGroup>
        </>
      ) : null}
      <CommandSeparator />
      <CommandGroup>
        <CommandItem value="__back" onSelect={onBack} data-testid="command-actions-back">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to results
          <span className="ml-auto text-xs text-muted-foreground">⌫</span>
        </CommandItem>
      </CommandGroup>
    </>
  );
}
