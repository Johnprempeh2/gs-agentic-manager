import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SidebarOrderPreference } from "@greatstone/shared";
import { authApi } from "../api/auth";
import { sidebarPreferencesApi } from "../api/sidebarPreferences";
import { mergeSectionOrder, moveSection } from "../lib/sidebar-section-order";
import { queryKeys } from "../lib/queryKeys";

/**
 * The signed-in user's sidebar section order, saved on the server so it follows
 * them across devices. A failed read shows the default order; a failed save
 * keeps the new order for this session.
 */
export function useSidebarSectionOrder(defaults: readonly string[]) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const userId = session?.user?.id ?? session?.session?.userId ?? null;
  const queryKey = useMemo(() => queryKeys.sidebarPreferences.sectionOrder(userId ?? "__anon__"), [userId]);
  const { data } = useQuery({
    queryKey,
    queryFn: () => sidebarPreferencesApi.getSectionOrder(),
    enabled: Boolean(userId),
    retry: false,
  });
  const { mutate } = useMutation({
    mutationFn: (orderedIds: string[]) => sidebarPreferencesApi.updateSectionOrder({ orderedIds }),
  });

  const order = useMemo(() => mergeSectionOrder(defaults, data?.orderedIds ?? []), [defaults, data?.orderedIds]);

  const save = useCallback(
    (orderedIds: string[]) => {
      queryClient.setQueryData<SidebarOrderPreference>(queryKey, (current) => ({
        orderedIds,
        updatedAt: current?.updatedAt ?? null,
      }));
      if (userId) mutate(orderedIds);
    },
    [mutate, queryClient, queryKey, userId],
  );

  return {
    order,
    move: (id: string, delta: -1 | 1) => save(moveSection(order, id, delta)),
    reset: () => save([]),
  };
}
