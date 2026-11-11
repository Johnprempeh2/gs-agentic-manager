import type { CommerceRow } from "@/api/website-commerce";
import { text } from "@/lib/commerce";

// The website's display rate is US dollars per pound: GBP shown = USD / rate, rounded to the whole pound
// (src/lib/pricing.mjs usdToGbpMinor on the site, mirrored by its checkout). Default 1.30. These helpers mirror it
// so GSAM previews exactly what the shop will show and charge.

export const MIN_RATE = 0.1;
export const MAX_RATE = 100;
export const FX_AGEING_DAYS = 14;
export const FX_STALE_DAYS = 30;

const RATE = /^\d{1,6}(\.\d{1,6})?$/;

// The shop currency (website migration 074): pounds (the default, today's behaviour) or the stored US dollars as
// they are, with no rate. The site reads anything but "USD", a missing setting included, as pounds; so does GSAM.
export type ShopCurrency = "GBP" | "USD";
export const SHOP_CURRENCY_NAMES: Record<ShopCurrency, string> = { GBP: "Pounds (GBP)", USD: "US dollars (USD)" };
export const shopCurrencyOf = (value: unknown): ShopCurrency => (text(value) === "USD" ? "USD" : "GBP");
/** A site that does not report shop_currency yet (before 074 is deployed) cannot switch it. */
export const canSwitchCurrency = (item: CommerceRow) => typeof item.shop_currency === "string";

/** What the shop shows for a stored dollar price: the dollars as stored, or pounds at the rate (usdToGbpMinor). */
export function shopMinor(usdMinor: number | null, rate: number, currency: ShopCurrency): number | null {
  if (currency === "GBP") return usdToGbpMinor(usdMinor, rate);
  return usdMinor === null || !Number.isFinite(usdMinor) ? null : usdMinor;
}

const MONEY = {
  GBP: new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 }),
  USD: new Intl.NumberFormat("en-GB", { style: "currency", currency: "USD" }),
};
/** A shop price as the website shows it: whole pounds, or dollars and cents. */
export const shopMoney = (minor: number | null, currency: ShopCurrency) =>
  minor === null ? "Price on application" : MONEY[currency].format(minor / 100);

/** The site's conversion: USD minor units to GBP minor units, whole pounds. Null for POA or a bad rate. */
export function usdToGbpMinor(usdMinor: number | null, rate: number): number | null {
  if (usdMinor === null || !Number.isFinite(usdMinor)) return null;
  if (!(rate > 0)) return null;
  return Math.round(usdMinor / 100 / rate) * 100;
}

/** A typed rate, or a reason it is not one. */
export function parseRate(raw: string): { rate: number } | { problem: string } {
  const value = raw.trim();
  if (!RATE.test(value)) return { problem: "Enter the dollars for one pound, like 1.30." };
  const rate = Number(value);
  if (rate < MIN_RATE || rate > MAX_RATE) return { problem: `Enter a rate between ${MIN_RATE.toFixed(2)} and ${MAX_RATE}.` };
  return { rate };
}

/** A stored rate ("1.300000") as people write it: 1.30. Null when it is not a number. */
export function showRate(value: unknown): string | null {
  const n = Number(text(value));
  if (!text(value) || !Number.isFinite(n)) return null;
  return n.toFixed(6).replace(/0+$/, "").replace(/\.(\d?)$/, (_, d: string) => `.${d.padEnd(2, "0")}`);
}

/** "$1.30 to the pound" read the other way: pounds for one dollar, to 4 places. */
export const poundsPerDollar = (rate: number) => (rate > 0 ? (1 / rate).toFixed(4) : null);

export type Staleness = { days: number; level: "fresh" | "ageing" | "stale"; label: string } | null;

/** How long ago a person last set the rate. Nothing updates it on its own. */
export function rateStaleness(updatedAt: unknown, now = new Date()): Staleness {
  const at = text(updatedAt);
  const time = at ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(time)) return null;
  const days = Math.max(0, Math.floor((now.getTime() - time) / 86_400_000));
  const level = days >= FX_STALE_DAYS ? "stale" : days >= FX_AGEING_DAYS ? "ageing" : "fresh";
  const ago = days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  return { days, level, label: `Set ${ago}` };
}

const minorOf = (value: unknown) => {
  const n = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(n) ? null : n;
};

export interface PreviewRow { id: string; name: string; usdMinor: number; now: number | null; next: number | null }

/**
 * The highest priced published USD offerings, as the shop shows them now (in its currency) and at the new rate (in
 * pounds; null when no new rate).
 */
export function previewRows(offerings: readonly CommerceRow[], current: number, next: number | null, count = 10,
  currency: ShopCurrency = "GBP"): PreviewRow[] {
  return offerings
    .filter((row) => text(row.status) === "published" && text(row.from_price_currency) === "USD" && minorOf(row.from_price_minor) !== null)
    .map((row) => ({ row, usd: minorOf(row.from_price_minor)! }))
    .sort((a, b) => b.usd - a.usd)
    .slice(0, count)
    .map(({ row, usd }) => ({
      id: text(row.id) ?? "",
      name: text(row.name) ?? "Untitled",
      usdMinor: usd,
      now: shopMinor(usd, current, currency),
      next: next === null ? null : usdToGbpMinor(usd, next),
    }));
}

/** Every edition price the rate reprices: USD prices on live offerings, by currency. */
export function priceCounts(offerings: readonly CommerceRow[]): { usd: number; other: Record<string, number>; products: number } {
  let usd = 0;
  const other: Record<string, number> = {};
  const products = new Set<string>();
  for (const offering of offerings) {
    const variants = Array.isArray(offering.variants) ? (offering.variants as CommerceRow[]) : [];
    for (const variant of variants) {
      if (minorOf(variant.base_price_minor) === null) continue;
      const currency = text(variant.currency) ?? "unknown";
      if (currency === "USD") {
        usd += 1;
        products.add(text(offering.id) ?? "");
      } else other[currency] = (other[currency] ?? 0) + 1;
    }
  }
  return { usd, other, products: products.size };
}

export interface RuleHit { id: string; name: string; base: number; final: number }

/**
 * What one pricing rule does to the catalogue, as the shop prices it (the site's src/lib/pricing.mjs effectivePrice
 * and store-pricing.mjs): each published offering's from price in pounds at the display rate, then this rule's cut,
 * never below the rule's floor or zero. In a US dollar shop the from price is the stored dollars. A fixed cut applies
 * only in the shop's currency. Ignores dates, the audience and other rules, so it reads "who this rule reaches", not
 * today's winner.
 */
export function ruleHits(rule: CommerceRow, offerings: readonly CommerceRow[], rate: number, shop: ShopCurrency = "GBP"): RuleHit[] {
  const targets = Array.isArray(rule.targets) ? (rule.targets as CommerceRow[]) : [];
  const ids = (column: string) => new Set(targets.map((t) => text(t[column])).filter((v): v is string => !!v));
  const scope = text(rule.scope_type);
  const vendors = ids("vendor_id"), categories = ids("category_id"), offeringIds = ids("offering_id");
  const onlyType = text(rule.applies_to_offering_type);
  const pct = Number(text(rule.adjustment_value_pct) ?? 0);
  const fixed = minorOf(rule.adjustment_value) ?? 0;
  const floorFraction = Number(text(rule.floor_fraction) ?? 0) || 0;
  const reaches = (o: CommerceRow) => {
    if (onlyType && text(o.type) !== onlyType) return false;
    if (scope === "all" || scope === "tier") return true;
    if (scope === "vendor") return vendors.has(text(o.vendor_id) ?? "");
    if (scope === "category") return categories.has(text(o.category_id) ?? "");
    if (scope === "offering") return offeringIds.has(text(o.id) ?? "");
    return false;
  };
  const hits: RuleHit[] = [];
  for (const o of offerings) {
    if (text(o.status) !== "published" || !reaches(o)) continue;
    const stored = minorOf(o.from_price_minor);
    const currency = text(o.from_price_currency);
    const base = currency === "USD" ? shopMinor(stored, rate, shop) : currency === "GBP" && shop === "GBP" ? stored : null;
    if (base === null) continue;
    const cut = text(rule.adjustment_type) === "percentage" ? (pct > 0 ? Math.round((base * pct) / 100) : 0)
      : text(rule.adjustment_type) === "fixed" && text(rule.currency) === shop ? fixed : 0;
    if (!(cut > 0)) continue;
    const final = Math.max(base - cut, Math.round(base * floorFraction), 0);
    if (final < base) hits.push({ id: text(o.id) ?? "", name: text(o.name) ?? "Untitled", base, final });
  }
  return hits.sort((a, b) => b.base - b.final - (a.base - a.final));
}
