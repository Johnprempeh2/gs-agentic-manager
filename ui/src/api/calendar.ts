import type { CompanyCalendar } from "@greatstone/shared";
import { api } from "./client";

export const calendarApi = {
  /** Dates are YYYY-MM-DD, inclusive, at most 62 days apart. */
  get: (companyId: string, from: string, to: string) =>
    api.get<CompanyCalendar>(`/companies/${companyId}/calendar?from=${from}&to=${to}`),
  /** Whether the subscribed calendar feed of deadlines is on. */
  feedStatus: (companyId: string) =>
    api.get<{ enabled: boolean; lastFetchedAt: string | null }>(`/companies/${companyId}/calendar-feed`),
  /** Turns the feed on with a new private address, returned this once. */
  enableFeed: (companyId: string) =>
    api.post<{ path: string; token: string }>(`/companies/${companyId}/calendar-feed`, {}),
  disableFeed: (companyId: string) => api.delete<{ ok: true }>(`/companies/${companyId}/calendar-feed`),
};
