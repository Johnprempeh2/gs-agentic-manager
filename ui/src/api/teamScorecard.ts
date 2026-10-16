import type { TeamScorecard } from "@greatstone/shared";
import { api } from "./client";

export const teamScorecardApi = {
  get: (companyId: string, days: 7 | 30) => api.get<TeamScorecard>(`/companies/${companyId}/team-scorecard?days=${days}`),
};
