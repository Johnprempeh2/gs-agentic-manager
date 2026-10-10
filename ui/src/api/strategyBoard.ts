import type {
  GoalKpiAlert,
  GoalWhyRequest,
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
};
