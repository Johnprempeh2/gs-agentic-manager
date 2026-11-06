import type { CreateLink, LinkItem, LinksResponse, UpdateLink } from "@greatstone/shared";
import { api } from "./client";

export type { LinkItem, LinksResponse } from "@greatstone/shared";

export interface LinksListParams {
  q?: string;
  clientCaseId?: string;
  projectId?: string;
  type?: string;
  status?: string;
  includeArchived?: boolean;
  limit?: number;
}

const base = (companyId: string) => `/companies/${encodeURIComponent(companyId)}/links`;

/** The links register (GRE-4252): every shared link, by client and project. */
export const linksApi = {
  list: (companyId: string, params: LinksListParams = {}) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "" && value !== false) search.set(key, String(value));
    }
    const query = search.toString();
    return api.get<LinksResponse>(`${base(companyId)}${query ? `?${query}` : ""}`);
  },
  create: (companyId: string, body: CreateLink) => api.post<LinkItem>(base(companyId), body),
  update: (companyId: string, id: string, body: UpdateLink) =>
    api.patch<LinkItem>(`${base(companyId)}/${encodeURIComponent(id)}`, body),
  archive: (companyId: string, id: string) =>
    api.post<LinkItem>(`${base(companyId)}/${encodeURIComponent(id)}/archive`, {}),
};
