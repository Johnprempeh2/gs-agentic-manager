import { useQuery } from "@tanstack/react-query";
import { isEntitlementFeatureKey, type EffectiveEntitlementFeature, type InstanceFeatureKey } from "@greatstone/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Effective features from the signed entitlement document (GRE-1078). The
 * server decides; this only reflects its answer. Re-read every minute, the
 * same pace as the server reloads the file.
 */
export function useEntitlements() {
  const query = useQuery({
    queryKey: queryKeys.instance.entitlements,
    queryFn: () => instanceSettingsApi.getEntitlements(),
    refetchInterval: 60_000,
  });
  const data = query.data;
  return {
    data,
    /** Null for switches the document does not govern, or while entitlements are off. */
    featureState(key: InstanceFeatureKey): EffectiveEntitlementFeature | null {
      if (!data || data.state === "disabled" || !isEntitlementFeatureKey(key)) return null;
      return data.features[key];
    },
  };
}
