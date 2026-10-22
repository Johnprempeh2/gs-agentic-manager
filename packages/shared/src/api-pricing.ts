/**
 * Published API-equivalent prices. Dates are UTC days; until is exclusive.
 * Existing Anthropic and OpenAI prices retain the old undated table's coverage
 * for historical usage. Their effective start is a compatibility boundary,
 * not a claim that these prices were published on that date.
 */
/** Legacy table check date. Each dated row carries its own source. */
export const API_PRICE_TABLE_CHECKED_AT = "2026-09-28";

export interface ApiModelPrice {
  inputPerMTok: number;
  cachedInputPerMTok: number;
  outputPerMTok: number;
  effectiveFrom: string;
  effectiveUntil?: string;
  sourceUrl: string;
}

interface ProviderPriceTable {
  /** Anthropic reports cache reads outside input; OpenAI and Google include them. */
  cachedIncludedInInput: boolean;
  models: Record<string, ApiModelPrice[]>;
}

const ANTHROPIC_SOURCE = "https://docs.anthropic.com/en/docs/about-claude/pricing";
const OPENAI_SOURCE = "https://openai.com/api/pricing";
// Checked 2026-10-22: standard tier, short context (<=272K input tokens). Longer
// prompts bill at 2x input / 1.5x output; we only see per-run totals, so they are under-estimated.
const OPENAI_DEV_SOURCE = "https://developers.openai.com/api/docs/pricing";
const GPT_5_6_SOURCE = "https://developers.openai.com/api/docs/models/GPT-5.6";
const ARGON_SOURCE = "https://cloud.google.com/blog/products/ai-machine-learning/gemini-4-argon-available-on-google-cloud";

function price(input: number, cached: number, output: number, effectiveFrom: string, sourceUrl: string, effectiveUntil?: string): ApiModelPrice {
  return { inputPerMTok: input, cachedInputPerMTok: cached, outputPerMTok: output, effectiveFrom, ...(effectiveUntil ? { effectiveUntil } : {}), sourceUrl };
}
const LEGACY_EFFECTIVE_FROM = "1970-01-01";
const anthropic = (input: number, cached: number, output: number) => [price(input, cached, output, LEGACY_EFFECTIVE_FROM, ANTHROPIC_SOURCE)];
const openai = (input: number, cached: number, output: number) => [price(input, cached, output, LEGACY_EFFECTIVE_FROM, OPENAI_SOURCE)];

export const API_PRICE_TABLE: Record<string, ProviderPriceTable> = {
  anthropic: {
    cachedIncludedInInput: false,
    models: {
      "claude-fable-5-1": anthropic(10, 0.25, 50),
      "claude-fable-5": anthropic(10, 1, 50),
      "claude-opus-5-5": anthropic(4, 0.2, 20),
      "claude-opus-5": anthropic(5, 0.5, 25),
      "claude-opus-4-8": anthropic(5, 0.5, 25),
      "claude-opus-4-7": anthropic(5, 0.5, 25),
      "claude-opus-4-6": anthropic(5, 0.5, 25),
      "claude-opus-4-5": anthropic(5, 0.5, 25),
      "claude-opus-4-1": anthropic(15, 1.5, 75),
      "claude-opus-4": anthropic(15, 1.5, 75),
      "claude-sonnet-5": anthropic(2, 0.2, 10),
      "claude-sonnet-4-6": anthropic(3, 0.3, 15),
      "claude-sonnet-4-5": anthropic(3, 0.3, 15),
      "claude-sonnet-4": anthropic(3, 0.3, 15),
      "claude-haiku-4-5": anthropic(1, 0.1, 5),
    },
  },
  openai: {
    cachedIncludedInInput: true,
    models: {
      "gpt-5": openai(1.25, 0.125, 10),
      "gpt-5-codex": openai(1.25, 0.125, 10),
      "gpt-5.1": openai(1.25, 0.125, 10),
      "gpt-5.1-codex": openai(1.25, 0.125, 10),
      "gpt-5-mini": openai(0.25, 0.025, 2),
      "gpt-5-nano": openai(0.05, 0.005, 0.4),
      "gpt-6-astra": [price(10, 1, 50, LEGACY_EFFECTIVE_FROM, OPENAI_DEV_SOURCE)],
      "gpt-6-sol": [price(2, 0.2, 10, LEGACY_EFFECTIVE_FROM, OPENAI_DEV_SOURCE)],
      "gpt-6-luna": [price(0.1, 0.01, 0.5, LEGACY_EFFECTIVE_FROM, OPENAI_DEV_SOURCE)],
      "gpt-5.6-sol": [
        price(5, 0.5, 30, LEGACY_EFFECTIVE_FROM, GPT_5_6_SOURCE, "2026-08-21"),
        // OpenAI calls this promotional, "at least through November 21, 2026"; add a dated row when it ends.
        price(4, 0.4, 20, "2026-08-21", OPENAI_DEV_SOURCE),
      ],
    },
  },
  google: {
    cachedIncludedInInput: true,
    models: {
      "gemini-4-argon": [
        // Google states cached input is 95% off input pricing.
        price(2, 0.1, 10, "2026-10-14", ARGON_SOURCE, "2026-12-01"),
        price(4, 0.2, 20, "2026-12-01", ARGON_SOURCE),
      ],
    },
  },
};

/** Remove cloud prefixes, context tags and snapshot suffixes. */
export function normalizeModelForPricing(model: string): string {
  let key = model.trim().toLowerCase();
  key = key.replace(/^(?:[a-z]{2,4}\.)?anthropic\./, "");
  key = key.replace(/\[[^\]]*\]$/, "");
  key = key.replace(/@.*$/, "");
  key = key.replace(/-\d{8}$/, "");
  return key;
}

/** effectiveUntil is the first day on which the row does not apply. */
export function resolveApiPrice(provider: string, model: string, at: Date | string = new Date()): ApiModelPrice | null {
  const table = API_PRICE_TABLE[provider.trim().toLowerCase()];
  const day = at instanceof Date ? at.toISOString().slice(0, 10) : at.slice(0, 10);
  const rows = table?.models[normalizeModelForPricing(model)] ?? [];
  return rows.find((row) => row.effectiveFrom <= day && (!row.effectiveUntil || day < row.effectiveUntil)) ?? null;
}

export interface ApiEquivalentInput {
  provider: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** Fractional cents; null means the model is unpriced on that UTC day. */
export function computeApiEquivalentCents(usage: ApiEquivalentInput, at: Date | string = new Date()): number | null {
  const table = API_PRICE_TABLE[usage.provider.trim().toLowerCase()];
  const modelPrice = resolveApiPrice(usage.provider, usage.model, at);
  if (!table || !modelPrice) return null;
  const input = Math.max(0, usage.inputTokens);
  const cached = Math.max(0, usage.cachedInputTokens);
  const output = Math.max(0, usage.outputTokens);
  const uncachedInput = table.cachedIncludedInInput ? Math.max(0, input - cached) : input;
  return ((uncachedInput * modelPrice.inputPerMTok + cached * modelPrice.cachedInputPerMTok + output * modelPrice.outputPerMTok) / 1_000_000) * 100;
}

export interface DatedUsage extends ApiEquivalentInput { occurredAt: Date | string }

/** Sum known priced usage while retaining the rows and tokens that could not be priced. */
export function priceDatedUsage(events: readonly DatedUsage[]) {
  let cents = 0;
  let unpricedTokens = 0;
  const priceRows = new Map<string, ApiModelPrice>();
  for (const event of events) {
    const row = resolveApiPrice(event.provider, event.model, event.occurredAt);
    if (row) {
      cents += computeApiEquivalentCents(event, event.occurredAt)!;
      priceRows.set(JSON.stringify(row), row);
    } else {
      unpricedTokens += event.inputTokens + event.cachedInputTokens + event.outputTokens;
    }
  }
  return { cents, unpricedTokens, priceRows: [...priceRows.values()] };
}

/** Project each model's observed daily token rate onto each remaining UTC day. */
export function forecastDatedUsage(events: readonly ApiEquivalentInput[], from: Date, until: Date) {
  let cents = 0;
  const unpriced: { provider: string; model: string; day: string }[] = [];
  for (let day = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); day < until.getTime(); day += 86_400_000) {
    const date = new Date(day).toISOString().slice(0, 10);
    for (const event of events) {
      const price = computeApiEquivalentCents(event, date);
      if (price === null) unpriced.push({ provider: event.provider, model: event.model, day: date });
      else cents += price;
    }
  }
  return { cents, unpriced };
}
