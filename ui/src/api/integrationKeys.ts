import { api } from "./client";
import type { IntegrationKeysStatus } from "@greatstone/shared";

export const integrationKeysApi = {
  status: (companyId: string) => api.get<IntegrationKeysStatus>(`/companies/${companyId}/integration-keys`),
};
