import type { AddTeamChatMembers, CreateTeamChat, TeamChatSummary } from "@greatstone/shared";
import { api } from "./client";

export const teamChatsApi = {
  list: (companyId: string) => api.get<TeamChatSummary[]>(`/companies/${companyId}/team-chats`),
  get: (chatId: string) => api.get<TeamChatSummary>(`/team-chats/${chatId}`),
  createGroup: (companyId: string, data: Pick<CreateTeamChat, "title"> & Partial<AddTeamChatMembers>) =>
    api.post<TeamChatSummary>(`/companies/${companyId}/team-chats`, data),
  openDirect: (companyId: string, userId: string) =>
    api.post<TeamChatSummary>(`/companies/${companyId}/team-chats/direct`, { userId }),
  addMembers: (chatId: string, data: Partial<AddTeamChatMembers>) =>
    api.post<TeamChatSummary>(`/team-chats/${chatId}/members`, data),
  removeMember: (chatId: string, type: "user" | "agent", principalId: string) =>
    api.delete<TeamChatSummary>(`/team-chats/${chatId}/members/${type}/${encodeURIComponent(principalId)}`),
};
