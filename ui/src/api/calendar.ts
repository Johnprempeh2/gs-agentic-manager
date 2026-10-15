import type { CompanyCalendar } from "@greatstone/shared";
import { api } from "./client";

export const calendarApi = {
  /** Dates are YYYY-MM-DD, inclusive, at most 62 days apart. */
  get: (companyId: string, from: string, to: string) =>
    api.get<CompanyCalendar>(`/companies/${companyId}/calendar?from=${from}&to=${to}`),
};
