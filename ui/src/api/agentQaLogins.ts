import { api } from "./client";

/** An agent's browser QA log-in (GRE-2387). The server never sends a password. */
export type AgentQaLogin = {
  id: string;
  agentId: string;
  userId: string;
  email: string;
  role: "viewer" | "operator";
  status: "active" | "revoked" | "expired";
  expiresAt: string;
  grantedByUserId: string;
  createdAt: string;
  endedAt: string | null;
};

export const agentQaLoginsApi = {
  get: (agentId: string) => api.get<{ qaLogin: AgentQaLogin | null }>(`/agents/${encodeURIComponent(agentId)}/qa-login`),
  grant: (agentId: string, input: { role: "viewer" | "operator"; expiresInDays: number }) =>
    api.post<{ qaLogin: AgentQaLogin }>(`/agents/${encodeURIComponent(agentId)}/qa-login`, input),
  revoke: (agentId: string) => api.delete<{ qaLogin: AgentQaLogin }>(`/agents/${encodeURIComponent(agentId)}/qa-login`),
};
