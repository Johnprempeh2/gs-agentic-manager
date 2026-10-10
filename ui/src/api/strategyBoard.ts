import type {
  GoalKpiAlert,
  GoalWhyRequest,
  Issue,
  StrategyBoardAgent,
  StrategyBoardMember,
  StrategyBoardPack,
  StrategyBoardPackListItem,
  StrategyBoardSummary,
} from "@greatstone/shared";
import { api } from "./client";

/** Board control panel (GRE-1135). Every call answers 403 while enableStrategyBoard is off. */
export const strategyBoardApi = {
  summary: (companyId: string) => api.get<StrategyBoardSummary>(`/companies/${companyId}/strategy-board`),
  alerts: (companyId: string) => api.get<GoalKpiAlert[]>(`/companies/${companyId}/strategy-board/alerts`),
  members: (companyId: string) => api.get<StrategyBoardMember[]>(`/companies/${companyId}/strategy-board/members`),
  setMembers: (companyId: string, members: Array<{ userId: string; chair: boolean }>) =>
    api.put<StrategyBoardMember[]>(`/companies/${companyId}/strategy-board/members`, { members }),
  listPacks: (companyId: string) => api.get<StrategyBoardPackListItem[]>(`/companies/${companyId}/strategy-board/packs`),
  createPack: (companyId: string, data: { periodStart: string; periodEnd: string; title?: string }) =>
    api.post<StrategyBoardPack>(`/companies/${companyId}/strategy-board/packs`, data),
  getPack: (id: string) => api.get<StrategyBoardPack>(`/strategy-board/packs/${id}`),
  listWhyRequests: (goalId: string) => api.get<GoalWhyRequest[]>(`/goals/${goalId}/why-requests`),
  askWhy: (goalId: string, question: string) => api.post<GoalWhyRequest>(`/goals/${goalId}/why-requests`, { question }),
  answerWhy: (id: string, answer: string) => api.post<GoalWhyRequest>(`/why-requests/${id}/answer`, { answer }),
  /** Board agent chat (GRE-1186): the agents the signed-in board member may ask. */
  agents: (companyId: string) => api.get<StrategyBoardAgent[]>(`/companies/${companyId}/strategy-board/agents`),
  setMemberAgents: (companyId: string, userId: string, agentIds: string[]) =>
    api.put<{ userId: string; agentIds: string[] }>(
      `/companies/${companyId}/strategy-board/members/${encodeURIComponent(userId)}/agents`,
      { agentIds },
    ),
  getChat: (companyId: string, agentId: string) => api.get<Issue | null>(`/companies/${companyId}/strategy-board/chats/${agentId}`),
  openChat: (companyId: string, agentId: string) => api.post<Issue>(`/companies/${companyId}/strategy-board/chats/${agentId}`, {}),
};
