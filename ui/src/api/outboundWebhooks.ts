import { api } from "./client";
import type {
  CreateOutboundWebhook,
  OutboundWebhookDelivery,
  OutboundWebhookSummary,
  OutboundWebhookWithSecret,
  UpdateOutboundWebhook,
} from "@greatstone/shared";

const base = (companyId: string) => `/companies/${companyId}/outbound-webhooks`;

export const outboundWebhooksApi = {
  list: (companyId: string) => api.get<OutboundWebhookSummary[]>(base(companyId)),
  create: (companyId: string, input: CreateOutboundWebhook) => api.post<OutboundWebhookWithSecret>(base(companyId), input),
  update: (companyId: string, id: string, input: UpdateOutboundWebhook) =>
    api.patch<OutboundWebhookSummary>(`${base(companyId)}/${id}`, input),
  test: (companyId: string, id: string) => api.post<OutboundWebhookDelivery>(`${base(companyId)}/${id}/test`, {}),
  deliveries: (companyId: string, id: string) => api.get<OutboundWebhookDelivery[]>(`${base(companyId)}/${id}/deliveries`),
  remove: (companyId: string, id: string) => api.delete<{ ok: true }>(`${base(companyId)}/${id}`),
};
