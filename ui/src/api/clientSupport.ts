import type {
  ClientSupportStatus,
  FleetSupportContentType,
  FleetSupportKind,
  FleetSupportPriority,
} from "@greatstone/shared/fleet-support";
import { api } from "./client";

/** A "Get help" ticket as the client instance holds it (GRE-1084). */
export interface ClientSupportTicket {
  id: string;
  companyId: string;
  kind: FleetSupportKind;
  title: string;
  summary: string;
  priority: FleetSupportPriority;
  linkedIssueId: string | null;
  status: ClientSupportStatus;
  refusedReason: string | null;
  hubTicketId: string | null;
  hubOwner: string | null;
  firstResponseDueAt: string | null;
  firstResponseAt: string | null;
  createdAt: string;
  updatedAt: string;
  replies: Array<{ id: string; body: string; sentAt: string }>;
  attachments: Array<{
    id: string;
    name: string;
    contentType: string;
    byteSize: number;
    sentAt: string | null;
    createdAt: string;
  }>;
}

export interface CreateClientSupportTicket {
  kind: FleetSupportKind;
  title: string;
  summary: string;
  priority: FleetSupportPriority;
  linkedIssueId?: string | null;
}

const base = (companyId: string) => `/companies/${encodeURIComponent(companyId)}/client-support/tickets`;

export const clientSupportApi = {
  list: (companyId: string) => api.get<ClientSupportTicket[]>(base(companyId)),
  /** Board users only; the server refuses agents. */
  create: (companyId: string, body: CreateClientSupportTicket) => api.post<ClientSupportTicket>(base(companyId), body),
  /** 409 once the ticket is resolved or closed. */
  edit: (companyId: string, ticketId: string, body: { title?: string; summary?: string }) =>
    api.patch<ClientSupportTicket>(`${base(companyId)}/${encodeURIComponent(ticketId)}`, body),
  attach: (
    companyId: string,
    ticketId: string,
    body: { name: string; contentType: FleetSupportContentType; contentBase64: string },
  ) => api.post<unknown>(`${base(companyId)}/${encodeURIComponent(ticketId)}/attachments`, body),
};
