import type { DeepDiveScope } from "@greatstone/shared";
import type {
  CreateDeepDiveBuild,
  CreateDeepDiveKpi,
  CreateDeepDiveOpportunity,
  DeepDiveOpportunityBoard,
  UpdateDeepDiveBuild,
  UpdateDeepDiveKpi,
  UpdateDeepDiveOpportunity,
} from "@greatstone/shared";
import { api } from "./client";

// Deep Dive opportunities and KPIs (GRE-2370). Mirrors
// server/src/routes/deep-dive-opportunities.ts. Every write returns the whole
// board, so the page replaces it in one go.

export const deepDiveOpportunitiesQueryKeys = {
  board: (scope: DeepDiveScope) => ["deep-dive-opportunities", scope.companyId, scope.recordCaseId] as const,
};

export const deepDiveOpportunitiesApi = {
  get: (scope: DeepDiveScope) => api.get<DeepDiveOpportunityBoard>(`/companies/${scope.companyId}/deep-dive/opportunities?recordId=${scope.recordCaseId}`),
  addOpportunity: (scope: DeepDiveScope, input: CreateDeepDiveOpportunity) =>
    api.post<DeepDiveOpportunityBoard>(`/companies/${scope.companyId}/deep-dive/opportunities?recordId=${scope.recordCaseId}`, input),
  updateOpportunity: (opportunityId: string, input: UpdateDeepDiveOpportunity) =>
    api.patch<DeepDiveOpportunityBoard>(`/deep-dive/opportunities/${opportunityId}`, input),
  removeOpportunity: (opportunityId: string) => api.delete<DeepDiveOpportunityBoard>(`/deep-dive/opportunities/${opportunityId}`),
  addBuild: (scope: DeepDiveScope, input: CreateDeepDiveBuild) =>
    api.post<DeepDiveOpportunityBoard>(`/companies/${scope.companyId}/deep-dive/builds?recordId=${scope.recordCaseId}`, input),
  updateBuild: (buildId: string, input: UpdateDeepDiveBuild) => api.patch<DeepDiveOpportunityBoard>(`/deep-dive/builds/${buildId}`, input),
  removeBuild: (buildId: string) => api.delete<DeepDiveOpportunityBoard>(`/deep-dive/builds/${buildId}`),
  addKpi: (scope: DeepDiveScope, input: CreateDeepDiveKpi) =>
    api.post<DeepDiveOpportunityBoard>(`/companies/${scope.companyId}/deep-dive/kpis?recordId=${scope.recordCaseId}`, input),
  updateKpi: (kpiId: string, input: UpdateDeepDiveKpi) => api.patch<DeepDiveOpportunityBoard>(`/deep-dive/kpis/${kpiId}`, input),
  removeKpi: (kpiId: string) => api.delete<DeepDiveOpportunityBoard>(`/deep-dive/kpis/${kpiId}`),
};
