import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquarePlus, User, Users } from "lucide-react";
import type { TeamChatSummary } from "@greatstone/shared";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { teamChatsApi } from "@/api/teamChats";
import { SidebarNavItem } from "@/components/SidebarNavItem";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCompany } from "@/context/CompanyContext";
import { useSidebar } from "@/context/SidebarContext";
import { buildCompanyUserLabelMap, isAgentTaskTarget } from "@/lib/company-members";
import { queryKeys } from "@/lib/queryKeys";
import { useLocation, useNavigate } from "@/lib/router";
import { teamChatLabel } from "@/lib/team-chats";
import { SIDEBAR_RAIL_HIDDEN_LABEL } from "@/lib/utils";
import { NewTeamChatDialog, type NewTeamChatInput } from "./NewTeamChatDialog";

const HEADING = "px-4 pt-2 pb-1 font-mono text-(length:--text-nano) font-medium uppercase tracking-widest text-subtle-foreground";
const ACTION =
  "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 text-(length:--text-compact) font-medium text-muted-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-(length:--rad-3) focus-visible:ring-ring";

/**
 * Team chats in the primary sidebar (enableTeamChat): Direct messages and
 * Groups, each with unread counts and a start button. When agent chats show
 * below, an "Agent chats" heading introduces them.
 */
export function SidebarTeamChats({ agentChatsFollow = false }: { agentChatsFollow?: boolean }) {
  const { selectedCompanyId } = useCompany();
  const { collapsed, peeking, isMobile, setSidebarOpen } = useSidebar();
  const rail = collapsed && !peeking;
  const navigate = useNavigate();
  const client = useQueryClient();
  const location = useLocation();
  const activeId = location.pathname.match(/\/messages\/([^/]+)/)?.[1] ?? "";
  const [dialog, setDialog] = useState<"direct" | "group" | null>(null);
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });
  const userId = session.data?.user?.id ?? session.data?.session?.userId ?? "local-board";
  const chats = useQuery({
    queryKey: queryKeys.teamChats.list(selectedCompanyId ?? ""),
    queryFn: () => teamChatsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const directory = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId ?? ""),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId && dialog !== null,
  });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && dialog === "group",
  });
  if (!selectedCompanyId) return null;

  const labels = buildCompanyUserLabelMap(directory.data?.users);
  const people = (directory.data?.users ?? [])
    .filter((entry) => entry.status === "active" && entry.principalId !== userId)
    .map((entry) => ({ id: entry.principalId, name: labels.get(entry.principalId) ?? entry.principalId }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const liveAgents = (agents.data ?? [])
    .filter(isAgentTaskTarget)
    .map((agent) => ({ id: agent.id, name: agent.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const open = (chat: TeamChatSummary) => {
    client.setQueryData(queryKeys.teamChats.detail(chat.id), chat);
    void client.invalidateQueries({ queryKey: queryKeys.teamChats.list(selectedCompanyId) });
    if (isMobile) setSidebarOpen(false);
    navigate(`/messages/${chat.id}`);
  };
  const submit = async (input: NewTeamChatInput) => {
    if (input.mode === "add") return;
    open(
      input.mode === "direct"
        ? await teamChatsApi.openDirect(selectedCompanyId, input.userId)
        : await teamChatsApi.createGroup(selectedCompanyId, { title: input.title, userIds: input.userIds, agentIds: input.agentIds }),
    );
  };

  const list = chats.data ?? [];
  const section = (kind: "direct" | "group", heading: string, action: string) => {
    const rows = list.filter((chat) => chat.kind === kind);
    const Icon = kind === "direct" ? User : Users;
    const button = (
      <button type="button" data-slot="icon-button" aria-label={action} onClick={() => setDialog(kind)} className={ACTION}>
        <MessageSquarePlus aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : "truncate"}>{action}</span>
      </button>
    );
    return (
      <section aria-label={heading} className="flex flex-col gap-0.5">
        <span className={rail ? "sr-only" : HEADING}>{heading}</span>
        {rows.map((chat) => (
          <SidebarNavItem
            key={chat.id}
            to={`/messages/${chat.id}`}
            label={teamChatLabel(chat, userId)}
            icon={Icon}
            active={activeId === chat.id}
            badge={chat.unreadCount > 0 ? chat.unreadCount : undefined}
            badgeLabel="unread"
          />
        ))}
        {rail ? (
          <Tooltip>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent side="right">{action}</TooltipContent>
          </Tooltip>
        ) : (
          button
        )}
      </section>
    );
  };

  return (
    <div className="flex flex-col gap-1" data-tour="team-chats">
      {section("direct", "Direct messages", "New message")}
      {section("group", "Groups", "New group")}
      {agentChatsFollow && <span className={rail ? "sr-only" : HEADING}>Agent chats</span>}
      <NewTeamChatDialog
        mode={dialog ?? "direct"}
        open={dialog !== null}
        onOpenChange={(next) => !next && setDialog(null)}
        people={people}
        agents={liveAgents}
        onSubmit={submit}
      />
    </div>
  );
}
