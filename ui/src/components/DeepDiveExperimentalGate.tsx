import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@/lib/router";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Route guard for the Deep Dive page. Redirects to the dashboard when
 * `enableDeepDive` is off, mirroring {@link PipelinesExperimentalGate}.
 */
export function DeepDiveExperimentalGate({ children }: { children: ReactNode }) {
  const { data: experimentalSettings, isFetched } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  if (!isFetched) return null;
  if (experimentalSettings?.enableDeepDive !== true) {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}
