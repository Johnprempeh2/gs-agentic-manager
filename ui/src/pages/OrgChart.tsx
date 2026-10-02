import { AgentAvatar } from "@/components/AgentAvatar";
import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { Link, useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { agentTeamsApi } from "../api/agentTeams";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl, cn, formatCents, issueUrl, relativeTime } from "../lib/utils";
import {
  CARD_H,
  CARD_W,
  ancestorIds,
  collectEdges,
  flattenLayout,
  flattenOrg,
  layoutBounds,
  layoutForest,
  layoutTeamGroups,
  type LayoutNode,
  type TeamBox,
} from "../lib/org-chart-layout";
import { groupAgentsByTeam, teamsByAgent } from "../lib/agent-teams";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentStatusCapsule } from "../components/StatusBadge";
import { ChevronDown, ChevronRight, Download, Maximize2, Minus, Network, Plus, Search, Upload } from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent, type AgentTeam, type CompactIssue } from "@greatstone/shared";
import { useCloudInstance } from "@/hooks/useCloudInstance";
import { useHiddenSettings } from "@/hooks/useHiddenSettings";
import { getAdapterLabel } from "../adapters/adapter-display-registry";

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;
/** Fit-to-screen never shrinks below this, so card text stays readable. */
const MIN_FIT_ZOOM = 0.6;
const FIT_PADDING = 40;
const TOUCH_MOVE_THRESHOLD = 6;
/** Zoom change per pixel of ctrl/⌘-scroll; small so trackpads zoom smoothly. */
const WHEEL_ZOOM_RATE = 0.0025;
/** Cap per-event delta so one mouse-wheel notch zooms ~12%, not 2x. */
const WHEEL_ZOOM_MAX_DELTA = 50;
const KEYBOARD_PAN_STEP = 80;
const OPEN_TASK_STATUSES = "todo,in_progress,in_review,blocked";
const SEARCH_RESULT_LIMIT = 6;

interface Point {
  x: number;
  y: number;
}

interface View extends Point {
  zoom: number;
}

interface TouchGesture {
  mode: "pan" | "pinch" | null;
  startPoint: Point;
  startView: View;
  startDistance: number;
  startCenter: Point;
  moved: boolean;
}

type ChartMode = "reporting" | "teams";

interface AgentActivity {
  statusKey: string;
  statusLabel: string;
  reason: string | null;
  currentTask: CompactIssue | null;
  openTasks: CompactIssue[];
}

function clampZoom(value: number): number {
  return Math.min(Math.max(value, MIN_ZOOM), MAX_ZOOM);
}

function fitChartToViewport(
  containerWidth: number,
  containerHeight: number,
  bounds: { width: number; height: number },
): View | null {
  if (containerWidth <= FIT_PADDING || containerHeight <= FIT_PADDING) return null;

  const scaleX = (containerWidth - FIT_PADDING) / bounds.width;
  const scaleY = (containerHeight - FIT_PADDING) / bounds.height;
  const zoom = clampZoom(Math.max(Math.min(scaleX, scaleY, 1), MIN_FIT_ZOOM));
  const chartWidth = bounds.width * zoom;
  const chartHeight = bounds.height * zoom;

  // A chart too big to fit at a readable size is pinned to the top, centred
  // across, instead of shrunk to unreadable.
  return {
    zoom,
    x: (containerWidth - chartWidth) / 2,
    y: chartHeight > containerHeight ? FIT_PADDING / 2 : (containerHeight - chartHeight) / 2,
  };
}

/** Normalise a wheel delta to pixels across deltaMode line/page devices. */
function wheelPixels(delta: number, mode: number, pageSize: number): number {
  if (mode === 1) return delta * 16;
  if (mode === 2) return delta * pageSize;
  return delta;
}

function touchPoint(touch: React.Touch): Point {
  return { x: touch.clientX, y: touch.clientY };
}

function touchDistance(a: React.Touch, b: React.Touch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function touchCenter(a: React.Touch, b: React.Touch, container: HTMLDivElement): Point {
  const rect = container.getBoundingClientRect();
  return {
    x: (a.clientX + b.clientX) / 2 - rect.left,
    y: (a.clientY + b.clientY) / 2 - rect.top,
  };
}

const pauseReasonLabels: Record<string, string> = {
  manual: "paused by a person",
  budget: "budget limit reached",
  system: "paused by the system",
  company_archived: "company archived",
  import: "paused after import",
};

const statusLabels: Record<string, string> = {
  running: "Running",
  active: "Idle",
  idle: "Idle",
  paused: "Paused",
  error: "Error",
  pending_approval: "Waiting for approval",
  terminated: "Stopped",
};

function describeStatus(status: string, agent: Agent | undefined, running: boolean) {
  if (running && status !== "paused" && status !== "error") {
    return { statusKey: "running", statusLabel: statusLabels.running!, reason: null };
  }
  let reason: string | null = null;
  if (status === "paused") reason = pauseReasonLabels[agent?.pauseReason ?? ""] ?? null;
  if (status === "error") reason = agent?.errorReason?.trim() || "see agent page";
  return { statusKey: status, statusLabel: statusLabels[status] ?? status.replace(/_/g, " "), reason };
}

function taskLabel(task: CompactIssue): string {
  return task.identifier ? `${task.identifier} ${task.title}` : task.title;
}

// ── Main component ──────────────────────────────────────────────────────

export interface OrgChartProps {
  /** Pre-filtered tree for embedding the chart in another collection page. */
  orgTree?: OrgNode[];
  /** Agent records paired with a pre-filtered embedded tree. */
  agents?: Agent[];
  /** Hides page-level actions and breadcrumb ownership. */
  embedded?: boolean;
}

export function OrgChart({ orgTree: providedOrgTree, agents: providedAgents, embedded = false }: OrgChartProps = {}) {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  // Import is floored server-side on cloud-managed instances (403 cloud_managed), so the
  // button is hidden rather than dead-ending. Export stays available. Both
  // buttons also respect the operator-hidden settings registry.
  const isCloud = Boolean(useCloudInstance());
  const { hidden: hiddenSettings } = useHiddenSettings();
  const showImport = !isCloud && !hiddenSettings.has("company.import");
  const showExport = !hiddenSettings.has("company.export");

  const { data: queriedOrgTree, isLoading } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId && providedOrgTree === undefined,
  });

  const { data: queriedAgents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && providedAgents === undefined,
  });

  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(selectedCompanyId!), "org-chart"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const { data: openIssues } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "org-chart-open"],
    queryFn: () => issuesApi.listCompact(selectedCompanyId!, { status: OPEN_TASK_STATUSES, limit: 1000 }),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  // Teams (GRE-436) colour the cards and drive the "group by team" view.
  // They never change reporting lines.
  const { data: teams } = useQuery({
    queryKey: queryKeys.agentTeams.list(selectedCompanyId!),
    queryFn: () => agentTeamsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const orgTree = providedOrgTree ?? queriedOrgTree;
  const agents = providedAgents ?? queriedAgents;
  const teamsForAgent = useMemo(() => teamsByAgent(teams ?? []), [teams]);
  const hasTeams = (teams?.length ?? 0) > 0;
  const [chartMode, setChartMode] = useState<ChartMode>("reporting");
  const mode: ChartMode = hasTeams ? chartMode : "reporting";

  /** Manager and report count from the real reporting lines, whatever the view. */
  const orgInfo = useMemo(() => {
    const info = new Map<string, { managerName: string | null; reportCount: number }>();
    const walk = (node: OrgNode, managerName: string | null) => {
      info.set(node.id, { managerName, reportCount: node.reports.length });
      node.reports.forEach((child) => walk(child, node.name));
    };
    (orgTree ?? []).forEach((root) => walk(root, null));
    return info;
  }, [orgTree]);

  const agentMap = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents ?? []) m.set(a.id, a);
    return m;
  }, [agents]);

  const activityByAgent = useMemo(() => {
    const runIssueByAgent = new Map<string, string | null>();
    for (const run of liveRuns ?? []) {
      if (run.status !== "running" && run.status !== "queued") continue;
      if (!runIssueByAgent.has(run.agentId) || !runIssueByAgent.get(run.agentId)) {
        runIssueByAgent.set(run.agentId, run.issueId ?? null);
      }
    }
    const tasksByAgent = new Map<string, CompactIssue[]>();
    for (const issue of openIssues ?? []) {
      if (!issue.assigneeAgentId) continue;
      const list = tasksByAgent.get(issue.assigneeAgentId) ?? [];
      list.push(issue);
      tasksByAgent.set(issue.assigneeAgentId, list);
    }
    const result = new Map<string, AgentActivity>();
    for (const node of flattenOrg(orgTree ?? [])) {
      const agent = agentMap.get(node.id);
      const running = runIssueByAgent.has(node.id);
      const openTasks = tasksByAgent.get(node.id) ?? [];
      const runIssueId = runIssueByAgent.get(node.id);
      const currentTask =
        (runIssueId ? openTasks.find((t) => t.id === runIssueId) : undefined) ??
        openTasks.find((t) => t.status === "in_progress") ??
        null;
      result.set(node.id, {
        ...describeStatus(agent?.status ?? node.status, agent, running),
        currentTask,
        openTasks,
      });
    }
    return result;
  }, [orgTree, agentMap, liveRuns, openIssues]);

  useEffect(() => {
    if (!embedded) setBreadcrumbs([{ label: "Org Chart" }]);
  }, [embedded, setBreadcrumbs]);

  // Layout computation
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const teamLayout = useMemo(
    () => (mode === "teams" ? layoutTeamGroups(groupAgentsByTeam(flattenOrg(orgTree ?? []), teams ?? [])) : null),
    [mode, orgTree, teams],
  );
  const layout = useMemo(
    () => teamLayout?.nodes ?? layoutForest(orgTree ?? [], collapsed),
    [teamLayout, orgTree, collapsed],
  );
  const teamBoxes: TeamBox[] = teamLayout?.boxes ?? [];
  const allNodes = useMemo(() => flattenLayout(layout), [layout]);
  /** Keyed by card key: an agent in two teams has two cards in the team view. */
  const nodeById = useMemo(() => new Map(allNodes.map((n) => [n.key, n])), [allNodes]);
  const edges = useMemo(() => collectEdges(layout), [layout]);
  const bounds = useMemo(() => layoutBounds(allNodes), [allNodes]);
  const hasChart = allNodes.length > 0;

  // Pan & zoom state
  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, view });
  const touchGesture = useRef<TouchGesture>({
    mode: null,
    startPoint: { x: 0, y: 0 },
    startView: view,
    startDistance: 0,
    startCenter: { x: 0, y: 0 },
    moved: false,
  });
  const suppressNextCardClick = useRef(false);
  const suppressClickTimerRef = useRef<number | null>(null);

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const [query, setQuery] = useState("");

  useEffect(() => {
    return () => {
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current);
      }
    };
  }, []);

  // Center the chart on first load
  const hasInitialized = useRef(false);
  useEffect(() => {
    hasInitialized.current = false;
  }, [orgTree, mode]);

  useEffect(() => {
    if (hasInitialized.current || allNodes.length === 0 || !containerRef.current) return;
    const container = containerRef.current;
    const fitted = fitChartToViewport(container.clientWidth, container.clientHeight, bounds);
    if (!fitted) return;

    hasInitialized.current = true;
    setView(fitted);
  }, [allNodes, bounds]);

  const zoomTowardPoint = useCallback((nextZoom: number, point: Point) => {
    setView((current) => {
      const zoom = clampZoom(nextZoom);
      const scale = zoom / current.zoom;
      return {
        zoom,
        x: point.x - scale * (point.x - current.x),
        y: point.y - scale * (point.y - current.y),
      };
    });
  }, []);

  // Wheel: scroll / two-finger swipe pans; ctrl/⌘ + scroll (and trackpad
  // pinch, which browsers report as ctrl+wheel) zooms. Bound natively as
  // non-passive so preventDefault really stops the page scrolling under it.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const dx = wheelPixels(e.deltaX, e.deltaMode, container.clientWidth);
      const dy = wheelPixels(e.deltaY, e.deltaMode, container.clientHeight);
      if (e.ctrlKey || e.metaKey) {
        const delta = Math.max(-WHEEL_ZOOM_MAX_DELTA, Math.min(WHEEL_ZOOM_MAX_DELTA, dy));
        setView((current) => {
          const zoom = clampZoom(current.zoom * Math.exp(-delta * WHEEL_ZOOM_RATE));
          const scale = zoom / current.zoom;
          const px = e.clientX - rect.left;
          const py = e.clientY - rect.top;
          return { zoom, x: px - scale * (px - current.x), y: py - scale * (py - current.y) };
        });
        return;
      }
      // Shift + mouse wheel scrolls sideways, like a normal page.
      const panX = e.shiftKey && dx === 0 ? dy : dx;
      const panY = e.shiftKey && dx === 0 ? 0 : dy;
      setView((current) => ({ ...current, x: current.x - panX, y: current.y - panY }));
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
    // Re-bind when the viewport mounts after loading/empty states.
  }, [hasChart]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-org-card], [data-org-control]")) return;
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, view: viewRef.current };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    const start = dragStart.current;
    setView({ ...start.view, x: start.view.x + e.clientX - start.x, y: start.view.y + e.clientY - start.y });
  }, [dragging]);

  const handleMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  const fitToScreen = useCallback(() => {
    if (!containerRef.current) return;
    const fitted = fitChartToViewport(
      containerRef.current.clientWidth,
      containerRef.current.clientHeight,
      bounds,
    );
    if (fitted) setView(fitted);
  }, [bounds]);

  /** Pan so a card is centred; keeps the current zoom unless one is given. */
  const centerOn = useCallback((node: LayoutNode, zoomOverride?: number) => {
    const container = containerRef.current;
    if (!container) return;
    setView((current) => {
      const zoom = clampZoom(zoomOverride ?? current.zoom);
      return {
        zoom,
        x: container.clientWidth / 2 - (node.x + CARD_W / 2) * zoom,
        y: container.clientHeight / 2 - (node.y + CARD_H / 2) * zoom,
      };
    });
  }, []);

  /** Pan only if the card is partly off-screen. */
  const ensureVisible = useCallback((node: LayoutNode) => {
    const container = containerRef.current;
    if (!container) return;
    const { x, y, zoom } = viewRef.current;
    const left = x + node.x * zoom;
    const top = y + node.y * zoom;
    const offscreen =
      left < 0 ||
      top < 0 ||
      left + CARD_W * zoom > container.clientWidth ||
      top + CARD_H * zoom > container.clientHeight;
    if (offscreen) centerOn(node);
  }, [centerOn]);

  const toggleCollapsed = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Expand every collapsed manager above an agent, then centre and focus it. */
  const jumpTo = useCallback((id: string) => {
    const ancestors = ancestorIds(orgTree ?? [], id) ?? [];
    setCollapsed((current) => {
      if (!ancestors.some((a) => current.has(a))) return current;
      const next = new Set(current);
      ancestors.forEach((a) => next.delete(a));
      return next;
    });
    setPendingFocusId(id);
  }, [orgTree]);

  useEffect(() => {
    if (!pendingFocusId) return;
    const node = allNodes.find((n) => n.id === pendingFocusId);
    if (!node) return;
    setPendingFocusId(null);
    setFocusedId(node.key);
    centerOn(node, Math.max(viewRef.current.zoom, 1));
    cardRefs.current.get(node.key)?.focus({ preventScroll: true });
  }, [pendingFocusId, allNodes, centerOn]);

  const moveFocus = useCallback((key: string) => {
    const node = nodeById.get(key);
    if (!node) return;
    setFocusedId(key);
    ensureVisible(node);
    cardRefs.current.get(key)?.focus({ preventScroll: true });
  }, [nodeById, ensureVisible]);

  const siblingsOf = useCallback((node: LayoutNode): LayoutNode[] => {
    if (!node.parentId) return layout;
    return nodeById.get(node.parentId)?.children ?? [node];
  }, [layout, nodeById]);

  const handleCardKeyDown = useCallback((e: React.KeyboardEvent, node: LayoutNode) => {
    const siblings = siblingsOf(node);
    const index = siblings.findIndex((s) => s.key === node.key);
    let target: LayoutNode | undefined;
    switch (e.key) {
      case "ArrowUp":
        target = node.parentId ? nodeById.get(node.parentId) : undefined;
        break;
      case "ArrowDown":
        target = node.children[0];
        break;
      case "ArrowLeft":
        target = siblings[index - 1];
        break;
      case "ArrowRight":
        target = siblings[index + 1];
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        setSelectedId(node.id);
        return;
      default:
        return;
    }
    e.preventDefault();
    if (target) moveFocus(target.key);
  }, [siblingsOf, nodeById, moveFocus]);

  // Arrow keys on the empty canvas pan it.
  const handleViewportKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    const step: Record<string, Point> = {
      ArrowUp: { x: 0, y: KEYBOARD_PAN_STEP },
      ArrowDown: { x: 0, y: -KEYBOARD_PAN_STEP },
      ArrowLeft: { x: KEYBOARD_PAN_STEP, y: 0 },
      ArrowRight: { x: -KEYBOARD_PAN_STEP, y: 0 },
    };
    const delta = step[e.key];
    if (!delta) return;
    e.preventDefault();
    setView((current) => ({ ...current, x: current.x + delta.x, y: current.y + delta.y }));
  }, []);

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return flattenOrg(orgTree ?? [])
      .filter((n) => {
        const agent = agentMap.get(n.id);
        return [n.name, agent?.title, roleLabel(n.role)].some((v) => v?.toLowerCase().includes(q));
      })
      .slice(0, SEARCH_RESULT_LIMIT);
  }, [query, orgTree, agentMap]);

  const pickSearchResult = useCallback((id: string) => {
    setQuery("");
    jumpTo(id);
  }, [jumpTo]);

  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const startView = viewRef.current;
    if (e.touches.length >= 2 && containerRef.current) {
      const [first, second] = [e.touches[0]!, e.touches[1]!];
      touchGesture.current = {
        mode: "pinch",
        startPoint: { x: 0, y: 0 },
        startView,
        startDistance: touchDistance(first, second),
        startCenter: touchCenter(first, second, containerRef.current),
        moved: false,
      };
      return;
    }

    const touch = e.touches[0];
    if (!touch) return;
    touchGesture.current = {
      mode: "pan",
      startPoint: touchPoint(touch),
      startView,
      startDistance: 0,
      startCenter: { x: 0, y: 0 },
      moved: false,
    };
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container || !touchGesture.current.mode) return;

    if (e.touches.length >= 2) {
      const [first, second] = [e.touches[0]!, e.touches[1]!];
      const distance = touchDistance(first, second);
      const center = touchCenter(first, second, container);

      if (touchGesture.current.mode !== "pinch" || touchGesture.current.startDistance === 0) {
        touchGesture.current = {
          mode: "pinch",
          startPoint: { x: 0, y: 0 },
          startView: viewRef.current,
          startDistance: distance,
          startCenter: center,
          moved: false,
        };
        return;
      }

      const gesture = touchGesture.current;
      const start = gesture.startView;
      const zoom = clampZoom(start.zoom * (distance / gesture.startDistance));
      const scale = zoom / start.zoom;
      const dx = center.x - gesture.startCenter.x;
      const dy = center.y - gesture.startCenter.y;
      gesture.moved =
        gesture.moved ||
        Math.abs(distance - gesture.startDistance) > TOUCH_MOVE_THRESHOLD ||
        Math.hypot(dx, dy) > TOUCH_MOVE_THRESHOLD;
      setView({
        zoom,
        x: center.x - scale * (gesture.startCenter.x - start.x),
        y: center.y - scale * (gesture.startCenter.y - start.y),
      });
      return;
    }

    const touch = e.touches[0];
    if (!touch || touchGesture.current.mode !== "pan") return;
    const gesture = touchGesture.current;
    const dx = touch.clientX - gesture.startPoint.x;
    const dy = touch.clientY - gesture.startPoint.y;
    gesture.moved = gesture.moved || Math.hypot(dx, dy) > TOUCH_MOVE_THRESHOLD;
    setView({ ...gesture.startView, x: gesture.startView.x + dx, y: gesture.startView.y + dy });
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (touchGesture.current.moved) {
      suppressNextCardClick.current = true;
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current);
      }
      suppressClickTimerRef.current = window.setTimeout(() => {
        suppressNextCardClick.current = false;
        suppressClickTimerRef.current = null;
      }, 400);
    }
    touchGesture.current = { ...touchGesture.current, mode: null, startDistance: 0, moved: false };
  }, []);

  if (!selectedCompanyId) {
    return <EmptyState icon={Network} message="Select an organization to view the org chart." />;
  }

  if (providedOrgTree === undefined && isLoading) {
    return <PageSkeleton variant="org-chart" />;
  }

  if (orgTree && orgTree.length === 0) {
    return (
      <EmptyState icon={Network} message="No organizational hierarchy defined." action="New agent" onAction={() => navigate("/agents/new")} />
    );
  }

  const tabStopKey = focusedId && nodeById.has(focusedId) ? focusedId : allNodes[0]?.key;
  const selectedNode = selectedId ? allNodes.find((n) => n.id === selectedId) ?? null : null;
  const controlButton =
    "flex size-9 items-center justify-center rounded border border-border bg-background text-sm transition-colors hover:bg-accent sm:size-7";

  return (
    <div
      className={embedded
        ? "flex min-h-(--sz-420px) flex-1 flex-col md:min-h-0"
        : "flex h-(--sz-calc-38) min-h-(--sz-420px) flex-col md:h-full md:min-h-0"}
    >
      {!embedded && (showImport || showExport) ? (
        <div className="mb-2 flex shrink-0 flex-wrap items-center justify-start gap-2">
        {showImport ? (
          <Link to="/company/import">
            <Button variant="outline" size="sm">
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              Import organization
            </Button>
          </Link>
        ) : null}
        {showExport ? (
          <Link to="/company/export">
            <Button variant="outline" size="sm">
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Export organization
            </Button>
          </Link>
        ) : null}
        </div>
      ) : null}
      <div
        ref={containerRef}
        data-testid="org-chart-viewport"
        role="application"
        aria-label="Org chart. Scroll to move, Ctrl or Command and scroll to zoom, arrow keys to move between agents."
        tabIndex={-1}
        className="w-full flex-1 min-h-0 overflow-hidden relative bg-muted/20 border border-border rounded-lg focus-visible:outline-none"
        style={{
          cursor: dragging ? "grabbing" : "grab",
          touchAction: "none",
          overscrollBehavior: "contain",
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onKeyDown={handleViewportKeyDown}
        // Focusing a card can scroll an overflow-hidden box; the chart moves by transform only.
        onScroll={(e) => {
          e.currentTarget.scrollTop = 0;
          e.currentTarget.scrollLeft = 0;
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        {/* Search */}
        <div data-org-control className="absolute top-3 left-3 right-14 z-raised sm:right-auto sm:w-56">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && searchResults[0]) {
                  e.preventDefault();
                  pickSearchResult(searchResults[0].id);
                } else if (e.key === "Escape") {
                  setQuery("");
                }
              }}
              placeholder="Find an agent"
              aria-label="Find an agent"
              className="h-8 bg-background pl-8 text-sm"
            />
          </div>
          {query.trim() ? (
            <ul
              role="listbox"
              aria-label="Matching agents"
              className="mt-1 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
            >
              {searchResults.length === 0 ? (
                <li className="px-3 py-2 text-sm text-muted-foreground">No agent matches</li>
              ) : (
                searchResults.map((n) => (
                  <li key={n.id} role="option" aria-selected={false}>
                    <button
                      type="button"
                      className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                      onClick={() => pickSearchResult(n.id)}
                    >
                      <span className="truncate text-sm font-medium">{n.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {agentMap.get(n.id)?.title ?? roleLabel(n.role)}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          ) : null}
        </div>

        {/* Zoom controls */}
        <div data-org-control className="absolute top-3 right-3 z-raised flex flex-col gap-1.5">
          <button
            type="button"
            className={controlButton}
            onClick={() => {
              const container = containerRef.current;
              if (container) zoomTowardPoint(view.zoom * 1.2, { x: container.clientWidth / 2, y: container.clientHeight / 2 });
            }}
            title="Zoom in"
            aria-label="Zoom in"
          >
            <Plus className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          </button>
          <button
            type="button"
            className={controlButton}
            onClick={() => {
              const container = containerRef.current;
              if (container) zoomTowardPoint(view.zoom * 0.8, { x: container.clientWidth / 2, y: container.clientHeight / 2 });
            }}
            title="Zoom out"
            aria-label="Zoom out"
          >
            <Minus className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          </button>
          <button
            type="button"
            className={controlButton}
            onClick={fitToScreen}
            title="Fit to screen"
            aria-label="Fit chart to screen"
          >
            <Maximize2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          </button>
        </div>

        {hasTeams ? (
          <div
            data-org-control
            role="group"
            aria-label="Chart view"
            className="absolute bottom-3 left-3 z-raised flex overflow-hidden rounded border border-border bg-background text-xs"
          >
            {([["reporting", "Reporting lines"], ["teams", "Group by team"]] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                className={cn(
                  "h-9 px-3 transition-colors hover:bg-accent sm:h-7",
                  mode === value && "bg-accent font-medium text-foreground",
                )}
                onClick={() => setChartMode(value)}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}

        {/* SVG layer for edges */}
        <svg data-testid="org-chart-edges" className="absolute inset-0 pointer-events-none" style={{ width: "100%", height: "100%" }}>
          <g transform={`translate(${view.x}, ${view.y}) scale(${view.zoom})`}>
            {edges.map(({ parent, child, path }) => (
              <path key={`${parent.id}-${child.id}`} d={path} fill="none" stroke="var(--border)" strokeWidth={1.5} />
            ))}
          </g>
        </svg>

        {/* Card layer */}
        <div
          data-testid="org-chart-card-layer"
          className="absolute inset-0"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
            transformOrigin: "0 0",
          }}
        >
          {teamBoxes.map((box) => (
            <TeamBoxFrame key={box.key} box={box} leadName={box.team?.leadAgentId ? agentMap.get(box.team.leadAgentId)?.name : undefined} />
          ))}
          {allNodes.map((node) => {
            const agent = agentMap.get(node.id);
            const nodeTeams = teamsForAgent.get(node.id) ?? [];
            const teamNames = nodeTeams.map((t) => t.name).join(", ");
            const activity = activityByAgent.get(node.id);
            const title = agent?.title ?? roleLabel(node.role);
            const status = activity
              ? `${activity.statusLabel}${activity.reason ? ` · ${activity.reason}` : ""}`
              : node.status;
            const openCount = activity?.openTasks.length ?? 0;

            return (
              <Card
                key={node.key}
                ref={(el: HTMLDivElement | null) => {
                  if (el) cardRefs.current.set(node.key, el);
                  else cardRefs.current.delete(node.key);
                }}
                data-org-card
                data-agent-id={node.id}
                role="button"
                tabIndex={node.key === tabStopKey ? 0 : -1}
                aria-label={`${node.name}, ${title}, ${status}${teamNames ? `, teams: ${teamNames}` : ""}`}
                interactive
                className={cn(
                  "absolute gap-0 overflow-hidden py-0 select-none",
                  node.key === focusedId && "ring-2 ring-ring",
                )}
                style={{ left: node.x, top: node.y, width: CARD_W, height: CARD_H }}
                onFocus={() => setFocusedId(node.key)}
                onKeyDown={(e) => handleCardKeyDown(e, node)}
                onClick={() => setSelectedId(node.id)}
                onClickCapture={(e) => {
                  if (!suppressNextCardClick.current) return;
                  suppressNextCardClick.current = false;
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                {nodeTeams.length > 0 ? <TeamStripe teams={nodeTeams} /> : null}
                <div className="flex h-full flex-col gap-1.5 px-3.5 py-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
                      <AgentAvatar agent={agent} size={16} className="h-4 w-4 text-foreground/70" />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-semibold leading-tight text-foreground" title={node.name}>
                        {node.name}
                      </span>
                      <span className="truncate text-xs leading-tight text-muted-foreground" title={title}>
                        {title}
                      </span>
                    </div>
                  </div>
                  <div className="flex min-w-0 items-center gap-1.5 text-xs" data-testid="org-card-status">
                    <AgentStatusCapsule status={activity?.statusKey ?? node.status} />
                    <span className="truncate text-foreground" title={status}>{status}</span>
                  </div>
                  <div className="truncate text-xs text-muted-foreground" title={activity?.currentTask ? taskLabel(activity.currentTask) : undefined}>
                    {activity?.currentTask ? (
                      <>
                        <span className="font-mono text-foreground/80">{activity.currentTask.identifier}</span>{" "}
                        {activity.currentTask.title}
                      </>
                    ) : (
                      "No current task"
                    )}
                  </div>
                  <div className="mt-auto flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="truncate">
                      {openCount} open · {agent?.lastHeartbeatAt ? `ran ${relativeTime(agent.lastHeartbeatAt)}` : "never ran"}
                    </span>
                    {node.reportCount > 0 ? (
                      <button
                        type="button"
                        data-org-toggle
                        className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-expanded={!node.collapsed}
                        aria-label={`${node.collapsed ? "Expand" : "Collapse"} ${node.name}'s ${node.reportCount} reports`}
                        title={node.collapsed ? "Show reports" : "Hide reports"}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleCollapsed(node.id);
                        }}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        {node.collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        {node.reportCount}
                      </button>
                    ) : null}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      </div>

      <Sheet open={selectedNode !== null} onOpenChange={(open) => !open && setSelectedId(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
          {selectedNode ? (
            <AgentPanel
              node={selectedNode}
              agent={agentMap.get(selectedNode.id)}
              activity={activityByAgent.get(selectedNode.id)}
              managerName={orgInfo.get(selectedNode.id)?.managerName ?? null}
              reportCount={orgInfo.get(selectedNode.id)?.reportCount ?? 0}
              teams={teamsForAgent.get(selectedNode.id) ?? []}
              onOpenAgent={(path) => navigate(path)}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function AgentPanel({
  node,
  agent,
  activity,
  managerName,
  reportCount,
  teams,
  onOpenAgent,
}: {
  node: LayoutNode;
  agent: Agent | undefined;
  activity: AgentActivity | undefined;
  managerName: string | null;
  reportCount: number;
  teams: AgentTeam[];
  onOpenAgent: (path: string) => void;
}) {
  const title = agent?.title ?? roleLabel(node.role);
  const rows: Array<[string, React.ReactNode]> = [
    ["Last run", agent?.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "Never"],
    [
      "Spend this month",
      agent
        ? `${formatCents(agent.spentMonthlyCents)}${agent.budgetMonthlyCents > 0 ? ` of ${formatCents(agent.budgetMonthlyCents)}` : ""}`
        : "—",
    ],
    ["Runs on", agent ? getAdapterLabel(agent.adapterType) : "—"],
    ["Reports to", managerName ?? "No one"],
    ["Direct reports", String(reportCount)],
    [
      "Teams",
      teams.length > 0 ? (
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          {teams.map((team) => (
            <span key={team.id} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: team.color }} />
              {team.name}
            </span>
          ))}
        </span>
      ) : "None",
    ],
  ];

  return (
    <>
      <SheetHeader className="pr-10">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
            <AgentAvatar agent={agent} size={20} className="h-5 w-5 text-foreground/70" />
          </div>
          <div className="min-w-0">
            <SheetTitle className="truncate">{node.name}</SheetTitle>
            <SheetDescription className="truncate">{title}</SheetDescription>
          </div>
        </div>
      </SheetHeader>
      <div className="flex flex-col gap-5 px-4 pb-4 text-sm">
        <div className="flex items-start gap-2">
          <AgentStatusCapsule status={activity?.statusKey ?? node.status} />
          <div className="min-w-0">
            <div className="font-medium">{activity?.statusLabel ?? node.status}</div>
            {activity?.reason ? <div className="break-words text-muted-foreground">{activity.reason}</div> : null}
          </div>
        </div>

        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Current task</h3>
          {activity?.currentTask ? (
            <Link to={issueUrl(activity.currentTask)} className="break-words hover:underline">
              {taskLabel(activity.currentTask)}
            </Link>
          ) : (
            <span className="text-muted-foreground">No current task</span>
          )}
        </section>

        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Open tasks ({activity?.openTasks.length ?? 0})
          </h3>
          {activity && activity.openTasks.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {activity.openTasks.slice(0, 8).map((task) => (
                <li key={task.id} className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 text-xs text-muted-foreground">{task.status.replace(/_/g, " ")}</span>
                  <Link to={issueUrl(task)} className="truncate hover:underline" title={taskLabel(task)}>
                    {taskLabel(task)}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-muted-foreground">None</span>
          )}
        </section>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-words">{value}</dd>
            </div>
          ))}
        </dl>

        {agent?.capabilities ? (
          <section className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Capabilities</h3>
            <p className="whitespace-pre-line break-words text-muted-foreground">{agent.capabilities}</p>
          </section>
        ) : null}

        <Button onClick={() => onOpenAgent(agent ? agentUrl(agent) : `/agents/${node.id}`)}>Open agent page</Button>
      </div>
    </>
  );
}

/** Thin colour bar across the top of a card, one segment per team. */
function TeamStripe({ teams }: { teams: AgentTeam[] }) {
  return (
    <div
      data-testid="org-card-teams"
      title={`Teams: ${teams.map((t) => t.name).join(", ")}`}
      className="absolute inset-x-0 top-0 flex h-1"
    >
      {teams.map((team) => (
        <span key={team.id} className="flex-1" style={{ backgroundColor: team.color }} />
      ))}
    </div>
  );
}

/** A coloured box behind one team's cards in the "group by team" view. */
function TeamBoxFrame({ box, leadName }: { box: TeamBox; leadName: string | undefined }) {
  const color = box.team?.color;
  return (
    <div
      data-testid="org-team-box"
      data-team-id={box.key}
      className={cn(
        "absolute rounded-xl border-2",
        !color && "border-dashed border-border bg-muted/30",
      )}
      // Team colours are 6-digit hex, so a 2-digit alpha suffix tints the fill.
      style={{
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
        ...(color ? { borderColor: color, backgroundColor: `${color}14` } : {}),
      }}
    >
      <div className="flex h-9 min-w-0 items-center gap-2 px-4 text-sm">
        {color ? <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} /> : null}
        <span className="truncate font-semibold">{box.team?.name ?? "No team"}</span>
        {leadName ? <span className="truncate text-xs text-muted-foreground">Lead: {leadName}</span> : null}
      </div>
    </div>
  );
}

const roleLabels: Record<string, string> = AGENT_ROLE_LABELS;

function roleLabel(role: string): string {
  return roleLabels[role] ?? role;
}
