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
  return text(value) && Number.isFinite(n) ? n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 6, useGrouping: false }) : null;
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

/** The highest priced published USD offerings, as the shop shows them now and at the new rate. */
export function previewRows(offerings: readonly CommerceRow[], current: number, next: number | null, count = 10): PreviewRow[] {
  return offerings
    .filter((row) => text(row.status) === "published" && text(row.from_price_currency) === "USD" && minorOf(row.from_price_minor) !== null)
    .map((row) => ({ row, usd: minorOf(row.from_price_minor)! }))
    .sort((a, b) => b.usd - a.usd)
    .slice(0, count)
    .map(({ row, usd }) => ({
      id: text(row.id) ?? "",
      name: text(row.name) ?? "Untitled",
      usdMinor: usd,
      now: usdToGbpMinor(usd, current),
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
