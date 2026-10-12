import type { AgentTeam, CreateAgentTeam, UpdateAgentTeam } from "@greatstone/shared";
import { api } from "./client";

export const agentTeamsApi = {
  list: (companyId: string) => api.get<AgentTeam[]>(`/companies/${companyId}/agent-teams`),
  create: (companyId: string, data: CreateAgentTeam) =>
    api.post<AgentTeam>(`/companies/${companyId}/agent-teams`, data),
  update: (id: string, data: UpdateAgentTeam) => api.patch<AgentTeam>(`/agent-teams/${id}`, data),
  remove: (id: string) => api.delete<AgentTeam>(`/agent-teams/${id}`),
};
