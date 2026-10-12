import type {
  CreateOrganisation,
  CreateOrganisationContact,
  Organisation,
  OrganisationContact,
  OrganisationDetail,
  OrganisationListItem,
  OrganisationStatus,
  UpdateOrganisation,
  UpdateOrganisationContact,
} from "@greatstone/shared";
import { api } from "./client";

/** CRM organisations (GRE-1477). Every path carries the company id. */
function base(companyId: string) {
  return `/companies/${encodeURIComponent(companyId)}/organisations`;
}

export const organisationsApi = {
  list: (companyId: string, filters: { q?: string; status?: OrganisationStatus | "" } = {}) => {
    const params = new URLSearchParams();
    if (filters.q?.trim()) params.set("q", filters.q.trim());
    if (filters.status) params.set("status", filters.status);
    const query = params.toString();
    return api.get<OrganisationListItem[]>(`${base(companyId)}${query ? `?${query}` : ""}`);
  },
  get: (companyId: string, organisationId: string) =>
    api.get<OrganisationDetail>(`${base(companyId)}/${encodeURIComponent(organisationId)}`),
  create: (companyId: string, body: CreateOrganisation) => api.post<Organisation>(base(companyId), body),
  update: (companyId: string, organisationId: string, body: UpdateOrganisation) =>
    api.patch<Organisation>(`${base(companyId)}/${encodeURIComponent(organisationId)}`, body),
  archive: (companyId: string, organisationId: string) =>
    api.post<Organisation>(`${base(companyId)}/${encodeURIComponent(organisationId)}/archive`, {}),
  createContact: (companyId: string, organisationId: string, body: CreateOrganisationContact) =>
    api.post<OrganisationContact>(`${base(companyId)}/${encodeURIComponent(organisationId)}/contacts`, body),
  updateContact: (companyId: string, organisationId: string, contactId: string, body: UpdateOrganisationContact) =>
    api.patch<OrganisationContact>(
      `${base(companyId)}/${encodeURIComponent(organisationId)}/contacts/${encodeURIComponent(contactId)}`,
      body,
    ),
  archiveContact: (companyId: string, organisationId: string, contactId: string) =>
    api.post<OrganisationContact>(
      `${base(companyId)}/${encodeURIComponent(organisationId)}/contacts/${encodeURIComponent(contactId)}/archive`,
      {},
    ),
};
