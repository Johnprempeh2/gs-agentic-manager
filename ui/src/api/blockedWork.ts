import type { BlockedWorkOverview } from "@greatstone/shared";
import { api } from "./client";

export const blockedWorkApi = {
  /** Every blocked task with its wait, who must act, and the root task holding each chain. */
  overview: (companyId: string) => api.get<BlockedWorkOverview>(`/companies/${companyId}/blocked-work`),
};
