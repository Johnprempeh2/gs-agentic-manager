import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@/lib/router";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Route guard for the Deep Dive page. The record is stored as Cases, so the
 * page needs both `enableDeepDive` and `enableCases`; otherwise it redirects to
 * the dashboard, mirroring {@link CasesExperimentalGate}.
 */
export function DeepDiveExperimentalGate({ children }: { children: ReactNode }) {
  const { data: experimentalSettings, isFetched } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  if (!isFetched) return null;
  if (experimentalSettings?.enableDeepDive !== true || experimentalSettings?.enableCases !== true) {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}
