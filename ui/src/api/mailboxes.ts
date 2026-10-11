import { api } from "./client";
import type {
  MailboxAgentsInput,
  MailboxConnectInput,
  MailboxSummary,
} from "@greatstone/shared";

export const mailboxesApi = {
  list: (companyId: string) =>
    api.get<MailboxSummary[]>(`/companies/${companyId}/mailboxes`),
  connect: (companyId: string, input: MailboxConnectInput) =>
    api.post<MailboxSummary>(`/companies/${companyId}/mailboxes`, input),
  setAgents: (companyId: string, id: string, input: MailboxAgentsInput) =>
    api.put<MailboxSummary>(`/companies/${companyId}/mailboxes/${id}/agents`, input),
  test: (companyId: string, id: string) =>
    api.post<{ ok: true; folderCount: number }>(
      `/companies/${companyId}/mailboxes/${id}/test`,
      {},
    ),
  remove: (companyId: string, id: string) =>
    api.delete<{ id: string; removed: true }>(`/companies/${companyId}/mailboxes/${id}`),
};
