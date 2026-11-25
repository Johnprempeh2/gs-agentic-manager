import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Package, Plus } from "lucide-react";
import { ENTITLEMENT_FEATURE_KEYS, INSTANCE_FEATURE_CATALOG } from "@greatstone/shared";
import type { FleetBillingItemInput, FleetBillingItemKind, FleetBillingItemView } from "@greatstone/shared/fleet";
import { fleetApi } from "@/api/fleet";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { queryKeys } from "@/lib/queryKeys";
import { formatNumber } from "@/lib/utils";

/**
 * GSAM for Mac (P3): the hub's catalogue on the Fleet page. Modules carry
 * features and limits; packages and deals hold modules at their own price; a
 * deal is for one Stripe customer only. Every save mirrors to Stripe (a new
 * price archives the old one). Stripe payments then drive each install's
 * signed document (`doc/CLIENT-INSTANCES.md`, "payments and modules").
 */

const KIND_LABEL: Record<FleetBillingItemKind, string> = { module: "Module", package: "Package", deal: "Deal" };

const LIMIT_FIELDS = [
  { key: "maxUsers", label: "Users" },
  { key: "maxAgents", label: "Agents" },
];

function featureTitle(key: string) {
  return ((INSTANCE_FEATURE_CATALOG as Record<string, { title: string } | undefined>)[key]?.title ?? key).replace(/ \(compatibility\)$/, "");
}

/** Minor units as a plain amount with its currency code, for example GBP 49.00. */
export function formatPrice(amount: number | null, currency: string) {
  if (amount === null) return null;
  return `${currency.toUpperCase()} ${formatNumber(amount / 100, { maximumFractionDigits: 2 })}`;
}

function toMinor(value: string) {
  if (value.trim() === "") return null;
  const n = Math.round(Number.parseFloat(value) * 100);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const fromMinor = (amount: number | null) => (amount === null ? "" : String(amount / 100));

function ItemForm({ item, modules, onDone }: { item: FleetBillingItemView | null; modules: FleetBillingItemView[]; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<FleetBillingItemKind>(item?.kind ?? "module");
  const [name, setName] = useState(item?.name ?? "");
  const [features, setFeatures] = useState<string[]>(item?.features ?? []);
  const [moduleIds, setModuleIds] = useState<string[]>(item?.moduleIds ?? []);
  const [limits, setLimits] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(item?.limits ?? {}).map(([key, value]) => [key, String(value)])),
  );
  const [monthly, setMonthly] = useState(fromMinor(item?.monthlyAmount ?? null));
  const [annual, setAnnual] = useState(fromMinor(item?.annualAmount ?? null));
  const [currency, setCurrency] = useState(item?.currency ?? "gbp");
  const [customer, setCustomer] = useState(item?.stripeCustomerId ?? "");

  const save = useMutation({
    mutationFn: (body: FleetBillingItemInput) => (item ? fleetApi.updateCatalogueItem(item.id, body) : fleetApi.createCatalogueItem(body)),
    onSuccess: () => {
      onDone();
      return queryClient.invalidateQueries({ queryKey: queryKeys.instance.fleetCatalogue });
    },
    // A Stripe refusal still saved the item on the hub.
    onError: () => queryClient.invalidateQueries({ queryKey: queryKeys.instance.fleetCatalogue }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const cleanLimits: Record<string, number> = {};
    for (const [key, value] of Object.entries(limits)) {
      const n = Number.parseInt(value, 10);
      if (value.trim() !== "" && Number.isFinite(n) && n >= 0) cleanLimits[key] = n;
    }
    save.mutate({
      kind,
      name: name.trim(),
      description: item?.description ?? null,
      features: kind === "module" ? (features as FleetBillingItemInput["features"]) : [],
      limits: cleanLimits,
      moduleIds: kind === "module" ? [] : moduleIds,
      monthlyAmount: toMinor(monthly),
      annualAmount: toMinor(annual),
      currency: currency.trim().toLowerCase(),
      stripeCustomerId: kind === "deal" ? customer.trim() : null,
    });
  };

  const toggle = (list: string[], value: string, on: boolean) => (on ? [...new Set([...list, value])] : list.filter((entry) => entry !== value));

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="catalogue-kind">Kind</Label>
          <NativeSelect id="catalogue-kind" value={kind} disabled={item !== null} onChange={(event) => setKind(event.target.value as FleetBillingItemKind)}>
            <option value="module">Module: features and limits</option>
            <option value="package">Package: modules at their own price</option>
            <option value="deal">Deal: a package for one customer</option>
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="catalogue-name">Name (customers see it in Stripe)</Label>
          <Input id="catalogue-name" required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
        </div>
      </div>

      {kind === "module" ? (
        <fieldset className="space-y-2">
          <legend className="text-xs text-muted-foreground">Features</legend>
          <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
            {ENTITLEMENT_FEATURE_KEYS.map((key) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <Checkbox checked={features.includes(key)} onCheckedChange={(checked) => setFeatures((prev) => toggle(prev, key, checked === true))} />
                {featureTitle(key)}
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <fieldset className="space-y-2">
          <legend className="text-xs text-muted-foreground">Modules</legend>
          {modules.length === 0 ? (
            <p className="text-sm text-muted-foreground">Make a module first.</p>
          ) : (
            <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
              {modules.map((module) => (
                <label key={module.id} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={moduleIds.includes(module.id)} onCheckedChange={(checked) => setModuleIds((prev) => toggle(prev, module.id, checked === true))} />
                  {module.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      )}

      {kind === "deal" ? (
        <div className="space-y-1">
          <Label htmlFor="catalogue-customer">Stripe customer (cus_...), the only one this deal is for</Label>
          <Input id="catalogue-customer" required pattern="cus_[A-Za-z0-9]+" value={customer} onChange={(event) => setCustomer(event.target.value)} />
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {LIMIT_FIELDS.map((field) => (
          <div key={field.key} className="space-y-1">
            <Label htmlFor={`catalogue-limit-${field.key}`}>
              {field.label}
              {kind === "module" ? "" : " (replaces the modules' limit)"}
            </Label>
            <Input
              id={`catalogue-limit-${field.key}`}
              inputMode="numeric"
              placeholder="No limit"
              value={limits[field.key] ?? ""}
              onChange={(event) => setLimits((prev) => ({ ...prev, [field.key]: event.target.value }))}
            />
          </div>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="catalogue-monthly">Monthly price</Label>
          <Input id="catalogue-monthly" inputMode="decimal" placeholder="Not sold monthly" value={monthly} onChange={(event) => setMonthly(event.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="catalogue-annual">Annual price</Label>
          <Input id="catalogue-annual" inputMode="decimal" placeholder="Not sold annually" value={annual} onChange={(event) => setAnnual(event.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="catalogue-currency">Currency</Label>
          <Input id="catalogue-currency" required pattern="[A-Za-z]{3}" maxLength={3} value={currency} onChange={(event) => setCurrency(event.target.value)} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Stripe prices cannot change: a new price archives the old one. Customers already on it keep it until they change plan.</p>

      {save.error ? (
        <p role="alert" className="text-sm text-destructive">
          {save.error instanceof Error ? save.error.message : "That did not work. Try again."}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving..." : item ? "Save" : "Add"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ItemDialog({ item, modules }: { item: FleetBillingItemView | null; modules: FleetBillingItemView[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {item ? (
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid={`catalogue-edit-${item.id}`}>
          Edit
        </Button>
      ) : (
        <Button type="button" variant="outline" onClick={() => setOpen(true)} data-testid="catalogue-add">
          <Plus />
          Add to catalogue
        </Button>
      )}
      <DialogContent className="max-h-(--sz-90vh) overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{item ? item.name : "Add to catalogue"}</DialogTitle>
          <DialogDescription>Saved on the hub and mirrored to Stripe as a product with a monthly and an annual price.</DialogDescription>
        </DialogHeader>
        {open ? <ItemForm item={item} modules={modules} onDone={() => setOpen(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ArchiveButton({ item }: { item: FleetBillingItemView }) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const archive = useMutation({
    mutationFn: () => fleetApi.archiveCatalogueItem(item.id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.instance.fleetCatalogue }),
  });
  return (
    <Button
      type="button"
      size="sm"
      variant={confirm ? "destructive" : "outline"}
      disabled={archive.isPending}
      title="No new sales. Customers who bought it keep its features."
      onClick={() => (confirm ? archive.mutate() : setConfirm(true))}
    >
      {confirm ? "Confirm archive" : "Archive"}
    </Button>
  );
}

function Includes({ item, byId }: { item: FleetBillingItemView; byId: Map<string, FleetBillingItemView> }) {
  const parts = item.kind === "module" ? item.features.map(featureTitle) : item.moduleIds.map((id) => byId.get(id)?.name ?? "Unknown module");
  const limits = Object.entries(item.limits).map(([key, value]) => `${key.replace(/^max/, "")} ${formatNumber(value)}`);
  return (
    <div className="space-y-0.5">
      <div>{parts.length > 0 ? parts.join(", ") : <span className="text-muted-foreground">Nothing yet</span>}</div>
      {limits.length > 0 ? <div className="text-xs text-muted-foreground">{limits.join(", ")}</div> : null}
      {item.stripeCustomerId ? <div className="font-mono text-xs text-muted-foreground">Only for {item.stripeCustomerId}</div> : null}
    </div>
  );
}

function Prices({ item }: { item: FleetBillingItemView }) {
  const monthly = formatPrice(item.monthlyAmount, item.currency);
  const annual = formatPrice(item.annualAmount, item.currency);
  const wanted = Number(item.monthlyAmount !== null) + Number(item.annualAmount !== null);
  const inStripe = !item.archivedAt && item.stripeProductId !== null && item.prices.length === wanted;
  return (
    <div className="space-y-0.5 tabular-nums">
      <div>{monthly ? `${monthly} a month` : <span className="text-muted-foreground">Not monthly</span>}</div>
      <div>{annual ? `${annual} a year` : <span className="text-muted-foreground">Not annual</span>}</div>
      {item.archivedAt ? null : (
        <div className={inStripe ? "text-xs text-muted-foreground" : "text-xs font-medium text-destructive"}>
          {inStripe ? "In Stripe" : "Not in Stripe yet: save again once the hub has a Stripe key"}
        </div>
      )}
    </div>
  );
}

export function FleetCatalogue() {
  const query = useQuery({ queryKey: queryKeys.instance.fleetCatalogue, queryFn: () => fleetApi.listCatalogue(), retry: false });
  const items = query.data ?? [];
  const live = items.filter((item) => !item.archivedAt);
  const modules = live.filter((item) => item.kind === "module");
  const byId = new Map(items.map((item) => [item.id, item]));

  return (
    <section className="space-y-3" data-testid="fleet-catalogue">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Catalogue</h2>
          <p className="text-sm text-muted-foreground">
            What customers can buy on the website. Each payment re-signs the install's document; service stops at the end of the paid period.
          </p>
        </div>
        <ItemDialog item={null} modules={modules} />
      </div>
      {query.error ? (
        <p role="alert" className="text-sm text-destructive">
          The catalogue could not be loaded. Try again in a moment.
        </p>
      ) : live.length === 0 && !query.isLoading ? (
        <div className="flex items-center gap-2 rounded-lg border border-border p-4 text-sm text-muted-foreground">
          <Package className="size-4" />
          No modules yet. Add one, then group modules into packages or deals.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm" data-testid="catalogue-table">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                {["Name", "Includes", "Price", ""].map((column) => (
                  <th key={column} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {live.map((item) => (
                <tr key={item.id} className="align-top" data-testid={`catalogue-row-${item.id}`}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{item.name}</div>
                    <div className="text-xs text-muted-foreground">{KIND_LABEL[item.kind]}</div>
                  </td>
                  <td className="px-3 py-2">
                    <Includes item={item} byId={byId} />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <Prices item={item} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-2">
                      <ItemDialog item={item} modules={modules} />
                      <ArchiveButton item={item} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
