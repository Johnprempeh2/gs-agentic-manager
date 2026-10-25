import type { DeepDiveOverview } from "@greatstone/shared";
import { api } from "./client";

// Deep Dive overview (GRE-2372). Mirrors server/src/routes/deep-dive-overview.ts:
// one read, no writes.

export const deepDiveOverviewQueryKeys = {
  overview: (companyId: string) => ["deep-dive-overview", companyId] as const,
};

export const deepDiveOverviewApi = {
  get: (companyId: string) => api.get<DeepDiveOverview>(`/companies/${companyId}/deep-dive/overview`),
};
