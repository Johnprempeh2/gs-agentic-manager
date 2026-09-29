import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CompanySubscription, CompanySubscriptionsResult } from "@greatstone/shared";
import { costsApi } from "../api/costs";
import { queryKeys } from "../lib/queryKeys";
import { formatCents, providerDisplayName } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface Draft {
  id: string | null;
  provider: string;
  plan: string;
  price: string;
}

function toDraft(subscription: CompanySubscription): Draft {
  return {
    id: subscription.id,
    provider: subscription.provider,
    plan: subscription.plan,
    price: (subscription.monthlyPriceCents / 100).toFixed(2),
  };
}

function priceToCents(price: string): number | null {
  const cleaned = price.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

export function SubscriptionsCard({
  companyId,
  data,
}: {
  companyId: string;
  data: CompanySubscriptionsResult;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.subscriptions(companyId) });
    // prefix match: every period's API-equivalent summary includes subscription cost
    queryClient.invalidateQueries({ queryKey: ["api-equivalent", companyId] });
  };

  const save = useMutation({
    mutationFn: async (value: Draft) => {
      const monthlyPriceCents = priceToCents(value.price);
      if (monthlyPriceCents === null) throw new Error("Enter a monthly price in dollars, for example 200.");
      const body = { provider: value.provider.trim(), plan: value.plan.trim(), monthlyPriceCents };
      if (!body.provider || !body.plan) throw new Error("Provider and plan are required.");
      return value.id
        ? costsApi.updateSubscription(companyId, value.id, body)
        : costsApi.createSubscription(companyId, body);
    },
    onSuccess: () => {
      setDraft(null);
      setError(null);
      refresh();
    },
    onError: (err) => setError((err as Error).message),
  });

  const remove = useMutation({
    mutationFn: (subscriptionId: string) => costsApi.deleteSubscription(companyId, subscriptionId),
    onSuccess: refresh,
    onError: (err) => setError((err as Error).message),
  });

  const monthlyTotal = data.subscriptions.reduce((sum, row) => sum + row.monthlyPriceCents, 0);

  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">Subscriptions</CardTitle>
        <CardDescription>
          Plans we pay a flat monthly price for. {formatCents(monthlyTotal)} per month in total.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-5 pb-5 pt-2">
        {data.subscriptions.length === 0 && data.detected.length === 0 && !draft ? (
          <p className="text-sm text-muted-foreground">No subscriptions yet.</p>
        ) : null}

        <ul className="divide-y divide-border">
          {data.subscriptions.map((subscription) =>
            draft?.id === subscription.id ? null : (
              <li key={subscription.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div className="min-w-0">
                  <span className="font-medium">{providerDisplayName(subscription.provider)}</span>
                  <span className="text-muted-foreground"> · {subscription.plan}</span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="tabular-nums">{formatCents(subscription.monthlyPriceCents)}/mo</span>
                  <Button size="sm" variant="ghost" onClick={() => setDraft(toDraft(subscription))}>Edit</Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(subscription.id)}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ),
          )}
          {data.detected.map((detected) => (
            <li key={`${detected.provider}/${detected.biller}`} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div className="min-w-0 text-muted-foreground">
                <span className="font-medium text-foreground">{providerDisplayName(detected.provider)}</span>
                {" "}runs on a subscription ({providerDisplayName(detected.biller)}), but no plan or price is set.
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDraft({ id: null, provider: detected.provider, plan: "", price: "" })}
              >
                Set plan
              </Button>
            </li>
          ))}
        </ul>

        {draft ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate(draft);
            }}
          >
            <label className="grid gap-1 text-xs text-muted-foreground">
              Provider
              <Input
                className="w-32"
                value={draft.provider}
                onChange={(event) => setDraft({ ...draft, provider: event.target.value })}
                placeholder="anthropic"
              />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              Plan
              <Input
                className="w-44"
                value={draft.plan}
                onChange={(event) => setDraft({ ...draft, plan: event.target.value })}
                placeholder="Claude Max 20x"
              />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              Monthly price (USD)
              <Input
                className="w-32"
                inputMode="decimal"
                value={draft.price}
                onChange={(event) => setDraft({ ...draft, price: event.target.value })}
                placeholder="200"
              />
            </label>
            <Button type="submit" size="sm" disabled={save.isPending}>Save</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setDraft(null); setError(null); }}>
              Cancel
            </Button>
          </form>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setDraft({ id: null, provider: "", plan: "", price: "" })}>
            Add subscription
          </Button>
        )}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
