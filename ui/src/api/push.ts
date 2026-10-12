import { api } from "./client";

/** Phone notifications for decisions (Web Push), per company. */
export const pushApi = {
  config: (companyId: string, endpoint?: string | null) =>
    api.get<{ publicKey: string; subscribed: boolean }>(
      `/companies/${companyId}/push/config${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ""}`,
    ),
  subscribe: (companyId: string, subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    api.post<{ ok: true }>(`/companies/${companyId}/push/subscriptions`, subscription),
  unsubscribe: (companyId: string, endpoint: string) =>
    api.deleteWithBody<{ ok: true; removed: boolean }>(`/companies/${companyId}/push/subscriptions`, { endpoint }),
  test: (companyId: string) =>
    api.post<{ targets: number; delivered: number }>(`/companies/${companyId}/push/test`, {}),
};
