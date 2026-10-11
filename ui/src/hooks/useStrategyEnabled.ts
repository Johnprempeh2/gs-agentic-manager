import { useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/**
 * True when the Strategy module (`enableStrategy`, GRE-1382) is on: the KPI
 * cascade, KPI readings and KPI drafts. Plain goals do not need it. The server
 * refuses the KPI routes while it is off; this only hides their UI.
 */
export function useStrategyEnabled(): { enabled: boolean; isFetched: boolean } {
  const { data, isFetched } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  return { enabled: data?.enableStrategy === true, isFetched };
}
