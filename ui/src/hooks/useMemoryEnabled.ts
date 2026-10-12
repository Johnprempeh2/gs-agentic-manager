import { useQuery } from "@tanstack/react-query";
import { memoryGraphApi } from "@/api/memoryGraph";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Organisation memory is switched on per company. The Memory nav item shows
 * only once the company's memory settings say it is on: hidden while they
 * load and when they cannot be read, so the link never flashes.
 */
export function useMemoryEnabled(companyId: string | null | undefined) {
  const query = useQuery({
    queryKey: queryKeys.memory.settings(companyId ?? ""),
    queryFn: () => memoryGraphApi.settings(companyId!),
    enabled: Boolean(companyId),
  });
  return { enabled: Boolean(companyId) && !query.isError && query.data?.enabled === true };
}
