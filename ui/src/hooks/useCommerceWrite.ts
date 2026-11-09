import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { websiteCommerceApi, type CommerceRow, type CommerceWrite, type CommerceWriteResult } from "@/api/website-commerce";
import { isDefiniteAnswer, isPersonAccess, newIdempotencyKey } from "@/lib/commerce-write";
import { queryKeys } from "@/lib/queryKeys";

/** True only for a person signed in to GSAM: people-only buttons show for them and no one else. */
export function useCommercePerson(): boolean {
  const access = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
    staleTime: 5 * 60_000,
  });
  return isPersonAccess(access.data);
}

/**
 * One commerce change at a time. A retry of the same change (after a network error or a 5xx) reuses its
 * Idempotency-Key, so the site writes it once; a new change, or any after a definite answer, takes a new key.
 * Every success refreshes this site's website data and commerce reads.
 */
export function useCommerceWrite(companyId: string, siteId: string, options: { onSuccess?: (item: CommerceRow, result: CommerceWriteResult) => void } = {}) {
  const queryClient = useQueryClient();
  const pending = useRef<{ signature: string; key: string } | null>(null);
  return useMutation({
    mutationFn: (change: CommerceWrite) => {
      const signature = JSON.stringify([change.method, change.parts, change.body ?? {}]);
      if (pending.current?.signature !== signature) pending.current = { signature, key: newIdempotencyKey() };
      return websiteCommerceApi.write(companyId, siteId, change, pending.current.key);
    },
    onSuccess: (result) => {
      pending.current = null;
      void queryClient.invalidateQueries({ queryKey: queryKeys.website.siteData(companyId, siteId) });
      options.onSuccess?.(result.item, result);
    },
    onError: (error) => {
      if (isDefiniteAnswer(error)) pending.current = null;
    },
  });
}
