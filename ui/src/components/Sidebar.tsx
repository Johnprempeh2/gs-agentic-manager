import {
  Inbox,
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
  ShoppingBag,
  GitBranch,
  Package,
  FolderOpen,
  Unplug,
  MessagesSquare,
  MessageCircle,
  LayoutGrid,
  UserCheck,
  Users,
  CreditCard,
  FileCheck2,
  Link2,
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
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
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
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { SidebarSection, type SidebarSectionMenuAction } from "./SidebarSection";
import { useSidebarSectionOrder } from "../hooks/useSidebarSectionOrder";
import { useSidebarLayout } from "../hooks/useSidebarLayout";
import { SidebarNavExpandedProvider, SidebarNavItem } from "./SidebarNavItem";
import { SidebarStarredProjects } from "./SidebarStarredProjects";
import { SidebarStarredPipelines } from "./SidebarStarredPipelines";
import { SidebarChats } from "./SidebarChats";
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
import { useCommerceSite } from "../hooks/useCommerceSite";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  CUSTOMISE_SIDEBAR_EVENT,
} from "../lib/sidebar-layout";
import { Link, useLocation } from "@/lib/router";
import { PluginSlotOutlet } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { GreatstoneLogo } from "./GreatstoneLogo";
import { SidebarReleaseFooter } from "./SidebarReleaseFooter";
import { useHasBillingAccount } from "../hooks/useBillingAccount";
import { primarySidebarStyles } from "./primary-sidebar-styles";

/** One sidebar destination. `node` is null while its feature switch is off: it then shows nowhere. */
interface SidebarItemDef {
  label: string;
  icon: LucideIcon;
  node: ReactNode | null;
  /** The route it opens, so a folded section can open while you are on one of its pages. */
  to?: string;
}

interface SidebarGroupEntry {
  id: string;
  label: string;
  icon: LucideIcon;
  to: string;
  badge?: number;
}

function SidebarNavGroup({
  active,
  entries,
  icon: Icon,
  label,
  badge,
}: {
  active: boolean;
  entries: SidebarGroupEntry[];
  icon: LucideIcon;
  label: string;
  badge?: number;
}) {
  const { collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  const [open, setOpen] = useState(false);
  const hasBadge = badge != null && badge > 0;
  if (entries.length === 0) return null;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={rail ? `${label}${hasBadge ? `, ${badge} decisions` : ""}` : undefined}
          aria-expanded={open}
          data-tour={label === "Desk" ? "nav-decisions" : undefined}
          onPointerEnter={() => { if (rail) setOpen(true); }}
          onMouseEnter={(event) => { if (rail) event.stopPropagation(); }}
          className={cn(
            "gs-nav-item mx-2 flex min-h-8 items-center gap-2.5 rounded-lg px-2 py-1.5 text-(length:--text-compact) font-medium outline-none transition-colors pointer-coarse:py-1",
            active
              ? "gs-nav-item-active bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          )}
        >
          <span className="relative shrink-0">
            <Icon className="h-4 w-4" aria-hidden="true" />
            {rail && hasBadge ? (
              <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary shadow-(--shadow-sidebar-icon-badge)" aria-hidden="true" />
            ) : null}
          </span>
          <span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : "gs-side-reveal min-w-0 flex-1 truncate text-left"}>{label}</span>
          {!rail && hasBadge ? (
            <Badge variant="ghost" className="gs-side-reveal ml-auto px-1.5 leading-none bg-primary text-primary-foreground">
              {badge}
            </Badge>
          ) : null}
          {rail ? null : <ChevronRight className="gs-side-reveal h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
        </button>
      </DropdownMenuTrigger>
      {/* The flyout's first item lines up with the hovered row (alignOffset cancels
          the menu's own 4px padding) and it clears the glass by the 8px inset. */}
      <DropdownMenuContent side="right" align="start" sideOffset={RAIL_FLYOUT_OFFSET} alignOffset={-4} className="w-56">
        <SidebarNavExpandedProvider>
          {entries.map((entry) => {
            const EntryIcon = entry.icon;
            return (
              <DropdownMenuItem key={entry.id} asChild>
                <Link to={entry.to} className="flex items-center gap-2">
                  <EntryIcon className="size-4" aria-hidden="true" />
                  <span className="min-w-0 flex-1">{entry.label}</span>
                  {entry.badge != null && entry.badge > 0 ? (
                    <Badge variant="ghost" className="ml-auto px-1.5 leading-none bg-primary text-primary-foreground">
                      {entry.badge}
                    </Badge>
                  ) : null}
                </Link>
              </DropdownMenuItem>
            );
          })}
        </SidebarNavExpandedProvider>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A row's pill ends 20px inside the glass (nav px-3 + row mx-2), then the 1px
 * edge and the 8px float inset: a flyout opens just clear of the glass.
 */
const RAIL_FLYOUT_OFFSET = 12 + 8 + 1 + 8;

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
  const { collapsed, peeking, collapseLocked, toggleCollapsed, setCollapsed, isMobile } = useSidebar();
  const rail = collapsed && !peeking;
  const [customising, setCustomising] = useState(false);
  // The icon rail has no room to rearrange; customising needs the full width.
  const customise = customising && !rail;
  // "Customise menu" in the account menu: open the full sidebar and start.
  useEffect(() => {
    const start = () => {
      if (collapsed && !collapseLocked) setCollapsed(false);
      setCustomising(true);
    };
    window.addEventListener(CUSTOMISE_SIDEBAR_EVENT, start);
    return () => window.removeEventListener(CUSTOMISE_SIDEBAR_EVENT, start);
  }, [collapsed, collapseLocked, setCollapsed]);
  const inboxBadge = useInboxBadge(selectedCompanyId);
  // Client instances only (GRE-1370): the link shows when the instance has a billing account.
  const hasBillingAccount = useHasBillingAccount();
  // Organisation memory is per company: the link shows only once it is switched on.
  const { enabled: memoryEnabled } = useMemoryEnabled(selectedCompanyId);
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const { liveAgents } = useLiveAgents(selectedCompanyId);
  const liveRunCount = liveAgents.length;
  const liveIssueIds = new Set(
    liveAgents.flatMap((agent) => agent.runs.flatMap((run) => run.issueId ? [run.issueId] : [])),
  );
  const showWorkspacesLink = experimentalSettings?.enableIsolatedWorkspaces === true;
  const showPipelines = experimentalSettings?.enablePipelines === true;
  // Website view (GRE-1088): hidden while the managed switch is off.
  const showWebsite = experimentalSettings?.enableWebsiteView === true;
  const showIntelligence = experimentalSettings?.enableIntelligence === true;
  const { commerce } = useCommerceSite(selectedCompanyId);
  const showCommerce = commerce !== null;
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
    // Decisions live in the Desk's Decisions section: one list, one count.
    // Both rows point at /desk, so the hash decides which one is lit: never both (lib/sidebar-active).
    decisions: link("/desk#desk-needs-me", "Decisions", ListChecks, { badge: attentionCount, badgeLabel: "decisions", activeKey: "item:decisions", tourId: "nav-decisions" }),
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
      // Everest and pinned chats; everything else is in Messages (All messages).
      node: showTeamChats || showAgentChats ? <SidebarChats /> : null,
    },
    calendar: link("/calendar", "Calendar", CalendarDays),
    // GRE-1477: CRM organisations, part of the pipelines module.
    organisations: gated(showPipelines, link("/organisations", "Organisations", Building2)),
    // GRE-2383: the website's quotes, orders, invoices and licences. Greatstone only, while its Shop feature is on.
    commerce: gated(showCommerce, link("/commerce", "Commerce", ShoppingBag, { tourId: "nav-commerce" })),
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
    // GRE-4252: every shared link, by client and project.
    links: link("/links", "Links", Link2),
    images: link("/images", "GS Studio", ImageIcon),
    dashboard: link("/dashboard", "Dashboard", LayoutDashboard, { liveCount: liveRunCount }),
    tasks: link("/issues", "Tasks", CircleCheck, { activeKey: "item:tasks", tourId: "nav-tasks" }),
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
    website: gated(showWebsite, link("/website", "Website", Globe, { tourId: "nav-website" })),
    activity: link("/activity", "Audit", History),
    billing: gated(hasBillingAccount, link("/billing", "Billing", CreditCard)),
    // Settings, Releases, Tutorials and What's new live in the account menu
    // (bottom left, sidebar v2), so they are not repeated here.
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
  const groups = {
    "my-tasks": { label: "Desk", icon: UserCheck, items: ["my-tasks", "decisions", "inbox", "dashboard"] },
    organisations: { label: "Clients", icon: Building2, items: ["organisations", "pipelines"] },
    deliverables: { label: "Deliverables", icon: FileCheck2, items: ["deliverables", "links", "artifacts"] },
    agents: { label: "Team", icon: Users, items: ["agents", "scorecard", "weekly-report", "status", "conference-room"] },
    skills: { label: "Build", icon: Boxes, items: ["skills", "connectors", "routines", "workflows", "releases", "activity"] },
  } as const;
  const absorbed = new Set<string>(Object.values(groups).flatMap((group) => group.items.slice(1)));
  const shownTopLevel = (id: string) => {
    const group = groups[id as keyof typeof groups];
    return group ? group.items.some(shown) : shown(id) && !absorbed.has(id);
  };
  const renderItem = (id: string) => {
    const group = groups[id as keyof typeof groups];
    if (!group) return items[id]!.node;
    const entries = group.items.flatMap((entryId) => {
      const entry = items[entryId];
      if (!available(entryId) || !entry?.to || hidden.has(entryId) || pinnedSet.has(entryId)) return [];
      return [{
        id: entryId,
        label: entry.label,
        icon: entry.icon,
        to: entry.to,
        badge: entryId === "decisions" ? attentionCount : undefined,
      }];
    });
    const active = entries.some((entry) => currentPath === entry.to || currentPath.startsWith(`${entry.to}/`));
    return (
      <SidebarNavGroup
        active={active}
        badge={id === "my-tasks" ? attentionCount : undefined}
        entries={entries}
        icon={group.icon}
        label={group.label}
      />
    );
  };
  const sectionOrder = useSidebarSectionOrder(SIDEBAR_SECTION_IDS);
  const sectionsById = new Map(layout.resolved.sections.map((section) => [section.id, section]));
  const orderedSections = sectionOrder.order.flatMap((id) => sectionsById.get(id) ?? []);
  const sectionChoices = orderedSections.map(({ id, label }) => ({ id, label }));
  // Outside customise mode a section with nothing to show is left out entirely.
  const renderedSections = customise
    ? orderedSections
    : orderedSections.filter((section) => section.items.some(shownTopLevel));

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
    if (!customise) return ids.map((id) => <Fragment key={id}>{renderItem(id)}</Fragment>);
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
      {/* Top bar, one 56px row in both states so nothing below it moves: the
          logo stone sits on the rail axis (pl-6 + a 24px box = 36px), the
          wordmark beside it, the toggle at the row's end ([ on the keyboard).
          On the rail the toggle sits over the stone on the same axis and shows
          on hover or focus; tapping the stone expands. */}
      <div
        className="group/brand relative flex h-14 shrink-0 items-center gap-2 pl-6 pr-5"
        data-slot="sidebar-brand-header"
      >
        <GreatstoneLogo variant={rail ? "stone" : "full"} className={cn(rail && "transition-opacity group-hover/brand:opacity-0 group-has-[:focus-visible]/brand:opacity-0")} />
        {collapseLocked || isMobile ? null : (
          <button
            type="button"
            data-slot="icon-button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-keyshortcuts="["
            title={collapsed ? "Expand sidebar ([)" : "Collapse sidebar ([)"}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              rail
                ? "absolute left-5 top-1/2 -translate-y-1/2 text-transparent group-hover/brand:text-foreground focus-visible:text-foreground"
                : "gs-side-reveal ml-auto",
            )}
          >
            {collapsed ? <PanelLeftOpen className="size-4" aria-hidden="true" /> : <PanelLeftClose className="size-4" aria-hidden="true" />}
          </button>
        )}
      </div>

      <nav className={primarySidebarStyles.nav} aria-label="Main">
        <div className={primarySidebarStyles.group}>
          {(() => {
            const newTaskButton = (
              <button
                onClick={() => openNewIssue()}
                data-slot="icon-button"
                data-tour="new-task"
                aria-label={rail ? "New Task" : undefined}
                className={cn(
                  "flex min-h-8 items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 text-(length:--text-compact) font-medium text-sidebar-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-(length:--rad-3) focus-visible:ring-ring",
                )}
              >
                <SquarePen className="h-4 w-4 shrink-0" />
                <span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : "gs-side-reveal truncate"}>New Task</span>
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
                    {renderSectionBody(section.id, section.items.filter(customise ? shown : shownTopLevel))}
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
        <SidebarReleaseFooter companyId={selectedCompanyId} rail={rail} />
      </nav>
    </aside>
    </SidebarActiveProvider>
  );
}
