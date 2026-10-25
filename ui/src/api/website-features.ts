import { api } from "./client";
import type {
  CreateWebsiteFeature,
  UpdateWebsiteFeature,
  WebsiteFeature,
  WebsiteFeatureCard,
  WebsiteFeatureDetail,
} from "@greatstone/shared";

const featuresPath = (companyId: string, siteId: string) =>
  `/companies/${encodeURIComponent(companyId)}/website/sites/${encodeURIComponent(siteId)}/features`;
const featurePath = (companyId: string, siteId: string, featureId: string) =>
  `${featuresPath(companyId, siteId)}/${encodeURIComponent(featureId)}`;

/** Website feature registry client (GRE-2325). Reads need website:view; changes need website:publish. */
export const websiteFeaturesApi = {
  list: (companyId: string, siteId: string) => api.get<WebsiteFeature[]>(featuresPath(companyId, siteId)),
  /** The Features cards of Website Home, with their counts and health. */
  cards: (companyId: string, siteId: string) =>
    api.get<WebsiteFeatureCard[]>(`/companies/${encodeURIComponent(companyId)}/website/sites/${encodeURIComponent(siteId)}/feature-cards`),
  detail: (companyId: string, siteId: string, featureId: string) =>
    api.get<WebsiteFeatureDetail>(featurePath(companyId, siteId, featureId)),
  create: (companyId: string, siteId: string, input: CreateWebsiteFeature) =>
    api.post<WebsiteFeature>(featuresPath(companyId, siteId), input),
  update: (companyId: string, siteId: string, featureId: string, patch: UpdateWebsiteFeature) =>
    api.patch<WebsiteFeature>(featurePath(companyId, siteId, featureId), patch),
  remove: (companyId: string, siteId: string, featureId: string) =>
    api.delete<void>(featurePath(companyId, siteId, featureId)),
};
