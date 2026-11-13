import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentChatsApi } from "@/api/agentChats";
import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { teamChatsApi } from "@/api/teamChats";
import { leadChatHref, resolveLeadAgent } from "@/components/MobileEverestButton";
import { useCompany } from "@/context/CompanyContext";
import {
  agentConversationKey,
  buildConversations,
  orderConversations,
  totalUnread,
  type Conversation,
} from "@/lib/conversations";
import { queryKeys } from "@/lib/queryKeys";
import { useAgentChatEnabled } from "./useAgentChatEnabled";
import { useCompanyLiveRuns } from "./useLiveAgents";
import { useResourceMembershipMutation, useResourceMemberships } from "./useResourceMemberships";
import { useSidebarLayout } from "./useSidebarLayout";
import { useTeamChatEnabled } from "./useTeamChatEnabled";

/**
 * Every conversation the reader has, for Messages, the sidebar and the orb:
 * agent chats and team chats from their existing APIs, ordered Everest first,
 * then pins, then the newest message. Agent pins are the agent star; team chat
 * pins live in the saved sidebar layout, so both follow the reader across devices.
 */
export function useConversations() {
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });
  const userId = session.data?.user?.id ?? session.data?.session?.userId ?? null;
  const agentChat = useAgentChatEnabled();
  const teamChat = useTeamChatEnabled();
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!selectedCompanyId,
  });
  const agentChats = useQuery({
    queryKey: queryKeys.teamChats.agentList(companyId),
    queryFn: () => agentChatsApi.list(companyId),
    enabled: !!selectedCompanyId && agentChat.enabled,
  });
  const teamChats = useQuery({
    queryKey: queryKeys.teamChats.list(companyId),
    queryFn: () => teamChatsApi.list(companyId),
    enabled: !!selectedCompanyId && teamChat.enabled,
  });
  const liveRuns = useCompanyLiveRuns(selectedCompanyId);
  const memberships = useResourceMemberships(selectedCompanyId);
  const starMutation = useResourceMembershipMutation(selectedCompanyId);
  const layout = useSidebarLayout();

  const lead = useMemo(() => (agents.data ? resolveLeadAgent(agents.data) : null), [agents.data]);
  const stars = memberships.data?.starredAgentIds;
  const pinnedChats = layout.saved.pinnedChats;
  const pinnedKeys = useMemo(
    () => [...(stars ?? []).map(agentConversationKey), ...(pinnedChats ?? [])],
    [stars, pinnedChats],
  );
  const rows = useMemo(() => {
    const live = new Map<string, (string | null)[]>();
    for (const run of liveRuns.data ?? []) {
      if (run.status !== "running") continue;
      live.set(run.agentId, [...(live.get(run.agentId) ?? []), run.issueId ?? null]);
    }
    const built = buildConversations({
      agents: agentChat.enabled ? agents.data ?? [] : [],
      agentChats: agentChats.data ?? [],
      teamChats: teamChats.data ?? [],
      liveRuns: live,
      currentUserId: userId,
      leadId: lead?.id ?? null,
      alwaysShowAgentIds: stars ?? [],
      agentHref: leadChatHref,
    });
    return orderConversations(built, lead ? agentConversationKey(lead.id) : null, pinnedKeys);
  }, [agentChat.enabled, agents.data, agentChats.data, teamChats.data, liveRuns.data, userId, lead, stars, pinnedKeys]);

  const isPinned = useCallback((row: Pick<Conversation, "key">) => pinnedKeys.includes(row.key), [pinnedKeys]);
  const togglePin = useCallback(
    (row: Conversation) => {
      const pinned = pinnedKeys.includes(row.key);
      if (row.kind === "agent" && row.agent) {
        starMutation.mutate({ resourceType: "agent", resourceId: row.agent.id, resourceName: row.name, starred: !pinned });
        return;
      }
      layout.update((saved) => {
        const current = (saved.pinnedChats ?? []).filter((key) => key !== row.key);
        return { ...saved, pinnedChats: pinned ? current : [...current, row.key] };
      });
    },
    [pinnedKeys, starMutation, layout],
  );

  const error = agents.error ?? agentChats.error ?? teamChats.error ?? null;
  return {
    rows,
    agents: agents.data ?? [],
    userId,
    lead,
    leadKey: lead ? agentConversationKey(lead.id) : null,
    unread: totalUnread(rows),
    isPinned,
    togglePin,
    loading: agents.isPending && !!selectedCompanyId,
    error,
    refetch: () => {
      void agents.refetch();
      void agentChats.refetch();
      void teamChats.refetch();
    },
    agentChatEnabled: agentChat.enabled,
    teamChatEnabled: teamChat.enabled,
  };
}
