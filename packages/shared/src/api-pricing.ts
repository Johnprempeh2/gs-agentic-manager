/**
 * Published per-model API prices, used to show what subscription (OAuth) usage
 * would have cost under pay-as-you-go API billing.
 *
 * This is the single place these prices live. When a provider changes a price
 * or ships a model, update the row and API_PRICE_TABLE_CHECKED_AT together.
 * Models that are not listed are reported as "unknown"; never add a guess.
 *
 * Sources (checked on API_PRICE_TABLE_CHECKED_AT):
 * - Anthropic: https://docs.anthropic.com/en/docs/about-claude/pricing
 * - OpenAI: https://openai.com/api/pricing
 *
 * Known approximation: the Claude adapter folds cache-write tokens into
 * `inputTokens`, so they are priced at the base input rate here, while
 * Anthropic bills 5-minute cache writes at 1.25x. The API-equivalent figure is
 * therefore slightly low for cache-heavy Claude runs.
 */
export const API_PRICE_TABLE_CHECKED_AT = "2026-09-28";

export interface ApiModelPrice {
  /** USD per million uncached input tokens */
  inputPerMTok: number;
  /** USD per million cached input tokens (cache reads) */
  cachedInputPerMTok: number;
  /** USD per million output tokens */
  outputPerMTok: number;
}

interface ProviderPriceTable {
  /**
   * How the provider reports cached tokens in the ledger. Anthropic reports
   * cache reads separately from input; OpenAI counts them inside input.
   */
  cachedIncludedInInput: boolean;
  models: Record<string, ApiModelPrice>;
}

function price(inputPerMTok: number, cachedInputPerMTok: number, outputPerMTok: number): ApiModelPrice {
  return { inputPerMTok, cachedInputPerMTok, outputPerMTok };
}

export const API_PRICE_TABLE: Record<string, ProviderPriceTable> = {
  anthropic: {
    cachedIncludedInInput: false,
    models: {
      "claude-fable-5-1": price(10, 0.25, 50),
      "claude-fable-5": price(10, 1, 50),
      "claude-opus-5-5": price(4, 0.2, 20),
      "claude-opus-5": price(5, 0.5, 25),
      "claude-opus-4-8": price(5, 0.5, 25),
      "claude-opus-4-7": price(5, 0.5, 25),
      "claude-opus-4-6": price(5, 0.5, 25),
      "claude-opus-4-5": price(5, 0.5, 25),
      "claude-opus-4-1": price(15, 1.5, 75),
      "claude-opus-4": price(15, 1.5, 75),
      "claude-sonnet-5": price(2, 0.2, 10),
      "claude-sonnet-4-6": price(3, 0.3, 15),
      "claude-sonnet-4-5": price(3, 0.3, 15),
      "claude-sonnet-4": price(3, 0.3, 15),
      "claude-haiku-4-5": price(1, 0.1, 5),
    },
  },
  openai: {
    cachedIncludedInInput: true,
    models: {
      "gpt-5": price(1.25, 0.125, 10),
      "gpt-5-codex": price(1.25, 0.125, 10),
      "gpt-5.1": price(1.25, 0.125, 10),
      "gpt-5.1-codex": price(1.25, 0.125, 10),
      "gpt-5-mini": price(0.25, 0.025, 2),
      "gpt-5-nano": price(0.05, 0.005, 0.4),
    },
  },
};

/**
 * Reduce a ledger model string to a price-table key: lower case, drop a
 * cloud prefix ("us.anthropic."), a context tag ("[1m]"), a Vertex "@date"
 * or a trailing "-YYYYMMDD" snapshot date. Aliases such as "opus" are left
 * alone and resolve to unknown, because they do not name one model.
 */
export function normalizeModelForPricing(model: string): string {
  let key = model.trim().toLowerCase();
  key = key.replace(/^(?:[a-z]{2,4}\.)?anthropic\./, "");
  key = key.replace(/\[[^\]]*\]$/, "");
  key = key.replace(/@.*$/, "");
  key = key.replace(/-\d{8}$/, "");
  return key;
}

export function resolveApiPrice(provider: string, model: string): ApiModelPrice | null {
  const table = API_PRICE_TABLE[provider.trim().toLowerCase()];
  if (!table) return null;
  return table.models[normalizeModelForPricing(model)] ?? null;
}

export interface ApiEquivalentInput {
  provider: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * API-equivalent cost in cents (fractional; round only for display), or null
 * when the model has no published price in the table.
 */
export function computeApiEquivalentCents(usage: ApiEquivalentInput): number | null {
  const table = API_PRICE_TABLE[usage.provider.trim().toLowerCase()];
  const modelPrice = resolveApiPrice(usage.provider, usage.model);
  if (!table || !modelPrice) return null;
  const input = Math.max(0, usage.inputTokens);
  const cached = Math.max(0, usage.cachedInputTokens);
  const output = Math.max(0, usage.outputTokens);
  const uncachedInput = table.cachedIncludedInInput ? Math.max(0, input - cached) : input;
  const usd =
    (uncachedInput * modelPrice.inputPerMTok +
      cached * modelPrice.cachedInputPerMTok +
      output * modelPrice.outputPerMTok) /
    1_000_000;
  return usd * 100;
}
