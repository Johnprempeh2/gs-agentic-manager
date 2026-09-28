import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Scale } from "lucide-react";
import { costsApi } from "../api/costs";
import { queryKeys } from "../lib/queryKeys";
import { formatCents } from "../lib/utils";
import { apiEquivalentDifferenceLabel } from "./ApiEquivalentCard";
import { MetricCard } from "./MetricCard";

/** Start of the current UTC month, the same month window as "Month Spend". */
function utcMonthStartIso(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** This month's API-equivalent cost of all token usage versus what we pay. */
export function DashboardCostCard({ companyId }: { companyId: string }) {
  const from = useMemo(() => utcMonthStartIso(), []);
  const { data } = useQuery({
    queryKey: queryKeys.apiEquivalent(companyId, from, undefined),
    queryFn: () => costsApi.apiEquivalent(companyId, from),
  });

  if (!data) return null;
  return (
    <MetricCard
      icon={Scale}
      value={formatCents(Math.round(data.apiEquivalentCents))}
      label="Under API billing this month"
      to="/costs"
      description={
        <span>
          We pay {formatCents(Math.round(data.paidCents))} (API {formatCents(data.actualApiSpendCents)}, subscriptions{" "}
          {formatCents(Math.round(data.subscriptionCostCents))} prorated). {apiEquivalentDifferenceLabel(data.savingCents)}.
        </span>
      }
    />
  );
}
