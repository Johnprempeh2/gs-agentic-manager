import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SidebarLayout, SidebarLayoutPreference } from "@greatstone/shared";
import { authApi } from "../api/auth";
import { sidebarPreferencesApi } from "../api/sidebarPreferences";
import { resolveSidebarLayout } from "../lib/sidebar-layout";
import { queryKeys } from "../lib/queryKeys";

/**
 * The signed-in user's own sidebar arrangement (item order, hidden, pinned,
 * folded sections), saved on the server so it follows them across devices.
 * A failed read shows the default layout; a failed save keeps the change for
 * this session.
 */
export function useSidebarLayout() {
  const queryClient = useQueryClient();
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const userId = session?.user?.id ?? session?.session?.userId ?? null;
  const queryKey = useMemo(() => queryKeys.sidebarPreferences.layout(userId ?? "__anon__"), [userId]);
  const { data } = useQuery({
    queryKey,
    queryFn: () => sidebarPreferencesApi.getLayout(),
    enabled: Boolean(userId),
    retry: false,
  });
  const { mutate } = useMutation({
    mutationFn: (layout: SidebarLayout) => sidebarPreferencesApi.updateLayout(layout),
  });

  const saved = data?.layout;
  const resolved = useMemo(() => resolveSidebarLayout(saved), [saved]);

  /** Apply a change to the latest saved layout (not a stale render's copy) and save it. */
  const update = useCallback(
    (change: (layout: SidebarLayout) => SidebarLayout) => {
      const current = queryClient.getQueryData<SidebarLayoutPreference>(queryKey)?.layout ?? {};
      const layout = change(current);
      queryClient.setQueryData<SidebarLayoutPreference>(queryKey, (previous) => ({
        layout,
        updatedAt: previous?.updatedAt ?? null,
      }));
      if (userId) mutate(layout);
    },
    [mutate, queryClient, queryKey, userId],
  );

  return { saved: saved ?? {}, resolved, update, reset: () => update(() => ({})) };
}
