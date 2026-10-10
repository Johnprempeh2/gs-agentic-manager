import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@/lib/router";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/** True when the board control panel switch (`enableStrategyBoard`, GRE-1135) is on. */
export function useStrategyBoardEnabled(): { enabled: boolean; isFetched: boolean } {
  const { data, isFetched } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  return { enabled: data?.enableStrategyBoard === true, isFetched };
}

/** Route guard for the board control panel: redirects to Goals while the switch is off. */
export function StrategyBoardExperimentalGate({ children }: { children: ReactNode }) {
  const { enabled, isFetched } = useStrategyBoardEnabled();
  if (!isFetched) return null;
  if (!enabled) return <Navigate to="/goals" replace />;
  return <>{children}</>;
}
