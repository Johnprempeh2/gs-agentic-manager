import type { MorningSummary, NotificationPreferences, UpdateNotificationPreferences } from "@greatstone/shared";
import { api } from "./client";

/** The signed-in person's notification choices for one company. */
export const notificationPreferencesApi = {
  get: (companyId: string) => api.get<NotificationPreferences>(`/companies/${companyId}/notification-preferences`),
  update: (companyId: string, patch: UpdateNotificationPreferences) =>
    api.patch<NotificationPreferences>(`/companies/${companyId}/notification-preferences`, patch),
};

/** The signed-in person's morning summary: what needs them, what got done, what is stuck. */
export const morningSummaryApi = {
  get: (companyId: string) => api.get<MorningSummary>(`/companies/${companyId}/morning-summary`),
};
