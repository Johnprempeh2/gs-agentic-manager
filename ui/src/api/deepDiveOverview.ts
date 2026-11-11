import type { DeepDiveScope } from "@greatstone/shared";
import type { DeepDiveOverview } from "@greatstone/shared";
import { api } from "./client";

// Deep Dive overview (GRE-2372). Mirrors server/src/routes/deep-dive-overview.ts:
// one read, no writes.

export const deepDiveOverviewQueryKeys = {
  overview: (scope: DeepDiveScope) => ["deep-dive-overview", scope.companyId, scope.recordCaseId] as const,
};

export const deepDiveOverviewApi = {
  get: (scope: DeepDiveScope) => api.get<DeepDiveOverview>(`/companies/${scope.companyId}/deep-dive/overview?recordId=${scope.recordCaseId}`),
};
