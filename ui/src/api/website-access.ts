import type {
  WebsiteAccessChange,
  WebsiteAccessList,
  WebsiteClientMember,
  WebsitePortalApprover,
  WebsiteStaff,
} from "@greatstone/shared";
import { api } from "./client";

// People and access on a connected website (GRE-4085, screen GRE-4086): staff roles, portal approvers and client
// company members, through the admin bridge. Reads need website:view; every change is a person's, on the write key,
// sent with an Idempotency-Key. An agent asks with a card instead (website_access_request_change).
const accessPath = (companyId: string, siteId: string) =>
  `/companies/${encodeURIComponent(companyId)}/website/sites/${encodeURIComponent(siteId)}/access`;

const writeHeaders = (idempotencyKey: string) => ({ "Content-Type": "application/json", "Idempotency-Key": idempotencyKey });

export const websiteAccessApi = {
  staff: (companyId: string, siteId: string) =>
    api.get<WebsiteAccessList<WebsiteStaff>>(`${accessPath(companyId, siteId)}/staff`),
  portalApprovers: (companyId: string, siteId: string) =>
    api.get<WebsiteAccessList<WebsitePortalApprover>>(`${accessPath(companyId, siteId)}/portal-approvers`),
  clientMembers: (companyId: string, siteId: string, customerId: string) =>
    api.get<WebsiteAccessList<WebsiteClientMember>>(`${accessPath(companyId, siteId)}/clients/${encodeURIComponent(customerId)}/members`),
  /** One change, made now in the signed-in person's name. The same key and the same change write once on the site. */
  change: (companyId: string, siteId: string, change: WebsiteAccessChange, idempotencyKey: string): Promise<unknown> => {
    const base = accessPath(companyId, siteId);
    const e = encodeURIComponent;
    const options = { headers: writeHeaders(idempotencyKey) };
    switch (change.kind) {
      case "staff_role":
        return api.patch<{ item: WebsiteStaff }>(`${base}/staff/${e(change.staffId)}`, { role: change.role }, options);
      case "approver_set":
        return api.put<{ item: WebsitePortalApprover }>(`${base}/portal-approvers/${e(change.staffId)}`, { label: change.label }, options);
      case "approver_remove":
        return api.deleteWithBody<{ staffId: string; removed: true }>(`${base}/portal-approvers/${e(change.staffId)}`, {}, options);
      case "member_add":
        return api.post<{ item: WebsiteClientMember }>(`${base}/clients/${e(change.customerId)}/members`,
          { email: change.email, name: change.name, role: change.role }, options);
      case "member_role":
        return api.patch<{ item: WebsiteClientMember }>(`${base}/clients/${e(change.customerId)}/members/${e(change.membershipId)}`,
          { role: change.role }, options);
      case "member_remove":
        return api.deleteWithBody<{ membershipId: string; removed: true }>(
          `${base}/clients/${e(change.customerId)}/members/${e(change.membershipId)}`, {}, options);
    }
  },
};
