import { useQuery } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { fleetApi } from "@/api/fleet";
import { queryKeys } from "@/lib/queryKeys";

/**
 * The hub's fleet list (GRE-1083). Asked only for an instance admin; the
 * server stays the gate (404 off the hub, 403 for anyone else). Shared by the
 * Fleet page and its sidebar entry.
 */
export function useFleetInstances() {
  const boardAccess = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });
  const isAdmin = boardAccess.data?.isInstanceAdmin === true || boardAccess.data?.source === "local_implicit";
  const fleet = useQuery({
    queryKey: queryKeys.instance.fleetInstances,
    queryFn: () => fleetApi.listInstances(),
    enabled: isAdmin,
    retry: false,
    refetchInterval: 60_000,
  });
  return { ...fleet, isLoading: boardAccess.isLoading || fleet.isLoading, isAdmin };
}

/** The sidebar shows Fleet only on the Greatstone hub, to its instance admins. */
export function useIsFleetHub() {
  return useFleetInstances().isSuccess;
}
