import type {
  GoalKpiAlert,
  GoalWhyRequest,
  StrategyBoardEmail,
  StrategyBoardMember,
  StrategyBoardPack,
  StrategyBoardPackListItem,
  StrategyBoardSettings,
  StrategyBoardSummary,
  UpdateStrategyBoardSettings,
} from "@greatstone/shared";
import { api } from "./client";

/** Board control panel (GRE-1135). Every call answers 403 while enableStrategyBoard is off. */
export const strategyBoardApi = {
  summary: (companyId: string) => api.get<StrategyBoardSummary>(`/companies/${companyId}/strategy-board`),
  alerts: (companyId: string) => api.get<GoalKpiAlert[]>(`/companies/${companyId}/strategy-board/alerts`),
  members: (companyId: string) => api.get<StrategyBoardMember[]>(`/companies/${companyId}/strategy-board/members`),
  setMembers: (companyId: string, members: Array<{ userId: string; chair: boolean }>) =>
    api.put<StrategyBoardMember[]>(`/companies/${companyId}/strategy-board/members`, { members }),
  settings: (companyId: string) => api.get<StrategyBoardSettings>(`/companies/${companyId}/strategy-board/settings`),
  updateSettings: (companyId: string, patch: UpdateStrategyBoardSettings) =>
    api.patch<StrategyBoardSettings>(`/companies/${companyId}/strategy-board/settings`, patch),
  emails: (companyId: string) => api.get<StrategyBoardEmail[]>(`/companies/${companyId}/strategy-board/emails`),
  listPacks: (companyId: string) => api.get<StrategyBoardPackListItem[]>(`/companies/${companyId}/strategy-board/packs`),
  createPack: (companyId: string, data: { periodStart: string; periodEnd: string; title?: string }) =>
    api.post<StrategyBoardPack>(`/companies/${companyId}/strategy-board/packs`, data),
  getPack: (id: string) => api.get<StrategyBoardPack>(`/strategy-board/packs/${id}`),
  /** A board member accepts the board secretary's draft (GRE-1200). */
  acceptPack: (id: string) => api.post<StrategyBoardPack>(`/strategy-board/packs/${id}/accept`, {}),
  listWhyRequests: (goalId: string) => api.get<GoalWhyRequest[]>(`/goals/${goalId}/why-requests`),
  askWhy: (goalId: string, question: string) => api.post<GoalWhyRequest>(`/goals/${goalId}/why-requests`, { question }),
  answerWhy: (id: string, answer: string) => api.post<GoalWhyRequest>(`/why-requests/${id}/answer`, { answer }),
};
