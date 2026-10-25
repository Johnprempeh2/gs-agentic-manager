import { useQueries, useQuery } from "@tanstack/react-query";
import type { WebsiteFeature, WebsiteSite } from "@greatstone/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { websiteModuleApi } from "@/api/website";
import { websiteFeaturesApi } from "@/api/website-features";
import { websiteDataBridgeApi } from "@/api/website-data-bridge";
import { GREATSTONE_COMPANY_ID, commerceFeatureOf, type CommerceRecord } from "@/lib/commerce";
import { queryKeys } from "@/lib/queryKeys";

export interface CommerceSite {
  site: WebsiteSite;
  feature: WebsiteFeature;
}

/**
 * The site the Commerce area reads (GRE-2383): Greatstone's site whose Shop feature is on in the registry.
 * Null for every other company, and while the website view is off.
 */
export function useCommerceSite(companyId: string | null | undefined) {
  const settings = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const candidate = companyId === GREATSTONE_COMPANY_ID && settings.data?.enableWebsiteView === true;
  const sites = useQuery({
    queryKey: queryKeys.website.sites(companyId ?? ""),
    queryFn: () => websiteModuleApi.sites(companyId!),
    enabled: candidate,
  });
  const siteList = candidate ? sites.data ?? [] : [];
  const features = useQueries({
    queries: siteList.map((site) => ({
      queryKey: queryKeys.website.features(companyId!, site.id),
      queryFn: () => websiteFeaturesApi.list(companyId!, site.id),
    })),
  });
  let commerce: CommerceSite | null = null;
  siteList.forEach((site, index) => {
    const feature = commerce ? null : commerceFeatureOf(companyId, features[index]?.data);
    if (feature) commerce = { site, feature };
  });
  const isLoading = settings.isLoading || (candidate && (sites.isLoading || features.some((query) => query.isLoading)));
  return { commerce: commerce as CommerceSite | null, isLoading };
}

/** The site's customers, for names and for the link to Clients > Organisations. One page of up to 100. */
export function useCommerceCustomers(companyId: string, siteId: string | null) {
  return useQuery({
    queryKey: queryKeys.website.data(companyId, siteId ?? "", "customers"),
    queryFn: async (): Promise<CommerceRecord[]> => (await websiteDataBridgeApi.list(companyId, siteId!, "customers", { limit: 100 })).items,
    enabled: Boolean(companyId && siteId),
    staleTime: 60_000,
  });
}
