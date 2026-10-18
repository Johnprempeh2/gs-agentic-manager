import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@/lib/router";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Route guard for Status Cards. The stored switch is ignored (GRE-1622), but a
 * managed config or the entitlement document can still turn it off (GRE-1633).
 */
export function StatusCardsExperimentalGate({ children }: { children: ReactNode }) {
  const { data: experimentalSettings, isFetched } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  if (!isFetched) return null;
  if (experimentalSettings?.enableStatusCards !== true) {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}
