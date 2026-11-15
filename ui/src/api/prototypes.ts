import { api } from "./client";
import type {
  Prototype,
  PrototypeSettableStatus,
  PrototypesQuery,
  PrototypesResponse,
  SetPrototypeVisibilityResponse,
  PrototypePortalSync,
} from "@greatstone/shared";

export type { Prototype, PrototypeStatus, PrototypesQuery } from "@greatstone/shared";

/** Prototypes (14 Nov): link deliverables of kind prototype, with their client and portal visibility. */
export const prototypesApi = {
  list: (companyId: string, params: PrototypesQuery = {}) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) search.set(key, String(value));
    const qs = search.toString();
    return api.get<PrototypesResponse>(`/companies/${companyId}/prototypes${qs ? `?${qs}` : ""}`);
  },
  setStatus: (companyId: string, id: string, status: PrototypeSettableStatus) =>
    api.patch<{ prototype: Prototype; portal: PrototypePortalSync | null }>(`/companies/${companyId}/prototypes/${id}/status`, { status }),
  /** People only; the server refuses agents. */
  setVisibility: (companyId: string, id: string, input: { visible: boolean; organisationId: string }) =>
    api.post<SetPrototypeVisibilityResponse>(`/companies/${companyId}/prototypes/${id}/visibility`, input),
  uploadScreenshot: (companyId: string, id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return api.postForm<unknown>(`/companies/${companyId}/deliverables/${id}/screenshot/upload`, form);
  },
};
