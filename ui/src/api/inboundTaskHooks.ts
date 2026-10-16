import { api } from "./client";
import type {
  CreateInboundTaskHook,
  InboundTaskHookSummary,
  InboundTaskHookWithToken,
  UpdateInboundTaskHook,
} from "@greatstone/shared";

const base = (companyId: string) => `/companies/${companyId}/inbound-task-hooks`;

export const inboundTaskHooksApi = {
  list: (companyId: string) => api.get<InboundTaskHookSummary[]>(base(companyId)),
  create: (companyId: string, input: CreateInboundTaskHook) => api.post<InboundTaskHookWithToken>(base(companyId), input),
  update: (companyId: string, id: string, input: UpdateInboundTaskHook) =>
    api.patch<InboundTaskHookSummary>(`${base(companyId)}/${id}`, input),
  rotate: (companyId: string, id: string) => api.post<InboundTaskHookWithToken>(`${base(companyId)}/${id}/rotate`, {}),
  remove: (companyId: string, id: string) => api.delete<{ ok: true }>(`${base(companyId)}/${id}`),
};
