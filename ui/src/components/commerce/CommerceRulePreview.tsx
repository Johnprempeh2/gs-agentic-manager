import { useQuery } from "@tanstack/react-query";
import { websiteCommerceApi, type CommerceRow } from "@/api/website-commerce";
import { ErrorState } from "@/components/ErrorState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { text } from "@/lib/commerce";
import { ruleHits, showRate } from "@/lib/commerce-currency";
import { queryKeys } from "@/lib/queryKeys";
import { formatNumber } from "@/lib/utils";
import { useWholeCatalogue } from "./CommerceImports";

// Parity with the website's old pricing rules screen: what a rule does to real prices, so a person checks a draft
// before publishing it. Saved values only; save a change to see it here.

const POUNDS = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const SHOWN = 8;

export function CommerceRulePreview({ companyId, siteId, rule }: { companyId: string; siteId: string; rule: CommerceRow }) {
  const catalogue = useWholeCatalogue(companyId, siteId, true);
  const fx = useQuery({ queryKey: queryKeys.website.commerce(companyId, siteId, "fx"), queryFn: () => websiteCommerceApi.fx(companyId, siteId) });
  const rate = Number(text(fx.data?.item.usd_to_gbp_display_rate));
  const hits = catalogue.data && rate > 0 ? ruleHits(rule, catalogue.data, rate) : null;
  const tierOnly = text(rule.audience) === "tier";
  const fixedNotPounds = text(rule.adjustment_type) === "fixed" && text(rule.currency) !== "GBP";

  return (
    <section className="space-y-2" aria-label="What this rule does" data-testid="commerce-rule-preview">
      <h2 className="text-sm font-semibold">What this rule does</h2>
      {catalogue.isLoading || fx.isLoading ? <PageSkeleton variant="list" /> : null}
      {catalogue.error || fx.error ? (
        <ErrorState error={catalogue.error ?? fx.error} onRetry={() => { void catalogue.refetch(); void fx.refetch(); }} retrying={catalogue.isFetching || fx.isFetching} />
      ) : null}
      {hits ? (
        <>
          <p className="text-sm text-muted-foreground">
            {hits.length ? `It lowers the from price of ${formatNumber(hits.length)} published product${hits.length === 1 ? "" : "s"}` : "It lowers no published product's price"}
            {`, in pounds at $${showRate(fx.data?.item.usd_to_gbp_display_rate)} to the pound.`}
            {tierOnly ? " Only clients in its tier see it." : ""}
            {" "}Dates and other rules are left out: when rules overlap, the shop applies one, never both.
          </p>
          {fixedNotPounds ? (
            <p className="text-sm text-status-warning-foreground">A fixed amount works only in pounds, the currency the shop charges. This one is not in pounds, so it changes nothing.</p>
          ) : null}
          {hits.length ? (
            <ul className="divide-y divide-border rounded-xl border border-border bg-card">
              {hits.slice(0, SHOWN).map((hit) => (
                <li key={hit.id} className="flex min-w-0 items-baseline justify-between gap-3 px-4 py-2 text-sm">
                  <span className="min-w-0 truncate">{hit.name}</span>
                  <span className="shrink-0 tabular-nums">
                    <s className="text-muted-foreground">{POUNDS.format(hit.base / 100)}</s>{" "}
                    <span aria-hidden="true">→</span><span className="sr-only">becomes</span>{" "}
                    <span className="font-medium">{POUNDS.format(hit.final / 100)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {hits.length > SHOWN ? <p className="text-xs text-muted-foreground">{`The ${SHOWN} biggest savings are shown.`}</p> : null}
        </>
      ) : null}
    </section>
  );
}
