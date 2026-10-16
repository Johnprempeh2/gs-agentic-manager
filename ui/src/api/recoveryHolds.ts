import type { RecoveryHoldList } from "@greatstone/shared";
import { api } from "./client";

export const recoveryHoldsApi = {
  /** Tasks held until someone records what their last run did. */
  list: (companyId: string) => api.get<RecoveryHoldList>(`/companies/${companyId}/recovery-holds`),
};
