import type {
  FleetBillingItemInput,
  FleetBillingItemView,
  FleetBillingLinkView,
  FleetEntitlementSummary,
  FleetInstanceView,
  FleetOrderKind,
  FleetOrderView,
} from "@greatstone/shared/fleet";
import { api } from "./client";

/** Features, limits and paid-until for a licence or a new signed document. */
export interface FleetEntitlementBody {
  features: Record<string, boolean>;
  limits: Record<string, number>;
  validUntil: string;
  reason?: string;
}

export const fleetApi = {
  /** Hub only: 404 unless GSAM_FLEET_HUB=true, 403 unless the caller is an instance admin. */
  listInstances: () => api.get<FleetInstanceView[]>("/fleet/instances"),
  /** A new install's licence key. The key is in this answer only. */
  createLicence: (body: FleetEntitlementBody & { code?: string }) =>
    api.post<{ instance: FleetInstanceView; licenceKey: string; licenceKeyExpiresAt: string }>("/fleet/licences", body),
  /** The next signed document; the install gets it with its next check-in. */
  issueEntitlement: (id: string, body: FleetEntitlementBody) =>
    api.put<FleetInstanceView & { entitlement: FleetEntitlementSummary | null }>(`/fleet/instances/${id}/entitlement`, body),
  /** A signed order; the install obeys it within 5 minutes and reports back. */
  createOrder: (id: string, body: { kind: FleetOrderKind; reason: string }) => api.post<FleetOrderView>(`/fleet/instances/${id}/orders`, body),
  /** Greatstone's operator log-in for the install. Each read is in the hub activity log. */
  operatorLogin: (id: string) => api.get<{ email: string; password: string }>(`/fleet/instances/${id}/operator-login`),
  /** P3: modules, packages and deals, mirrored to Stripe. */
  listCatalogue: () => api.get<FleetBillingItemView[]>("/fleet/catalogue"),
  createCatalogueItem: (body: FleetBillingItemInput) => api.post<FleetBillingItemView>("/fleet/catalogue", body),
  updateCatalogueItem: (id: string, body: FleetBillingItemInput) => api.put<FleetBillingItemView>(`/fleet/catalogue/${id}`, body),
  archiveCatalogueItem: (id: string) => api.delete<FleetBillingItemView>(`/fleet/catalogue/${id}`),
  /** P3: the Stripe customer whose checkout and events drive this install. */
  linkBilling: (id: string, stripeCustomerId: string) => api.put<FleetBillingLinkView>(`/fleet/instances/${id}/billing`, { stripeCustomerId }),
};
