import type {
  AcceptClientDeliverable,
  ClientPublicationsResponse,
  CreateClientPublicationLinkResponse,
  EngagementTimeline,
  PublicClientDeliverable,
} from "@greatstone/shared";
import { api } from "./client";

// Clients > Deliverables publishing and the engagement timeline (GRE-2373).
export const clientPublicationsApi = {
  list: (caseId: string) => api.get<ClientPublicationsResponse>(`/cases/${caseId}/publications`),
  timeline: (caseId: string) => api.get<EngagementTimeline>(`/cases/${caseId}/timeline`),
  registerApprover: (caseId: string, userId: string) => api.post<{ id: string }>(`/cases/${caseId}/approvers`, { userId }),
  removeApprover: (caseId: string, approverId: string) => api.delete<{ id: string }>(`/cases/${caseId}/approvers/${approverId}`),
  create: (caseId: string, stageLinkId: string) => api.post<{ id: string }>(`/cases/${caseId}/publications`, { stageLinkId }),
  submit: (id: string, approverUserId: string) => api.post<{ id: string }>(`/client-publications/${id}/submit`, { approverUserId }),
  approve: (id: string) => api.post<{ id: string }>(`/client-publications/${id}/approve`, {}),
  reject: (id: string, reason: string) => api.post<{ id: string }>(`/client-publications/${id}/reject`, { reason }),
  publish: (id: string) => api.post<{ id: string }>(`/client-publications/${id}/publish`, {}),
  /** The client's link is returned only here. */
  createLink: (id: string) => api.post<CreateClientPublicationLinkResponse>(`/client-publications/${id}/acceptance-link`, {}),
  withdraw: (id: string, reason: string) => api.post<{ id: string }>(`/client-publications/${id}/withdraw`, { reason }),
  resendReceipt: (id: string) => api.post<{ status: string }>(`/client-publications/${id}/receipt`, {}),
};

// The client's side: no sign-in, the token is the key.
export const clientDeliverableApi = {
  get: (token: string) => api.get<PublicClientDeliverable>(`/client-deliverable/${encodeURIComponent(token)}`),
  accept: (token: string, input: AcceptClientDeliverable) =>
    api.post<PublicClientDeliverable>(`/client-deliverable/${encodeURIComponent(token)}/accept`, input),
};
