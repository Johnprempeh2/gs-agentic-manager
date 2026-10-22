import {
  Inbox,
  HandHelping,
  ListChecks,
  CircleCheck,
  Target,
  Landmark,
  LayoutDashboard,
  History,
  Search,
  SquarePen,
  Boxes,
  Repeat,
  Layers,
  Microscope,
  Building2,
  GitBranch,
  Package,
  Settings,
  FolderOpen,
  Unplug,
  MessagesSquare,
  MessageCircle,
  LayoutGrid,
  UserCheck,
  Users,
  Rocket,
  CreditCard,
  FileCheck2,
  ImageIcon,
  Brain,
  Workflow,
  Globe,
  Radar,
  Palette,
  ArrowUp,
  ArrowDown,
  RotateCcw,
  GripVertical,
  Eye,
  EyeOff,
  Pin,
  PinOff,
  Ellipsis,
  SlidersHorizontal,
  FolderInput,
  type LucideIcon,
  CalendarDays,
  Trophy,
  Newspaper,
  GraduationCap,
  Sparkles,
} from "lucide-react";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { SidebarSection, type SidebarSectionMenuAction } from "./SidebarSection";
import { useSidebarSectionOrder } from "../hooks/useSidebarSectionOrder";
import { useSidebarLayout } from "../hooks/useSidebarLayout";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarStarredProjects } from "./SidebarStarredProjects";
import { SidebarStarredPipelines } from "./SidebarStarredPipelines";
import { SidebarAgentChats } from "./SidebarAgentChats";
import { SidebarTeamChats } from "./SidebarTeamChats";
import { useTeamChatEnabled } from "@/hooks/useTeamChatEnabled";
import { useAgentChatEnabled } from "@/hooks/useAgentChatEnabled";
import { SidebarFollowing } from "./SidebarFollowing";
import { SidebarRecentTasks } from "./SidebarRecentTasks";
import { useDialogActions } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { issuesApi } from "../api/issues";
import { SidebarActiveProvider, sidebarActiveCandidates } from "../lib/sidebar-active";
import { useDecisionsCount } from "../hooks/useDecisionsFeed";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { useLiveAgents } from "../hooks/useLiveAgents";
import { useMemoryEnabled } from "../hooks/useMemoryEnabled";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";
import {
  SIDEBAR_SECTION_IDS,
  moveSidebarItem,
  moveSidebarItemBy,
  setSidebarItemHidden,
  setSidebarItemPinned,
  setSidebarSectionOpen,
} from "../lib/sidebar-layout";
import { useLocation } from "@/lib/router";
import { PluginSlotOutlet } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { SidebarBrandSignature } from "./SidebarBrandSignature";
import { SidebarReleaseFooter } from "./SidebarReleaseFooter";
import { useCanRelease } from "../hooks/useReleases";
import { useHasBillingAccount } from "../hooks/useBillingAccount";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";
import { SidebarAskEverest } from "./MobileEverestButton";
import { primarySidebarStyles } from "./primary-sidebar-styles";
import { useWhatsNewUnseen } from "../lib/whats-new";

/** One sidebar destination. `node` is null while its feature switch is off: it then shows nowhere. */
interface SidebarItemDef {
  label: string;
  icon: LucideIcon;
  node: ReactNode | null;
  /** The route it opens, so a folded section can open while you are on one of its pages. */
  to?: string;
}

const ICON_BUTTON =
  "flex size-7 pointer-coarse:size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";
const CUSTOMISE_ROW = "mx-2 flex min-h-9 items-center gap-2 rounded-lg px-1 text-(length:--text-compact) font-medium text-sidebar-foreground";

// Sections and items are both sortable in one drag context; a section only
// lands on sections and an item on items (or an empty section's drop zone).
const collisionDetection: CollisionDetection = (args) => {
  const section = String(args.active.id).startsWith("section:");
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter((container) => {
      const id = String(container.id);
      return section ? id.startsWith("section:") : id.startsWith("item:") || id.startsWith("list:");
    }),
  });
};

function SortableSidebarSection({
  id,
  label,
  draggable,
  children,
}: {
  id: string;
  label: string;
  draggable: boolean;
  children: (dragHandle: ReactNode) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: `section:${id}`, disabled: !draggable });
  const handle = draggable ? (
    <button
      type="button"
      ref={setActivatorNodeRef}
      data-slot="icon-button"
      {...attributes}
      {...listeners}
      aria-label={`Drag to move the ${label} section`}
      className="flex size-6 cursor-grab touch-manipulation items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
    >
      <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  ) : null;
  return (
    <div
      ref={setNodeRef}
      data-sidebar-section={id}
      style={{
        // Translate only: sections differ in height, so a scale would squash them.
        transform: CSS.Translate.toString(transform),
        transition,
        zIndex: isDragging ? "var(--z-index-raised)" : undefined,
      }}
      className={cn("relative rounded-lg", isDragging && "bg-sidebar-accent ring-2 ring-ring shadow-lg")}
    >
      {children(handle)}
    </div>
  );
}

/** An empty section in customise mode still takes a dropped item. */
function EmptySectionDropZone({ sectionId }: { sectionId: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: `list:${sectionId}` });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "mx-2 rounded-lg border border-dashed border-border px-2 py-2 text-xs text-muted-foreground",
        isOver && "border-ring bg-sidebar-accent",
      )}
    >
      Drop items here
    </div>
  );
}

function CustomiseItemRow({
  id,
  item,
  sections,
  sectionId,
  canMoveUp,
  canMoveDown,
  onMove,
  onMoveTo,
  onHide,
  onPin,
}: {
  id: string;
  item: SidebarItemDef;
  sections: { id: string; label: string }[];
  sectionId: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (delta: -1 | 1) => void;
  onMoveTo: (sectionId: string) => void;
  onHide: () => void;
  onPin: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: `item:${id}` });
  const Icon = item.icon;
  return (
    <div
      ref={setNodeRef}
      data-testid={`sidebar-customise-item-${id}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(CUSTOMISE_ROW, isDragging && "relative z-raised bg-sidebar-accent ring-2 ring-ring shadow-lg")}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Drag to move ${item.label}`}
        className={cn(ICON_BUTTON, "cursor-grab touch-manipulation active:cursor-grabbing")}
      >
        <GripVertical className="h-4 w-4" aria-hidden="true" />
      </button>
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      <button type="button" aria-label={`Hide ${item.label}`} onClick={onHide} className={ICON_BUTTON}>
        <EyeOff className="h-4 w-4" aria-hidden="true" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={`More options for ${item.label}`} className={ICON_BUTTON}>
            <Ellipsis className="h-4 w-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem disabled={!canMoveUp} onSelect={() => onMove(-1)}>
            <ArrowUp className="size-4" aria-hidden="true" />
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canMoveDown} onSelect={() => onMove(1)}>
            <ArrowDown className="size-4" aria-hidden="true" />
            Move down
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderInput className="size-4" aria-hidden="true" />
              Move to section
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {sections.filter((section) => section.id !== sectionId).map((section) => (
                <DropdownMenuItem key={section.id} onSelect={() => onMoveTo(section.id)}>
                  {section.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onPin}>
            <Pin className="size-4" aria-hidden="true" />
            Pin to top
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onHide}>
            <EyeOff className="size-4" aria-hidden="true" />
            Hide
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** A plain row with one action: unpin (Pinned group) or show again (Hidden items). */
function CustomiseActionRow({
  item,
  actionLabel,
  actionIcon: ActionIcon,
  onAction,
}: {
  item: SidebarItemDef;
  actionLabel: string;
  actionIcon: LucideIcon;
  onAction: () => void;
}) {
  const Icon = item.icon;
  return (
    <div className={cn(CUSTOMISE_ROW, "pl-2")}>
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      <button type="button" aria-label={`${actionLabel} ${item.label}`} onClick={onAction} className={ICON_BUTTON}>
        <ActionIcon className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export function Sidebar({ children }: { children?: ReactNode }) {
  const location = useLocation();
  const { openNewIssue } = useDialogActions();
  const { enabled: agentChatEnabled } = useAgentChatEnabled();
  const { enabled: teamChatEnabled } = useTeamChatEnabled();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  const [customising, setCustomising] = useState(false);
  // The icon rail has no room to rearrange; customising needs the full width.
  const customise = customising && !rail;
  const inboxBadge = useInboxBadge(selectedCompanyId);
  // Releasing is the board's decision (GRE-119): agents never see the page.
  const { canRelease } = useCanRelease(selectedCompanyId);
  // Client instances only (GRE-1370): the link shows when the instance has a billing account.
  const hasBillingAccount = useHasBillingAccount();
  // Organisation memory is per company: the link shows only once it is switched on.
  const { enabled: memoryEnabled } = useMemoryEnabled(selectedCompanyId);
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const { liveAgents } = useLiveAgents(selectedCompanyId);
  const whatsNewUnseen = useWhatsNewUnseen();
  const liveRunCount = liveAgents.length;
  const liveIssueIds = new Set(
    liveAgents.flatMap((agent) => agent.runs.flatMap((run) => run.issueId ? [run.issueId] : [])),
  );
  const showWorkspacesLink = experimentalSettings?.enableIsolatedWorkspaces === true;
  const showPipelines = experimentalSettings?.enablePipelines === true;
  // Website view (GRE-1088): hidden while the managed switch is off.
  const showWebsite = experimentalSettings?.enableWebsiteView === true;
  const showIntelligence = experimentalSettings?.enableIntelligence === true;
  // The one Decisions count (GRE-263): the Desk and Decisions badges show the same number.
  const attentionCount = useDecisionsCount(selectedCompanyId);
  // GRE-1633: Status Cards ignores the stored switch, but a client plan can still turn it off.
  const showStatusCards = experimentalSettings?.enableStatusCards === true;
  // GRE-1622: Cases ignores the stored switch, but a client plan can still turn it off.
  const showCases = experimentalSettings?.enableCases === true;
  // Deep Dive stores its record as Cases, so it needs both flags (same rule as its route gate).
  const showDeepDive = showCases && experimentalSettings?.enableDeepDive === true;
  const showAgentChats = agentChatEnabled && !children;
  const showTeamChats = teamChatEnabled && !children;

  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };

  const link = (to: string, label: string, icon: LucideIcon, extra?: Partial<Parameters<typeof SidebarNavItem>[0]>) => ({
    label,
    icon,
    to,
    node: <SidebarNavItem to={to} label={label} icon={icon} {...extra} />,
  });
  const gated = (on: boolean, def: SidebarItemDef): SidebarItemDef => (on ? def : { ...def, node: null });

  // Board routes carry the company prefix ("/GRE/apps"); items link without it.
  const currentPath = location.pathname.replace(/^\/[^/]+/, "");
  // On a task, the open task decides which row stands for it (its chat, its pin, Recent, or Tasks).
  const openIssueRef = currentPath.match(/^\/issues\/([^/]+)/)?.[1];
  const { data: openIssue } = useQuery({
    queryKey: queryKeys.issues.detail(openIssueRef ?? ""),
    queryFn: () => issuesApi.get(openIssueRef!),
    enabled: Boolean(openIssueRef) && openIssueRef !== "new",
    staleTime: 30_000,
    retry: false,
  });
  const activeCandidates = useMemo(
    () => sidebarActiveCandidates(currentPath, location.hash, openIssue),
    [currentPath, location.hash, openIssue],
  );
  // Every destination, keyed by its layout id (lib/sidebar-layout.ts holds the default places).
  const items: Record<string, SidebarItemDef> = {
    // Decisions (attention home, PAP-13481) graduated out of Experimental (GRE-66): always shown.
    // The executive's one page: everything waiting on you, grouped by what to do.
    needed: link("/needed", "Needed from you", HandHelping),
    // Decisions live in the Desk's Decisions section: one list, one count.
    // Both rows point at /desk, so the hash decides which one is lit: never both (lib/sidebar-active).
    decisions: link("/desk#desk-needs-me", "Decisions", ListChecks, { badge: attentionCount, badgeLabel: "decisions", activeKey: "item:decisions" }),
    // The Desk (was My tasks); the layout id stays "my-tasks" so saved sidebars keep it in place.
    "my-tasks": link("/desk", "Desk", UserCheck, { badge: attentionCount, badgeLabel: "decisions", activeKey: "item:my-tasks" }),
    // Unread task updates only: messages, not decisions. Approvals, failed
    // runs and join requests are decision cards, counted on Decisions.
    inbox: link("/inbox", "Inbox", Inbox, {
      badge: inboxBadge.mineIssues,
      badgeLabel: "unread updates",
      badgeTone: "quiet",
    }),
    chats: {
      label: "Chats",
      icon: MessageCircle,
      node: showTeamChats || showAgentChats ? (
        <>
          {showTeamChats ? <SidebarTeamChats agentChatsFollow={showAgentChats} /> : null}
          {showAgentChats ? <SidebarAgentChats inline /> : null}
        </>
      ) : null,
    },
    calendar: link("/calendar", "Calendar", CalendarDays),
    // GRE-1477: CRM organisations, part of the pipelines module.
    organisations: gated(showPipelines, link("/organisations", "Organisations", Building2)),
    pipelines: gated(showPipelines, {
      label: "Pipelines",
      icon: GitBranch,
      to: "/pipelines",
      node: (
        <>
          <SidebarNavItem to="/pipelines" label="Pipelines" icon={GitBranch} />
          <SidebarStarredPipelines />
        </>
      ),
    }),
    "deep-dive": gated(showDeepDive, link("/deep-dive", "Deep Dive", Microscope, { textBadge: "beta" })),
    // GRE-585: finished documents, now with the client work.
    deliverables: link("/deliverables", "Deliverables", FileCheck2),
    images: link("/images", "GS Studio", ImageIcon),
    dashboard: link("/dashboard", "Dashboard", LayoutDashboard, { liveCount: liveRunCount }),
    tasks: link("/issues", "Tasks", CircleCheck, { activeKey: "item:tasks" }),
    projects: {
      label: "Projects",
      icon: FolderOpen,
      to: "/projects",
      node: (
        <>
          <SidebarNavItem to="/projects" label="Projects" icon={FolderOpen} activeKey="item:projects" />
          <SidebarStarredProjects />
        </>
      ),
    },
    // Greatstone (GRE-191): Goals graduated from Experimental; always shown.
    goals: link("/goals", "Goals", Target),
    // GRE-1135: board control panel, behind enableStrategyBoard.
    board: gated(experimentalSettings?.enableStrategyBoard === true, link("/strategy-board", "Board", Landmark)),
    intelligence: gated(showIntelligence, link("/intelligence", "Intelligence", Radar, { textBadge: "beta" })),
    memory: gated(memoryEnabled, link("/memory", "Memory", Brain)),
    agents: link("/agents", "Agents", Users),
    scorecard: link("/scorecard", "Scorecard", Trophy),
    "weekly-report": link("/weekly-report", "This week", Newspaper),
    // Greatstone (GRE-1624): Conference Room Chat graduated from Experimental; always shown.
    "conference-room": link("/board-chat", "Conference Room", MessagesSquare),
    // Greatstone (GRE-1622, GRE-1633): Status Cards graduated from Experimental;
    // shown unless a client plan turns it off.
    status: gated(showStatusCards, link("/status", "Status", LayoutGrid)),
    skills: link("/skills", "Skills", Boxes),
    connectors: link("/apps", "Connectors", Unplug),
    routines: link("/routines", "Routines", Repeat),
    workflows: link("/workflows", "Workflows", Workflow),
    workspaces: gated(showWorkspacesLink, link("/workspaces", "Workspaces", GitBranch)),
    artifacts: link("/artifacts", "Artifacts", Package),
    cases: gated(showCases, link("/cases", "Cases", Layers)),
    website: gated(showWebsite, link("/website", "Website", Globe)),
    activity: link("/activity", "Audit", History),
    releases: gated(canRelease, link("/releases", "Releases", Rocket)),
    billing: gated(hasBillingAccount, link("/billing", "Billing", CreditCard)),
    settings: link("/company/settings", "Settings", Settings),
    "whats-new": link("/whats-new", "What's new", Sparkles, whatsNewUnseen ? { textBadge: "New", textBadgeTone: "amber" } : undefined),
    tutorials: link("/tutorials", "Tutorials", GraduationCap),
    "design-guide": link("/design-guide", "Design guide", Palette),
  };
  const available = (id: string) => Boolean(items[id]?.node);
  const isCurrent = (id: string) => {
    const to = items[id]?.to;
    return Boolean(to && (currentPath === to || currentPath.startsWith(`${to}/`)));
  };

  const layout = useSidebarLayout();
  const hidden = new Set(layout.resolved.hidden);
  const pinned = layout.resolved.pinned.filter(available);
  const pinnedSet = new Set(pinned);
  const shown = (id: string) => available(id) && !hidden.has(id) && !pinnedSet.has(id);
  const sectionOrder = useSidebarSectionOrder(SIDEBAR_SECTION_IDS);
  const sectionsById = new Map(layout.resolved.sections.map((section) => [section.id, section]));
  const orderedSections = sectionOrder.order.flatMap((id) => sectionsById.get(id) ?? []);
  const sectionChoices = orderedSections.map(({ id, label }) => ({ id, label }));
  // Outside customise mode a section with nothing to show is left out entirely.
  const renderedSections = customise
    ? orderedSections
    : orderedSections.filter((section) => section.items.some(shown));

  // Drag starts only from a grip. Touch waits a moment so a swipe still
  // scrolls the sidebar; the keyboard sensor lets a grip move with arrows.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: { active: { id: string | number }; over: { id: string | number } | null }) => {
    const activeId = String(active.id);
    const overId = over ? String(over.id) : null;
    if (!overId || activeId === overId) return;
    if (activeId.startsWith("section:")) {
      sectionOrder.drop(activeId.slice("section:".length), overId.slice("section:".length));
      return;
    }
    const itemId = activeId.slice("item:".length);
    if (overId.startsWith("list:")) {
      layout.update((saved) => moveSidebarItem(saved, itemId, overId.slice("list:".length), Infinity));
      return;
    }
    const target = overId.slice("item:".length);
    const section = layout.resolved.sections.find((candidate) => candidate.items.includes(target));
    if (section) layout.update((saved) => moveSidebarItem(saved, itemId, section.id, section.items.indexOf(target)));
  };

  const resetAll = () => {
    layout.reset();
    sectionOrder.reset();
  };

  const sectionMenu = (id: string, label: string) => {
    const index = sectionOrder.order.indexOf(id);
    const actions: SidebarSectionMenuAction[] = [];
    if (index > 0) {
      actions.push({ type: "item", label: "Move up", icon: ArrowUp, onSelect: () => sectionOrder.move(id, -1) });
    }
    if (index < sectionOrder.order.length - 1) {
      actions.push({ type: "item", label: "Move down", icon: ArrowDown, onSelect: () => sectionOrder.move(id, 1) });
    }
    actions.push(
      { type: "separator" },
      { type: "item", label: "Customise sidebar", icon: SlidersHorizontal, onSelect: () => setCustomising(true) },
      { type: "item", label: "Reset section order", icon: RotateCcw, onSelect: sectionOrder.reset },
    );
    return { actions, ariaLabel: `Rearrange ${label} section` };
  };

  const renderSectionBody = (sectionId: string, ids: string[]) => {
    if (!customise) return ids.map((id) => <Fragment key={id}>{items[id]!.node}</Fragment>);
    if (ids.length === 0) return <EmptySectionDropZone sectionId={sectionId} />;
    return (
      <SortableContext items={ids.map((id) => `item:${id}`)} strategy={verticalListSortingStrategy}>
        {ids.map((id, index) => (
          <CustomiseItemRow
            key={id}
            id={id}
            item={items[id]!}
            sections={sectionChoices}
            sectionId={sectionId}
            canMoveUp={index > 0}
            canMoveDown={index < ids.length - 1}
            onMove={(delta) => layout.update((saved) => moveSidebarItemBy(saved, id, delta, shown))}
            onMoveTo={(target) => layout.update((saved) => moveSidebarItem(saved, id, target, Infinity))}
            onHide={() => layout.update((saved) => setSidebarItemHidden(saved, id, true))}
            onPin={() => layout.update((saved) => setSidebarItemPinned(saved, id, true))}
          />
        ))}
      </SortableContext>
    );
  };

  const hiddenAvailable = layout.resolved.hidden.filter(available);

  return (
    <SidebarActiveProvider candidates={activeCandidates}>
    <aside
      className={cn(
        "w-full h-full min-h-0 flex flex-col",
        primarySidebarStyles.surface,
      )}
    >
      {/* Top bar: company name, aligned with top sections and borderless.
          Search lives in the nav list so the workspace name keeps the width. */}
      <div className="flex h-(--sz-60px) shrink-0 items-center gap-1 px-3">
        <SidebarCompanyMenu />
      </div>

      <nav className={primarySidebarStyles.nav} aria-label="Main">
        <div className={primarySidebarStyles.group}>
          {/* Ben, 13 Oct: the first thing in the sidebar is asking Everest, in words. */}
          <div className="mb-1">
            <SidebarAskEverest rail={rail} />
          </div>
          {(() => {
            const newTaskButton = (
              <button
                onClick={() => openNewIssue()}
                data-slot="icon-button"
                data-tour="new-task"
                aria-label={rail ? "New Task" : undefined}
                className={cn(
                  "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 text-(length:--text-compact) font-medium text-sidebar-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-(length:--rad-3) focus-visible:ring-ring",
                )}
              >
                <SquarePen className="h-4 w-4 shrink-0" />
                <span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : "truncate"}>New Task</span>
              </button>
            );
            return rail ? (
              <Tooltip>
                <TooltipTrigger asChild>{newTaskButton}</TooltipTrigger>
                <TooltipContent side="right">New Task</TooltipContent>
              </Tooltip>
            ) : (
              newTaskButton
            );
          })()}
          {/* Cmd/Ctrl+K remains the keyboard path (command palette). */}
          <SidebarNavItem to="/search" label="Search" icon={Search} />
        </div>

        {customise ? (
          <div
            data-testid="sidebar-customise-panel"
            className="mx-2 flex flex-col gap-2 rounded-lg border border-border bg-sidebar-accent p-3"
          >
            <p className="text-sm font-semibold text-foreground">Customise sidebar</p>
            <p className="text-xs text-muted-foreground">
              Drag the grips or use the menu on each item. Changes save as you go and follow you to other devices.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setCustomising(false)}>Done</Button>
              <Button size="sm" variant="outline" onClick={resetAll}>
                <RotateCcw className="size-4" aria-hidden="true" />
                Reset to default
              </Button>
            </div>
          </div>
        ) : null}

        {pinned.length > 0 ? (
          <SidebarSection label="Pinned">
            {pinned.map((id) => customise ? (
              <CustomiseActionRow
                key={id}
                item={items[id]!}
                actionLabel="Unpin"
                actionIcon={PinOff}
                onAction={() => layout.update((saved) => setSidebarItemPinned(saved, id, false))}
              />
            ) : (
              <Fragment key={id}>{items[id]!.node}</Fragment>
            ))}
          </SidebarSection>
        ) : null}

        <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragEnd={onDragEnd}>
          <SortableContext
            items={renderedSections.map((section) => `section:${section.id}`)}
            strategy={verticalListSortingStrategy}
          >
            {renderedSections.map((section) => (
              <SortableSidebarSection key={section.id} id={section.id} label={section.label} draggable={customise}>
                {(dragHandle) => (
                  <SidebarSection
                    dragHandle={dragHandle}
                    label={section.label}
                    collapsible={customise ? undefined : {
                      // A section folded only by default opens while you are on one of its pages.
                      open: section.open
                        || (layout.saved.collapsed?.[section.id] !== true && section.items.some((id) => shown(id) && isCurrent(id))),
                      onOpenChange: (open) => layout.update((saved) => setSidebarSectionOpen(saved, section.id, open)),
                    }}
                    menu={sectionMenu(section.id, section.label)}
                  >
                    {renderSectionBody(section.id, section.items.filter(shown))}
                  </SidebarSection>
                )}
              </SortableSidebarSection>
            ))}
          </SortableContext>
        </DndContext>

        {customise ? (
          <SidebarSection label="Hidden items">
            {hiddenAvailable.length === 0 ? (
              <p className="mx-2 px-2 text-xs text-muted-foreground">
                Nothing hidden. Use the eye button to hide an item you do not use.
              </p>
            ) : (
              hiddenAvailable.map((id) => (
                <CustomiseActionRow
                  key={id}
                  item={items[id]!}
                  actionLabel="Show"
                  actionIcon={Eye}
                  onAction={() => layout.update((saved) => setSidebarItemHidden(saved, id, false))}
                />
              ))
            )}
          </SidebarSection>
        ) : null}

        {/* Plugin destinations sit after the sections; plugins decide what they add. */}
        <div className={primarySidebarStyles.group}>
          <PluginSlotOutlet
            slotTypes={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-(length:--text-compact) font-medium"
            missingBehavior="placeholder"
          />
          <PluginLauncherOutlet
            placementZones={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-(length:--text-compact) font-medium"
          />
        </div>

        {children}

        <SidebarFollowing companyId={selectedCompanyId} />
        <SidebarRecentTasks companyId={selectedCompanyId} liveIssueIds={liveIssueIds} />

        <PluginSlotOutlet
          slotTypes={["sidebarPanel"]}
          context={pluginContext}
          className="flex flex-col gap-3"
          itemClassName="rounded-lg border border-border p-3"
          missingBehavior="placeholder"
        />
        {rail || customise ? null : (
          <button
            type="button"
            onClick={() => setCustomising(true)}
            className="mx-2 flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-(length:--text-compact) font-medium text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-(length:--rad-3) focus-visible:ring-ring"
          >
            <SlidersHorizontal className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="truncate">Customise sidebar</span>
          </button>
        )}
        <SidebarBrandSignature rail={rail} />
        <SidebarReleaseFooter companyId={selectedCompanyId} rail={rail} />
      </nav>
    </aside>
    </SidebarActiveProvider>
  );
}
