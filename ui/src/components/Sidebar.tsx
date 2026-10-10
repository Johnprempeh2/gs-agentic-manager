import {
  Inbox,
  ListChecks,
  CircleCheck,
  Target,
  Landmark,
  LayoutDashboard,
  DollarSign,
  History,
  Search,
  SquarePen,
  Network,
  Boxes,
  Repeat,
  Layers,
  Microscope,
  GitBranch,
  Package,
  Settings,
  FolderOpen,
  Unplug,
  MessagesSquare,
  GanttChartSquare,
  LayoutGrid,
  UserCheck,
  Users,
  Rocket,
  FileCheck2,
  Brain,
  Workflow,
} from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarAgents } from "./SidebarAgents";
import { SidebarProjects } from "./SidebarProjects";
import { SidebarStarredProjects } from "./SidebarStarredProjects";
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
import { useStreamlinedUiEnabled } from "../hooks/useStreamlinedUiEnabled";
import { useLiveAgents } from "../hooks/useLiveAgents";
import { useMemoryEnabled } from "../hooks/useMemoryEnabled";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";
import { PluginSlotOutlet } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { SidebarBrandSignature } from "./SidebarBrandSignature";
import { SidebarReleaseFooter } from "./SidebarReleaseFooter";
import { useCanRelease } from "../hooks/useReleases";
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
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  const rail = collapsed && !peeking;
  const inboxBadge = useInboxBadge(selectedCompanyId);
  // Releasing is the board's decision (GRE-119): agents never see the page.
  const { canRelease } = useCanRelease(selectedCompanyId);
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

  return (
    <aside
      className={cn(
        "w-full h-full min-h-0 flex flex-col",
        streamlinedUiEnabled
          ? primarySidebarStyles.surface
          : "border-r border-border bg-background",
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
          {streamlinedUiEnabled && showAgentChats ? <SidebarAgentChats inline /> : null}
          {streamlinedUiEnabled ? null : (
            <>
              {dashboardItem}
              {inboxItem}
              {myTasksItem}
              {decisionsItem}
              {statusItem}
              {conferenceRoomItem}
            </>
          )}
        </div>

        {streamlinedUiEnabled ? (
          <>
            <SidebarSection label="Work" collapsible={{ open: workOpen, onOpenChange: setWorkOpen }}>
              {dashboardItem}
              {inboxItem}
              {myTasksItem}
              {decisionsItem}
              {tasksItem}
              {goalsItem}
              {boardItem}
            </SidebarSection>

            <SidebarSection label="Team" collapsible={{ open: teamOpen, onOpenChange: setTeamOpen }}>
              <SidebarNavItem to="/agents" label="Agents" icon={Users} />
              {conferenceRoomItem}
              {statusItem}
            </SidebarSection>

            <SidebarSection label="Build" collapsible={{ open: buildOpen, onOpenChange: setBuildOpen }}>
              <SidebarNavItem to="/projects" label="Projects" icon={FolderOpen} />
              <SidebarStarredProjects />
              {routinesItem}
              {workflowsItem}
              {pipelinesItem}
              {workspacesItem}
              {artifactsItem}
              {casesItem}
              {deepDiveItem}
              {pluginNavOutlets}
            </SidebarSection>

            <SidebarSection
              label="Company"
              collapsible={{ open: organizationOpen, onOpenChange: setOrganizationOpen }}
            >
              <SidebarNavItem to="/skills" label="Skills" icon={Boxes} />
              <SidebarNavItem to="/apps" label="Connectors" icon={Unplug} />
              <SidebarNavItem to="/activity" label="Audit" icon={History} />
              {canRelease ? <SidebarNavItem to="/releases" label="Releases" icon={Rocket} /> : null}
              <SidebarNavItem to="/company/settings" label="Settings" icon={Settings} />
            </SidebarSection>
          </>
        ) : (
          <SidebarSection label="Work" collapsible={{ open: workOpen, onOpenChange: setWorkOpen }}>
            {tasksItem}
            {routinesItem}
            {workflowsItem}
            {artifactsItem}
            {casesItem}
            {deepDiveItem}
            {pipelinesItem}
            {goalsItem}
            {boardItem}
            {workspacesItem}
            {pluginNavOutlets}
          </SidebarSection>
        )}

        {children}
        {!streamlinedUiEnabled && showAgentChats && <SidebarAgentChats />}

        {streamlinedUiEnabled ? (
          <SidebarRecentTasks companyId={selectedCompanyId} liveIssueIds={liveIssueIds} />
        ) : (
          <>
            <SidebarProjects />
            <SidebarAgents />
            <SidebarSection
              label="Organization"
              collapsible={{ open: organizationOpen, onOpenChange: setOrganizationOpen }}
            >
              <SidebarNavItem to="/org" label="Org" icon={Network} />
              <SidebarNavItem to="/apps" label="Connectors" icon={Unplug} />
              <SidebarNavItem to="/timeline" label="Timeline" icon={GanttChartSquare} />
              <SidebarNavItem to="/costs" label="Costs" icon={DollarSign} />
              <SidebarNavItem to="/activity" label="Activity" icon={History} />
              {canRelease ? <SidebarNavItem to="/releases" label="Releases" icon={Rocket} /> : null}
              <SidebarNavItem to="/company/settings" label="Settings" icon={Settings} />
            </SidebarSection>
          </>
        )}

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
