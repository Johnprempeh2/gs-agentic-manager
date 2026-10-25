import type {
  CreateDeepDiveCommercial,
  CreateDeepDiveRoadmapItem,
  DeepDiveTraceability,
  UpdateDeepDiveCommercial,
  UpdateDeepDiveRoadmapItem,
} from "@greatstone/shared";
import { api } from "./client";

// Deep Dive traceability (GRE-2371). Mirrors
// server/src/routes/deep-dive-traceability.ts. Every write returns the whole
// chain with its broken links, so the page replaces it in one go.

export const deepDiveTraceabilityQueryKeys = {
  chain: (companyId: string) => ["deep-dive-traceability", companyId] as const,
};

export const deepDiveTraceabilityApi = {
  get: (companyId: string) => api.get<DeepDiveTraceability>(`/companies/${companyId}/deep-dive/traceability`),
  addCommercial: (companyId: string, input: CreateDeepDiveCommercial) =>
    api.post<DeepDiveTraceability>(`/companies/${companyId}/deep-dive/commercials`, input),
  updateCommercial: (commercialId: string, input: UpdateDeepDiveCommercial) =>
    api.patch<DeepDiveTraceability>(`/deep-dive/commercials/${commercialId}`, input),
  removeCommercial: (commercialId: string) => api.delete<DeepDiveTraceability>(`/deep-dive/commercials/${commercialId}`),
  addRoadmapItem: (companyId: string, input: CreateDeepDiveRoadmapItem) =>
    api.post<DeepDiveTraceability>(`/companies/${companyId}/deep-dive/roadmap`, input),
  updateRoadmapItem: (roadmapItemId: string, input: UpdateDeepDiveRoadmapItem) =>
    api.patch<DeepDiveTraceability>(`/deep-dive/roadmap/${roadmapItemId}`, input),
  removeRoadmapItem: (roadmapItemId: string) => api.delete<DeepDiveTraceability>(`/deep-dive/roadmap/${roadmapItemId}`),
};
