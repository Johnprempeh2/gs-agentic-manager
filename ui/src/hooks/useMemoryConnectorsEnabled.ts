import { useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/**
 * On by default (GRE-1620). A managed config or the entitlement document can
 * still turn setup off (GRE-1633). Existing connections and their grants remain usable.
 */
export function useMemoryConnectorsEnabled() {
  const query = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  return { enabled: !query.isError && query.data?.enableMemoryConnectors === true, loaded: query.isFetched };
}
