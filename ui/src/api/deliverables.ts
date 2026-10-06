import { api } from "./client";
import type {
  CreateDeliverableComment,
  DeliverableComment,
  DeliverableCommentsResponse,
  DeliverableDetail,
  DeliverableKind,
  DeliverableSort,
  DeliverablesResponse,
  DeliverableStatus,
  SendDeliverableCommentsResponse,
} from "@greatstone/shared";

export type {
  CreateDeliverableComment,
  DeliverableComment,
  SendDeliverableCommentsResponse,
  Deliverable,
  DeliverableDetail,
  DeliverableFacets,
  DeliverableKind,
  DeliverableSort,
  DeliverablesResponse,
  DeliverableStatus,
  DeliverableVersion,
} from "@greatstone/shared";

/** Deliverables client (GRE-388): finished documents John asked for. */

export interface ListDeliverablesParams {
  q?: string;
  kind?: DeliverableKind;
  projectId?: string;
  agentId?: string;
  brand?: string;
  from?: string;
  sort?: DeliverableSort;
  limit?: number;
  offset?: number;
}

export interface MarkDeliverableInput {
  artifactId: string;
  title?: string;
  summary?: string;
  kind?: DeliverableKind;
  brand?: string;
  status?: DeliverableStatus;
}

function buildQuery(params: ListDeliverablesParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export const deliverablesApi = {
  list: (companyId: string, params: ListDeliverablesParams = {}) =>
    api.get<DeliverablesResponse>(`/companies/${companyId}/deliverables${buildQuery(params)}`),
  get: (companyId: string, id: string) =>
    api.get<DeliverableDetail>(`/companies/${companyId}/deliverables/${id}`),
  markOpened: (companyId: string, id: string) =>
    api.post<{ ok: true }>(`/companies/${companyId}/deliverables/${id}/opened`, {}),
  mark: (companyId: string, input: MarkDeliverableInput) =>
    api.post<DeliverableDetail>(`/companies/${companyId}/deliverables/mark`, input),

  /** The HTML deliverable with the review script that reports selections (GRE-982). */
  reviewContentPath: (companyId: string, id: string) =>
    `/api/companies/${companyId}/deliverables/${id}/review-content`,
  listComments: (companyId: string, id: string) =>
    api.get<DeliverableCommentsResponse>(`/companies/${companyId}/deliverables/${id}/comments`),
  createComment: (companyId: string, id: string, input: CreateDeliverableComment) =>
    api.post<DeliverableComment>(`/companies/${companyId}/deliverables/${id}/comments`, input),
  updateComment: (companyId: string, id: string, commentId: string, body: string) =>
    api.patch<DeliverableComment>(`/companies/${companyId}/deliverables/${id}/comments/${commentId}`, { body }),
  deleteComment: (companyId: string, id: string, commentId: string) =>
    api.delete<void>(`/companies/${companyId}/deliverables/${id}/comments/${commentId}`),
  sendComments: (companyId: string, id: string) =>
    api.post<SendDeliverableCommentsResponse>(`/companies/${companyId}/deliverables/${id}/comments/send`, {}),
};
