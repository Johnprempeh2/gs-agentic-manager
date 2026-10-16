import type { WeeklyReport } from "@greatstone/shared";
import { api } from "./client";

/** "This week at Greatstone": the weekly executive report for the signed-in person. */
export const weeklyReportApi = {
  get: (companyId: string) => api.get<WeeklyReport>(`/companies/${companyId}/weekly-report`),
};
