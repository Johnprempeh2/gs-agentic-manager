import { api } from "./client";
import type {
  DeliverableDetail,
  DeliverableKind,
  DeliverableSort,
  DeliverablesResponse,
  DeliverableStatus,
} from "@greatstone/shared";

export type {
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
};
