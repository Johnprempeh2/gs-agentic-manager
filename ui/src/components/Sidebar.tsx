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
  GitBranch,
  Package,
  Settings,
  FolderOpen,
  Unplug,
  MessagesSquare,
  LayoutGrid,
  UserCheck,
  Users,
  Rocket,
  CreditCard,
  FileCheck2,
  Brain,
  Workflow,
  Globe,
  ArrowUp,
  ArrowDown,
  RotateCcw,
  GripVertical,
} from "lucide-react";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCallback, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { SidebarSection, type SidebarSectionMenuAction } from "./SidebarSection";
import { useSidebarSectionOrder } from "../hooks/useSidebarSectionOrder";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarStarredProjects } from "./SidebarStarredProjects";
import { SidebarStarredPipelines } from "./SidebarStarredPipelines";
import { SidebarAgentChats } from "./SidebarAgentChats";
import { useAgentChatEnabled } from "@/hooks/useAgentChatEnabled";
import { SidebarRecentTasks } from "./SidebarRecentTasks";
import { useDialogActions } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { useDecisionsCount, useMyTasksCount } from "../hooks/useDecisionsFeed";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { useLiveAgents } from "../hooks/useLiveAgents";
import { useMemoryEnabled } from "../hooks/useMemoryEnabled";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";
import { PluginSlotOutlet } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { SidebarBrandSignature } from "./SidebarBrandSignature";
import { SidebarReleaseFooter } from "./SidebarReleaseFooter";
import { useCanRelease } from "../hooks/useReleases";
import { useHasBillingAccount } from "../hooks/useBillingAccount";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";
import { primarySidebarStyles } from "./primary-sidebar-styles";

function useStoredSectionOpen(section: string, initial: boolean) {
  const key = `gsam.sidebar.${section}.open`;
  const [open, setOpen] = useState(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored === null ? initial : stored === "1";
    } catch {
      return initial;
    }
  });
  const update = useCallback((next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(key, next ? "1" : "0");
    } catch {
      // Private mode: the section still toggles for this session.
    }
  }, [key]);
  return [open, update] as const;
}

// Default order of the streamlined sections; each user may rearrange them.
const SECTION_IDS = ["work", "team", "build", "company"] as const;
const SECTION_LABELS: Record<string, string> = { work: "Work", team: "Team", build: "Build", company: "Company" };

function SortableSidebarSection({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: (dragHandle: ReactNode) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const handle = (
    <button
      type="button"
      ref={setActivatorNodeRef}
      data-slot="icon-button"
      {...attributes}
      {...listeners}
      aria-label={`Drag to move the ${label} section`}
      className="flex h-5 w-5 cursor-grab touch-manipulation items-center justify-center rounded-sm text-subtle-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
    >
      <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
  return (
    <div
      ref={setNodeRef}
      style={{
        // Translate only: sections differ in height, so a scale would squash them.
        transform: CSS.Translate.toString(transform),
        transition,
        zIndex: isDragging ? "var(--z-index-raised)" : undefined,
      }}
      className={cn(
        "relative rounded-lg",
        isDragging && "bg-sidebar-accent ring-2 ring-ring shadow-lg",
      )}
    >
      {children(handle)}
    </div>
  );
}

export function Sidebar({ children }: { children?: ReactNode }) {
  const { openNewIssue } = useDialogActions();
  const { enabled: agentChatEnabled } = useAgentChatEnabled();
  // Every labeled section is collapsible, default open, and remembers being
  // closed, so a section the owner folds away stays folded after a reload.
  const [workOpen, setWorkOpen] = useStoredSectionOpen("work", true);
  const [teamOpen, setTeamOpen] = useStoredSectionOpen("team", true);
  const [buildOpen, setBuildOpen] = useStoredSectionOpen("build", true);
  const [organizationOpen, setOrganizationOpen] = useStoredSectionOpen("company", true);
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  const inboxBadge = useInboxBadge(selectedCompanyId);
  // Releasing is the board's decision (GRE-119): agents never see the page.
  const { canRelease } = useCanRelease(selectedCompanyId);
  // Client instances only (GRE-1370): the link shows when the instance has a billing account.
  const hasBillingAccount = useHasBillingAccount();
  const billingItem = hasBillingAccount ? <SidebarNavItem to="/billing" label="Billing" icon={CreditCard} /> : null;
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
  const showStatusCards = experimentalSettings?.enableStatusCards === true;
  // The one Decisions count (GRE-263): same number as the Decisions header and Focus.
  const attentionCount = useDecisionsCount(selectedCompanyId);
  // Tasks assigned to the user count on My tasks, not Decisions (GRE-586).
  const myTasksCount = useMyTasksCount(selectedCompanyId);
  const showCases = experimentalSettings?.enableCases === true;
  // Deep Dive stores its record as Cases, so it needs both flags (same rule as its route gate).
  const showDeepDive = showCases && experimentalSettings?.enableDeepDive === true;
  // Conference Room Chat flag (PAP-136/PAP-137): the Conference Room nav item
  // is a new surface, hidden entirely while the flag is off (same no-flash
  // pattern as showWorkspacesLink above).
  const conferenceRoomChatEnabled = experimentalSettings?.enableConferenceRoomChat === true;

  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };

  const dashboardItem = (
    <SidebarNavItem to="/dashboard" label="Dashboard" icon={LayoutDashboard} liveCount={liveRunCount} />
  );
  const inboxItem = (
    <SidebarNavItem
      to="/inbox"
      label="Inbox"
      icon={Inbox}
      badge={inboxBadge.inbox}
      badgeLabel="unread"
      badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "quiet"}
      alert={inboxBadge.failedRuns > 0}
    />
  );
  const myTasksItem = (
    <SidebarNavItem to="/my-tasks" label="My tasks" icon={UserCheck} badge={myTasksCount} badgeLabel="open" />
  );
  // Decisions (attention home, PAP-13481) graduated out of Experimental
  // (GRE-66): always shown, whatever the stored enableDecisions value says.
  const decisionsItem = (
    <SidebarNavItem
      to="/decisions"
      label="Decisions"
      icon={ListChecks}
      badge={attentionCount}
      badgeLabel="decisions"
    />
  );
  const statusItem = showStatusCards ? (
    <SidebarNavItem to="/status" label="Status" icon={LayoutGrid} textBadge="beta" />
  ) : null;
  const conferenceRoomItem = conferenceRoomChatEnabled ? (
    <SidebarNavItem to="/board-chat" label="Conference Room" icon={MessagesSquare} />
  ) : null;
  const tasksItem = <SidebarNavItem to="/issues" label="Agent tasks" icon={CircleCheck} />;
  // Greatstone (GRE-191): Goals graduated from Experimental; always shown.
  const goalsItem = <SidebarNavItem to="/goals" label="Goals" icon={Target} />;
  // GRE-1135: board control panel, behind enableStrategyBoard.
  const boardItem = experimentalSettings?.enableStrategyBoard === true ? (
    <SidebarNavItem to="/strategy-board" label="Board" icon={Landmark} />
  ) : null;
  const routinesItem = <SidebarNavItem to="/routines" label="Routines" icon={Repeat} />;
  const workflowsItem = <SidebarNavItem to="/workflows" label="Workflows" icon={Workflow} />;
  const artifactsItem = <SidebarNavItem to="/artifacts" label="Artifacts" icon={Package} />;
  const casesItem = showCases ? (
    <SidebarNavItem to="/cases" label="Cases" icon={Layers} textBadge="beta" />
  ) : null;
  const deepDiveItem = showDeepDive ? (
    <SidebarNavItem to="/deep-dive" label="Deep Dive" icon={Microscope} textBadge="beta" />
  ) : null;
  const pipelinesItem = showPipelines ? (
    <SidebarNavItem to="/pipelines" label="Pipelines" icon={GitBranch} />
  ) : null;
  // GRE-1477: CRM organisations, part of the pipelines module.
  const organisationsItem = showPipelines ? (
    <SidebarNavItem to="/organisations" label="Organisations" icon={Building2} />
  ) : null;
  const websiteItem = showWebsite ? (
    <SidebarNavItem to="/website" label="Website" icon={Globe} />
  ) : null;
  const workspacesItem = showWorkspacesLink ? (
    <SidebarNavItem to="/workspaces" label="Workspaces" icon={GitBranch} />
  ) : null;
  const pluginNavOutlets = (
    <>
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
    </>
  );
  const showAgentChats = agentChatEnabled && !children;
  const sectionOrder = useSidebarSectionOrder(SECTION_IDS);
  // Drag starts only from the grip. Touch waits a moment so a swipe still
  // scrolls the sidebar; the keyboard sensor lets the grip move with arrows.
  const sectionSensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
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
      { type: "item", label: "Reset to default order", icon: RotateCcw, onSelect: sectionOrder.reset },
    );
    return { actions, ariaLabel: `Rearrange ${label} section` };
  };
  const streamlinedSections: Record<string, (dragHandle: ReactNode) => ReactNode> = {
    work: (dragHandle) => (
      <SidebarSection
        dragHandle={dragHandle}
        label="Work"
        collapsible={{ open: workOpen, onOpenChange: setWorkOpen }}
        menu={sectionMenu("work", "Work")}
      >
        {dashboardItem}
        {inboxItem}
        {myTasksItem}
        {decisionsItem}
        {tasksItem}
        {goalsItem}
        {boardItem}
      </SidebarSection>
    ),
    team: (dragHandle) => (
      <SidebarSection
        dragHandle={dragHandle}
        label="Team"
        collapsible={{ open: teamOpen, onOpenChange: setTeamOpen }}
        menu={sectionMenu("team", "Team")}
      >
        <SidebarNavItem to="/agents" label="Agents" icon={Users} />
        {conferenceRoomItem}
        {statusItem}
      </SidebarSection>
    ),
    build: (dragHandle) => (
      <SidebarSection
        dragHandle={dragHandle}
        label="Build"
        collapsible={{ open: buildOpen, onOpenChange: setBuildOpen }}
        menu={sectionMenu("build", "Build")}
      >
        <SidebarNavItem to="/projects" label="Projects" icon={FolderOpen} />
        <SidebarStarredProjects />
        {routinesItem}
        {workflowsItem}
        {pipelinesItem}
        <SidebarStarredPipelines />
        {organisationsItem}
        {workspacesItem}
        {artifactsItem}
        {casesItem}
        {deepDiveItem}
        {pluginNavOutlets}
      </SidebarSection>
    ),
    company: (dragHandle) => (
      <SidebarSection
        dragHandle={dragHandle}
        label="Company"
        collapsible={{ open: organizationOpen, onOpenChange: setOrganizationOpen }}
        menu={sectionMenu("company", "Company")}
      >
        <SidebarNavItem to="/skills" label="Skills" icon={Boxes} />
        <SidebarNavItem to="/apps" label="Connectors" icon={Unplug} />
        {websiteItem}
        <SidebarNavItem to="/activity" label="Audit" icon={History} />
        {canRelease ? <SidebarNavItem to="/releases" label="Releases" icon={Rocket} /> : null}
        {billingItem}
        <SidebarNavItem to="/company/settings" label="Settings" icon={Settings} />
      </SidebarSection>
    ),
  };

  return (
    <aside
      className={cn(
        "w-full h-full min-h-0 flex flex-col",
        primarySidebarStyles.surface,
      )}
    >
      {/* Top bar: company name, aligned with top sections and borderless.
          Search deliberately does NOT live here:
          the header's spare width goes to the workspace/organization name,
          which is the user's orientation anchor and truncates otherwise.
          Search is the first nav item below instead. */}
      <div className="flex h-(--sz-60px) shrink-0 items-center gap-1 px-3">
        <SidebarCompanyMenu />
      </div>

      <nav className={primarySidebarStyles.nav}>
        <div className={primarySidebarStyles.group}>
          {/* New Task button aligned with nav items */}
          {(() => {
            const newTaskButton = (
              <button
                onClick={() => openNewIssue()}
                data-slot="icon-button"
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
          {/* Search moved out of the header so the workspace name keeps the
              width; a nav row also keeps search reachable from the
              collapsed rail, where the old header icon was dropped entirely.
              Cmd/Ctrl+K remains the keyboard path (command palette). */}
          <SidebarNavItem to="/search" label="Search" icon={Search} />
          {/* GRE-585: finished documents sit in the top group, above Everest. */}
          <SidebarNavItem to="/deliverables" label="Deliverables" icon={FileCheck2} />
          {memoryEnabled ? <SidebarNavItem to="/memory" label="Memory" icon={Brain} /> : null}
          {/* GRE-259: the chat with Everest sits directly under Search and Deliverables. */}
          {showAgentChats ? <SidebarAgentChats inline /> : null}
        </div>

        <DndContext
          sensors={sectionSensors}
          collisionDetection={closestCenter}
          onDragEnd={({ active, over }) => {
            if (over && active.id !== over.id) sectionOrder.drop(String(active.id), String(over.id));
          }}
        >
          <SortableContext items={sectionOrder.order} strategy={verticalListSortingStrategy}>
            {sectionOrder.order.map((id) => (
              <SortableSidebarSection key={id} id={id} label={SECTION_LABELS[id] ?? id}>
                {streamlinedSections[id]}
              </SortableSidebarSection>
            ))}
          </SortableContext>
        </DndContext>

        {children}

        <SidebarRecentTasks companyId={selectedCompanyId} liveIssueIds={liveIssueIds} />

        <PluginSlotOutlet
          slotTypes={["sidebarPanel"]}
          context={pluginContext}
          className="flex flex-col gap-3"
          itemClassName="rounded-lg border border-border p-3"
          missingBehavior="placeholder"
        />
        <SidebarBrandSignature rail={rail} />
        <SidebarReleaseFooter companyId={selectedCompanyId} rail={rail} />
      </nav>
    </aside>
  );
}
