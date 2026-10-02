import type { AgentWorkDigest, AgentWorkDigestVisit } from "@greatstone/shared";
import { api } from "./client";

export const agentWorkDigestApi = {
  /** Without `since` the server uses the viewer's last visit, then the last 24 hours. */
  get: (companyId: string) => api.get<AgentWorkDigest>(`/companies/${companyId}/agent-work-digest`),
  recordVisit: (companyId: string) =>
    api.post<AgentWorkDigestVisit>(`/companies/${companyId}/agent-work-digest/visit`, {}),
};
