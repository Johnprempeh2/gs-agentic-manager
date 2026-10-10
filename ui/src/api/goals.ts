import type { Goal, GoalCheckIn, GoalDetail, GoalKpiReading, GoalWithProgress, KpiDraftRow } from "@greatstone/shared";
import { api } from "./client";

export const goalsApi = {
  list: (companyId: string) => api.get<GoalWithProgress[]>(`/companies/${companyId}/goals`),
  get: (id: string) => api.get<GoalDetail>(`/goals/${id}`),
  listCheckIns: (id: string) => api.get<GoalCheckIn[]>(`/goals/${id}/check-ins`),
  /** KPI readings, newest first. */
  listReadings: (id: string) => api.get<GoalKpiReading[]>(`/goals/${id}/readings`),
  /** Board users may only post owner_reported; agents post agent_verified or system. */
  createReading: (id: string, data: { value: number; readingDate: string; note?: string | null }) =>
    api.post<GoalKpiReading>(`/goals/${id}/readings`, data),
  /** Draft KPIs under this goal from slide-5 rows of a research pack document, in one transaction. */
  createKpiDrafts: (id: string, data: { sourceIssueId: string; documentKey?: string; rows: KpiDraftRow[] }) =>
    api.post<Goal[]>(`/goals/${id}/kpi-drafts`, data),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Goal>(`/companies/${companyId}/goals`, data),
  /** Creates the empty one-page strategic plan (vision, values, CSF, objective, KPI). Company owners only. */
  createStrategicPlan: (companyId: string) => api.post<Goal[]>(`/companies/${companyId}/goals/strategic-plan`, {}),
  update: (id: string, data: Record<string, unknown>) => api.patch<Goal>(`/goals/${id}`, data),
  remove: (id: string) => api.delete<Goal>(`/goals/${id}`),
};
