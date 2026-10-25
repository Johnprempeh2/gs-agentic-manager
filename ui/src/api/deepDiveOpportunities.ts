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
  board: (companyId: string) => ["deep-dive-opportunities", companyId] as const,
};

export const deepDiveOpportunitiesApi = {
  get: (companyId: string) => api.get<DeepDiveOpportunityBoard>(`/companies/${companyId}/deep-dive/opportunities`),
  addOpportunity: (companyId: string, input: CreateDeepDiveOpportunity) =>
    api.post<DeepDiveOpportunityBoard>(`/companies/${companyId}/deep-dive/opportunities`, input),
  updateOpportunity: (opportunityId: string, input: UpdateDeepDiveOpportunity) =>
    api.patch<DeepDiveOpportunityBoard>(`/deep-dive/opportunities/${opportunityId}`, input),
  removeOpportunity: (opportunityId: string) => api.delete<DeepDiveOpportunityBoard>(`/deep-dive/opportunities/${opportunityId}`),
  addBuild: (companyId: string, input: CreateDeepDiveBuild) =>
    api.post<DeepDiveOpportunityBoard>(`/companies/${companyId}/deep-dive/builds`, input),
  updateBuild: (buildId: string, input: UpdateDeepDiveBuild) => api.patch<DeepDiveOpportunityBoard>(`/deep-dive/builds/${buildId}`, input),
  removeBuild: (buildId: string) => api.delete<DeepDiveOpportunityBoard>(`/deep-dive/builds/${buildId}`),
  addKpi: (companyId: string, input: CreateDeepDiveKpi) =>
    api.post<DeepDiveOpportunityBoard>(`/companies/${companyId}/deep-dive/kpis`, input),
  updateKpi: (kpiId: string, input: UpdateDeepDiveKpi) => api.patch<DeepDiveOpportunityBoard>(`/deep-dive/kpis/${kpiId}`, input),
  removeKpi: (kpiId: string) => api.delete<DeepDiveOpportunityBoard>(`/deep-dive/kpis/${kpiId}`),
};
