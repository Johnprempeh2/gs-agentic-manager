import { api } from "./client";
import type {
  MailboxAgentsInput,
  MailboxConnectInput,
  MailboxOAuthAppInput,
  MailboxOAuthAppSummary,
  MailboxOAuthProvider,
  MailboxOAuthStartInput,
  MailboxSummary,
} from "@greatstone/shared";

export const mailboxesApi = {
  list: (companyId: string) =>
    api.get<MailboxSummary[]>(`/companies/${companyId}/mailboxes`),
  connect: (companyId: string, input: MailboxConnectInput) =>
    api.post<MailboxSummary>(`/companies/${companyId}/mailboxes`, input),
  setAgents: (companyId: string, id: string, input: MailboxAgentsInput) =>
    api.put<MailboxSummary>(`/companies/${companyId}/mailboxes/${id}/agents`, input),
  setDrafts: (companyId: string, id: string, allowDrafts: boolean) =>
    api.put<MailboxSummary>(`/companies/${companyId}/mailboxes/${id}/drafts`, { allowDrafts }),
  test: (companyId: string, id: string) =>
    api.post<{ ok: true; folderCount: number }>(
      `/companies/${companyId}/mailboxes/${id}/test`,
      {},
    ),
  oauthApps: (companyId: string) =>
    api.get<MailboxOAuthAppSummary[]>(`/companies/${companyId}/mailbox-oauth/apps`),
  saveOAuthApp: (companyId: string, provider: MailboxOAuthProvider, input: MailboxOAuthAppInput) =>
    api.put<MailboxOAuthAppSummary>(`/companies/${companyId}/mailbox-oauth/apps/${provider}`, input),
  startOAuth: (companyId: string, input: MailboxOAuthStartInput) =>
    api.post<{ authorizationUrl: string }>(`/companies/${companyId}/mailbox-oauth/start`, input),
  remove: (companyId: string, id: string) =>
    api.delete<{ id: string; removed: true }>(`/companies/${companyId}/mailboxes/${id}`),
};
