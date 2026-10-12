import { useQuery } from "@tanstack/react-query";
import { billingApi } from "@/api/billing";
import { queryKeys } from "@/lib/queryKeys";

/** The instance billing view (GRE-1370). Shared by the Billing page and the sidebar entry. */
export function useBillingAccount() {
  return useQuery({
    queryKey: queryKeys.instance.billingAccount,
    queryFn: () => billingApi.get(),
    staleTime: 60_000,
  });
}

/** The sidebar shows Billing only on an instance that has a billing account (a client instance). */
export function useHasBillingAccount() {
  return Boolean(useBillingAccount().data?.account);
}
