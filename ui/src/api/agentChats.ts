import type { AgentChatSummary, Issue } from "@greatstone/shared";
import { api } from "./client";
export const agentChatsApi = {
  /** The reader's agent chats with the newest message and unread count (Messages list). */
  list: (companyId: string) => api.get<AgentChatSummary[]>(`/companies/${companyId}/chats`),
  get: (companyId: string, agentRef: string) =>
    api.get<Issue | null>(
      `/companies/${companyId}/chats/${encodeURIComponent(agentRef)}`,
    ),
  ensure: (companyId: string, agentRef: string) =>
    api.post<Issue>(
      `/companies/${companyId}/chats/${encodeURIComponent(agentRef)}`,
      {},
    ),
};
