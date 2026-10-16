import { useQuery } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";
import { useIsFleetHub } from "./useFleetInstances";

/**
 * "Get help" (GRE-1425) shows to signed-in board users of a client instance.
 * The Greatstone hub answers tickets rather than opening them, so it has no
 * entry. Agents never see it; the server also refuses them.
 */
export function useShowGetHelp() {
  const boardAccess = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });
  const isHub = useIsFleetHub();
  return Boolean(boardAccess.data?.userId) && !isHub;
}
