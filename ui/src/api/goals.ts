import type { Goal, GoalCheckIn, GoalDetail, GoalWithProgress } from "@greatstone/shared";
import { api } from "./client";

export const goalsApi = {
  list: (companyId: string) => api.get<GoalWithProgress[]>(`/companies/${companyId}/goals`),
  get: (id: string) => api.get<GoalDetail>(`/goals/${id}`),
  listCheckIns: (id: string) => api.get<GoalCheckIn[]>(`/goals/${id}/check-ins`),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Goal>(`/companies/${companyId}/goals`, data),
  update: (id: string, data: Record<string, unknown>) => api.patch<Goal>(`/goals/${id}`, data),
  remove: (id: string) => api.delete<Goal>(`/goals/${id}`),
};
