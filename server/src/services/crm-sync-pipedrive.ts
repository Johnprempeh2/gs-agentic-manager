// Read-only Pipedrive client for CRM sync (GRE-1100 part 2). Contract:
// doc/CRM-SYNC-CONTRACT.md. It only sends GET requests; nothing here writes to
// Pipedrive. Rate-limit answers (429) are retried with back-off before the
// caller sees them.
import type { CrmSyncFieldValue } from "@greatstone/shared";

export const PIPEDRIVE_PROVIDER_KEY = "pipedrive";
export const PIPEDRIVE_DEFAULT_BASE_URL = "https://api.pipedrive.com";
const PAGE_SIZE = 100;
const DEFAULT_MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

export type PipedriveFetch = (url: string, init: { method: "GET"; headers: Record<string, string> }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

/** Pipedrive answered 429 on every try. `retryAfterMs` is how long it asked us to wait. */
export class PipedriveRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Pipedrive rate limit reached");
    this.name = "PipedriveRateLimitError";
  }
}

/** Pipedrive refused the credential (401 or 403). A person must reconnect. */
export class PipedriveAuthError extends Error {
  constructor(readonly status: number) {
    super(`Pipedrive refused the credential (${status})`);
    this.name = "PipedriveAuthError";
  }
}

export class PipedriveApiError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "PipedriveApiError";
  }
}

export interface PipedriveDeal {
  id: number;
  title?: string | null;
  stage_id?: number | null;
  pipeline_id?: number | null;
  update_time?: string | null;
  custom_fields?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface PipedriveDealField {
  key: string;
  name?: string;
  field_type?: string;
  options?: Array<{ id: number | string; label: string }> | null;
}

export interface PipedriveClientOptions {
  token: string;
  /** `oauth` sends a Bearer token; anything else sends the API token header. */
  authKind: string;
  baseUrl?: string;
  fetch?: PipedriveFetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

/** Wait time a 429 answer asks for, in ms. Falls back to exponential back-off. */
export function pipedriveRetryDelayMs(headers: { get(name: string): string | null }, attempt: number) {
  const fromHeader = Number(headers.get("retry-after") ?? headers.get("x-ratelimit-reset") ?? Number.NaN);
  const delay = Number.isFinite(fromHeader) && fromHeader >= 0
    ? fromHeader * 1_000
    : BASE_RETRY_DELAY_MS * 2 ** attempt;
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

/** Only https URLs on pipedrive.com, so a connection config cannot point the token elsewhere. */
export function resolvePipedriveBaseUrl(config: Record<string, unknown>) {
  const domain = typeof config.companyDomain === "string" ? config.companyDomain.trim() : "";
  if (domain && /^[a-z0-9][a-z0-9-]{0,62}$/i.test(domain)) return `https://${domain}.pipedrive.com`;
  return PIPEDRIVE_DEFAULT_BASE_URL;
}

export function createPipedriveClient(options: PipedriveClientOptions) {
  const baseUrl = (options.baseUrl ?? PIPEDRIVE_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as PipedriveFetch);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const headers: Record<string, string> = options.authKind === "oauth"
    ? { Authorization: `Bearer ${options.token}`, Accept: "application/json" }
    : { "x-api-token": options.token, Accept: "application/json" };

  async function get(path: string, query: Record<string, string | number | undefined>) {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    for (let attempt = 0; ; attempt += 1) {
      let response: Awaited<ReturnType<PipedriveFetch>>;
      try {
        response = await doFetch(url.toString(), { method: "GET", headers });
      } catch (error) {
        throw new PipedriveApiError(`Could not reach Pipedrive: ${(error as Error).message}`, null);
      }
      if (response.status === 429) {
        const delay = pipedriveRetryDelayMs(response.headers, attempt);
        if (attempt >= maxRetries) throw new PipedriveRateLimitError(delay);
        await sleep(delay);
        continue;
      }
      if (response.status === 401 || response.status === 403) throw new PipedriveAuthError(response.status);
      if (response.status < 200 || response.status >= 300) {
        throw new PipedriveApiError(`Pipedrive answered ${response.status} for ${path}`, response.status);
      }
      const body = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (!body || body.success === false) {
        throw new PipedriveApiError(`Pipedrive returned an error for ${path}: ${body?.error ?? "no body"}`, response.status);
      }
      return body as Record<string, unknown>;
    }
  }

  return {
    /** Deals in one Pipedrive pipeline changed since `updatedSince`, oldest change first (API v2). */
    async listDealsPage(input: { pipelineId: string; updatedSince?: string | null; cursor?: string | null }) {
      const body = await get("/api/v2/deals", {
        pipeline_id: input.pipelineId,
        updated_since: input.updatedSince ?? undefined,
        sort_by: "update_time",
        sort_direction: "asc",
        limit: PAGE_SIZE,
        cursor: input.cursor ?? undefined,
      });
      const data = Array.isArray(body.data) ? body.data as PipedriveDeal[] : [];
      const extra = body.additional_data as { next_cursor?: string | null } | undefined;
      return { deals: data, nextCursor: extra?.next_cursor ?? null };
    },

    /** Every deal field, so option ids can be shown as their labels. */
    async listDealFields() {
      const fields: PipedriveDealField[] = [];
      let start = 0;
      for (;;) {
        const body = await get("/api/v1/dealFields", { start, limit: 500 });
        if (Array.isArray(body.data)) fields.push(...body.data as PipedriveDealField[]);
        const pagination = (body.additional_data as { pagination?: { more_items_in_collection?: boolean; next_start?: number } } | undefined)
          ?.pagination;
        if (!pagination?.more_items_in_collection || typeof pagination.next_start !== "number") return fields;
        start = pagination.next_start;
      }
    },
  };
}

export type PipedriveClient = ReturnType<typeof createPipedriveClient>;

function optionLabelMap(fields: PipedriveDealField[]) {
  const labels = new Map<string, Map<string, string>>();
  for (const field of fields) {
    if (!field.options?.length) continue;
    labels.set(field.key, new Map(field.options.map((option) => [String(option.id), option.label])));
  }
  return labels;
}

function toFieldValue(raw: unknown, options: Map<string, string> | undefined): CrmSyncFieldValue {
  if (raw === undefined || raw === null) return null;
  if (options) {
    const ids = Array.isArray(raw) ? raw : typeof raw === "string" && raw.includes(",") ? raw.split(",") : null;
    if (ids) return ids.map((id) => options.get(String(id).trim()) ?? String(id).trim());
    return options.get(String(raw)) ?? String(raw);
  }
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return raw;
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => {
      const value = toFieldValue(item, undefined);
      return value === null || Array.isArray(value) ? [] : [String(value)];
    });
  }
  if (typeof raw === "object") {
    // Money ({ value, currency }), linked records ({ name, value }) and addresses ({ value }).
    const record = raw as Record<string, unknown>;
    if (typeof record.name === "string") return record.name;
    if ("value" in record) return toFieldValue(record.value, undefined);
  }
  return null;
}

/**
 * Flattens a v2 deal to `externalField -> value`: top-level fields by name and
 * custom fields by their Pipedrive key. Choice fields come back as labels.
 */
export function flattenPipedriveDeal(deal: PipedriveDeal, fields: PipedriveDealField[]) {
  const labels = optionLabelMap(fields);
  const flat: Record<string, CrmSyncFieldValue> = {};
  for (const [key, raw] of Object.entries(deal)) {
    if (key === "custom_fields") continue;
    flat[key] = toFieldValue(raw, labels.get(key));
  }
  for (const [key, raw] of Object.entries(deal.custom_fields ?? {})) {
    flat[key] = toFieldValue(raw, labels.get(key));
  }
  return flat;
}
