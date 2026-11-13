import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, Pin, PinOff, Plus, UserRound } from "lucide-react";
import type { TeamChatSummary } from "@greatstone/shared";
import { accessApi } from "@/api/access";
import { teamChatsApi } from "@/api/teamChats";
import { ConversationList, TypingDots } from "@/components/ConversationList";
import { ErrorState } from "@/components/ErrorState";
import { NewMessageDialog } from "@/components/NewMessageDialog";
import { NewTeamChatDialog, type NewTeamChatInput } from "@/components/NewTeamChatDialog";
import { Button } from "@/components/ui/button";
import { useCompany } from "@/context/CompanyContext";
import { useToastActions } from "@/context/ToastContext";
import { useConversations } from "@/hooks/useConversations";
import { buildCompanyUserLabelMap, isAgentTaskTarget } from "@/lib/company-members";
import { agentConversationKey, chatConversationKey, conversationStatus } from "@/lib/conversations";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { agentRouteRef } from "@/lib/utils";
import { agentDetailHref } from "@/pages/agent-detail-navigation";
import { leadChatHref } from "./MobileEverestButton";

/** Which conversation the current address opens, as its list key. */
export function activeConversationKey(
  pathname: string,
  agents: readonly { id: string; name: string; urlKey?: string | null }[],
): string | null {
  const chat = /\/messages\/([^/?#]+)/.exec(pathname)?.[1];
  if (chat) return chatConversationKey(decodeURIComponent(chat));
  const ref = /\/chats\/([^/?#]+)/.exec(pathname)?.[1];
  if (!ref) return null;
  const decoded = decodeURIComponent(ref);
  const agent = agents.find((candidate) => candidate.id === decoded || agentRouteRef(candidate) === decoded);
  return agent ? agentConversationKey(agent.id) : null;
}

/**
 * Messages' left pane with its data: every conversation (useConversations),
 * search, and New message (an agent, a person, or a new group). Desktop shows
 * it beside the open thread; phones show it as the Messages page.
 */
export function MessagesPane({ className, heading = true }: { className?: string; heading?: boolean }) {
  const { selectedCompanyId } = useCompany();
  const conversations = useConversations();
  const [query, setQuery] = useState("");
  const [picker, setPicker] = useState(false);
  const [group, setGroup] = useState(false);
  const navigate = useNavigate();
  const client = useQueryClient();
  const { pushToast } = useToastActions();
  const { pathname } = useLocation();
  const { agents: agentList, userId } = conversations;
  const directory = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId ?? ""),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId && conversations.teamChatEnabled && (picker || group),
  });
  const labels = buildCompanyUserLabelMap(directory.data?.users);
  const people = (directory.data?.users ?? [])
    .filter((entry) => entry.status === "active" && entry.principalId !== userId)
    .map((entry) => ({ id: entry.principalId, name: labels.get(entry.principalId) ?? entry.principalId }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const chatAgents = agentList.filter(isAgentTaskTarget).sort((a, b) => a.name.localeCompare(b.name));

  const openChat = (chat: TeamChatSummary) => {
    client.setQueryData(queryKeys.teamChats.detail(chat.id), chat);
    void client.invalidateQueries({ queryKey: queryKeys.teamChats.all });
    navigate(`/messages/${chat.id}`);
  };
  const failed = () => pushToast({ title: "Could not start that chat", body: "Try again in a moment.", tone: "error" });
  const submitGroup = async (input: NewTeamChatInput) => {
    if (input.mode !== "group" || !selectedCompanyId) return;
    openChat(await teamChatsApi.createGroup(selectedCompanyId, { title: input.title, userIds: input.userIds, agentIds: input.agentIds }));
  };

  return (
    <div className={className} data-testid="messages-pane">
      {heading ? <h2 className="px-4 pb-2 pt-3 text-lg font-bold tracking-tight text-foreground">Messages</h2> : null}
      <ConversationList
        rows={conversations.rows}
        activeKey={activeConversationKey(pathname, agentList)}
        query={query}
        onQueryChange={setQuery}
        isPinned={conversations.isPinned}
        notice={conversations.error ? (
          <ErrorState compact className="px-4" error={conversations.error} title="Could not load every chat" onRetry={conversations.refetch} />
        ) : null}
        newMessage={
          <Button type="button" onClick={() => setPicker(true)} className="h-11 gap-2 rounded-full px-4 shadow-sm" data-testid="new-message">
            <Plus aria-hidden="true" className="size-4" />
            New message
          </Button>
        }
      />
      <NewMessageDialog
        open={picker}
        onOpenChange={setPicker}
        agents={conversations.agentChatEnabled ? chatAgents : []}
        people={conversations.teamChatEnabled ? people : []}
        onNewGroup={conversations.teamChatEnabled ? () => setGroup(true) : undefined}
        onPickAgent={(agentId) => {
          const agent = chatAgents.find((candidate) => candidate.id === agentId);
          if (agent) navigate(leadChatHref(agent));
        }}
        onPickPerson={(personId) => {
          if (!selectedCompanyId) return;
          teamChatsApi.openDirect(selectedCompanyId, personId).then(openChat, failed);
        }}
      />
      <NewTeamChatDialog
        mode="group"
        open={group}
        onOpenChange={setGroup}
        people={people}
        agents={chatAgents.map((agent) => ({ id: agent.id, name: agent.name }))}
        onSubmit={submitGroup}
      />
    </div>
  );
}

/**
 * The thread header's right side in Messages (a breadcrumb trailing node, so
 * it reads its own data): what the agent is doing, pin, mute for team chats,
 * and the agent's profile.
 */
export function ConversationHeaderActions({ conversationKey }: { conversationKey: string }) {
  const { rows, isPinned, togglePin } = useConversations();
  const client = useQueryClient();
  const { pushToast } = useToastActions();
  const row = rows.find((candidate) => candidate.key === conversationKey);
  if (!row) return null;
  const pinned = isPinned(row);
  const icon = "size-8 text-muted-foreground hover:text-foreground pointer-coarse:size-11";
  const toggleMute = () => {
    if (!row.issueId) return;
    teamChatsApi.setMuted(row.issueId, !row.muted).then(
      (next) => {
        client.setQueryData(queryKeys.teamChats.detail(next.id), next);
        void client.invalidateQueries({ queryKey: queryKeys.teamChats.all });
      },
      () => pushToast({ title: row.muted ? "Could not turn alerts back on" : "Could not mute this chat", body: "Try again in a moment.", tone: "error" }),
    );
  };
  return (
    <span className="ml-2 flex items-center gap-1" data-testid="conversation-header-actions">
      <span className="mr-1 flex items-center gap-1.5 whitespace-nowrap text-xs font-normal text-muted-foreground @max-md/bar:sr-only" aria-live="polite">
        {row.typing ? <TypingDots className="text-foreground" /> : null}
        {conversationStatus(row)}
      </span>
      <Button type="button" variant="ghost" size="icon-sm" className={icon} aria-pressed={pinned} aria-label={pinned ? `Unpin ${row.name}` : `Pin ${row.name}`} title={pinned ? "Unpin" : "Pin to the top and the sidebar"} onClick={() => togglePin(row)}>
        {pinned ? <PinOff aria-hidden="true" className="size-4" /> : <Pin aria-hidden="true" className="size-4" />}
      </Button>
      {row.kind !== "agent" ? (
        <Button type="button" variant="ghost" size="icon-sm" className={icon} aria-pressed={row.muted} aria-label={row.muted ? "Unmute" : "Mute"} title={row.muted ? "Muted: you hear only @mentions" : "Mute: alert only when you are @mentioned"} onClick={toggleMute}>
          {row.muted ? <BellOff aria-hidden="true" className="size-4" /> : <Bell aria-hidden="true" className="size-4" />}
        </Button>
      ) : null}
      {row.agent ? (
        <Button variant="ghost" size="icon-sm" className={icon} asChild aria-label={`Open ${row.name}'s profile`} title="Profile">
          <Link to={agentDetailHref(row.agent.id)}><UserRound aria-hidden="true" className="size-4" /></Link>
        </Button>
      ) : null}
    </span>
  );
}
