import type { DeepDiveScope } from "@greatstone/shared";
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
  chain: (scope: DeepDiveScope) => ["deep-dive-traceability", scope.companyId, scope.recordCaseId] as const,
};

export const deepDiveTraceabilityApi = {
  get: (scope: DeepDiveScope) => api.get<DeepDiveTraceability>(`/companies/${scope.companyId}/deep-dive/traceability?recordId=${scope.recordCaseId}`),
  addCommercial: (scope: DeepDiveScope, input: CreateDeepDiveCommercial) =>
    api.post<DeepDiveTraceability>(`/companies/${scope.companyId}/deep-dive/commercials?recordId=${scope.recordCaseId}`, input),
  updateCommercial: (commercialId: string, input: UpdateDeepDiveCommercial) =>
    api.patch<DeepDiveTraceability>(`/deep-dive/commercials/${commercialId}`, input),
  removeCommercial: (commercialId: string) => api.delete<DeepDiveTraceability>(`/deep-dive/commercials/${commercialId}`),
  addRoadmapItem: (scope: DeepDiveScope, input: CreateDeepDiveRoadmapItem) =>
    api.post<DeepDiveTraceability>(`/companies/${scope.companyId}/deep-dive/roadmap?recordId=${scope.recordCaseId}`, input),
  updateRoadmapItem: (roadmapItemId: string, input: UpdateDeepDiveRoadmapItem) =>
    api.patch<DeepDiveTraceability>(`/deep-dive/roadmap/${roadmapItemId}`, input),
  removeRoadmapItem: (roadmapItemId: string) => api.delete<DeepDiveTraceability>(`/deep-dive/roadmap/${roadmapItemId}`),
};
