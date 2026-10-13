// Pipedrive client for CRM sync (GRE-1100 part 2, write-back GRE-1076).
// Contract: doc/CRM-SYNC-CONTRACT.md. It reads deals and deal fields, and
// updates one deal's fields. The organisation import (GRE-1479) only reads
// organisations, persons and organisation fields. Only the sync runner calls `updateDeal`; agents
// never write to Pipedrive through it. Rate-limit answers (429) are retried
// with back-off before the caller sees them.
import type { CrmSyncFieldValue } from "@greatstone/shared";

export const PIPEDRIVE_PROVIDER_KEY = "pipedrive";
export const PIPEDRIVE_DEFAULT_BASE_URL = "https://api.pipedrive.com";
const PAGE_SIZE = 100;
/** v1 list endpoints allow up to 500 per page. */
const V1_LIST_PAGE_SIZE = 500;
const DEFAULT_MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

export type PipedriveFetch = (url: string, init: {
  method: "GET" | "PATCH";
  headers: Record<string, string>;
  body?: string;
}) => Promise<{
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

/** A linked record in a v1 answer: `owner_id` and `org_id` come back as objects or bare ids. */
export type PipedriveLink = number | { id?: number; value?: number; name?: string | null } | null;

/** One organisation from the v1 list (GRE-1479). Only the fields the import reads are typed. */
export interface PipedriveOrganization {
  id: number;
  name?: string | null;
  owner_id?: PipedriveLink;
  address_country?: string | null;
  industry?: string | number | null;
  open_deals_count?: number | null;
  won_deals_count?: number | null;
  lost_deals_count?: number | null;
  [key: string]: unknown;
}

export interface PipedriveContactValue {
  value?: string | null;
  primary?: boolean | null;
  label?: string | null;
}

/** One person from the v1 list (GRE-1479). */
export interface PipedrivePerson {
  id: number;
  name?: string | null;
  org_id?: PipedriveLink;
  job_title?: string | null;
  email?: PipedriveContactValue[] | string | null;
  phone?: PipedriveContactValue[] | string | null;
  [key: string]: unknown;
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

  async function send(
    method: "GET" | "PATCH",
    path: string,
    query: Record<string, string | number | undefined>,
    payload?: Record<string, unknown>,
  ) {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    const init = payload
      ? { method, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(payload) }
      : { method, headers };
    for (let attempt = 0; ; attempt += 1) {
      let response: Awaited<ReturnType<PipedriveFetch>>;
      try {
        response = await doFetch(url.toString(), init);
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
        const detail = await response.json().catch(() => null) as { error?: string } | null;
        throw new PipedriveApiError(
          `Pipedrive answered ${response.status} for ${path}${detail?.error ? `: ${detail.error}` : ""}`,
          response.status,
        );
      }
      const body = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (!body || body.success === false) {
        throw new PipedriveApiError(`Pipedrive returned an error for ${path}: ${body?.error ?? "no body"}`, response.status);
      }
      return body as Record<string, unknown>;
    }
  }

  const get = (path: string, query: Record<string, string | number | undefined>) => send("GET", path, query);

  /** One page of a v1 list. `nextStart` is null on the last page. */
  async function listV1Page<T>(path: string, start: number, limit: number) {
    const body = await get(path, { start, limit });
    const items = Array.isArray(body.data) ? body.data as T[] : [];
    const pagination = (body.additional_data as { pagination?: { more_items_in_collection?: boolean; next_start?: number } } | undefined)
      ?.pagination;
    const nextStart = pagination?.more_items_in_collection && typeof pagination.next_start === "number"
      ? pagination.next_start
      : null;
    return { items, nextStart };
  }

  return {
    /** One page of every organisation, all owners (API v1, read only). GRE-1479. */
    async listOrganizationsPage(input: { start?: number } = {}) {
      return listV1Page<PipedriveOrganization>("/api/v1/organizations", input.start ?? 0, V1_LIST_PAGE_SIZE);
    },

    /** One page of every person, all owners (API v1, read only). GRE-1479. */
    async listPersonsPage(input: { start?: number } = {}) {
      return listV1Page<PipedrivePerson>("/api/v1/persons", input.start ?? 0, V1_LIST_PAGE_SIZE);
    },

    /** Every organisation field, so choice fields such as industry can be shown as labels. */
    async listOrganizationFields() {
      const fields: PipedriveDealField[] = [];
      let start: number | null = 0;
      while (start !== null) {
        const page: { items: PipedriveDealField[]; nextStart: number | null } =
          await listV1Page<PipedriveDealField>("/api/v1/organizationFields", start, 500);
        fields.push(...page.items);
        start = page.nextStart;
      }
      return fields;
    },

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

    /** One deal by id (API v2). Null when Pipedrive no longer has it. */
    async getDeal(dealId: string): Promise<PipedriveDeal | null> {
      try {
        const body = await get(`/api/v2/deals/${encodeURIComponent(dealId)}`, {});
        return (body.data ?? null) as PipedriveDeal | null;
      } catch (error) {
        if (error instanceof PipedriveApiError && error.status === 404) return null;
        throw error;
      }
    },

    /** Writes changed fields to one deal (API v2 PATCH). Used by the sync runner only. */
    async updateDeal(dealId: string, patch: PipedriveDealPatch): Promise<PipedriveDeal> {
      const body = await send("PATCH", `/api/v2/deals/${encodeURIComponent(dealId)}`, {}, patch);
      return body.data as PipedriveDeal;
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

/** Body of a v2 deal update: top-level fields by name, custom fields under `custom_fields`. */
export type PipedriveDealPatch = Record<string, unknown> & { custom_fields?: Record<string, unknown> };

/** Deal fields Pipedrive sets itself. The sync never writes them. */
const PIPEDRIVE_READ_ONLY_DEAL_FIELDS = new Set([
  "id",
  "add_time",
  "update_time",
  "close_time",
  "won_time",
  "lost_time",
  "stage_change_time",
  "creator_user_id",
  "pipeline_id",
  "is_deleted",
]);

/** Custom deal fields have a 40-character hex key; every other key is a top-level field. */
function isPipedriveCustomFieldKey(key: string) {
  return /^[0-9a-f]{40}$/.test(key);
}

export class PipedriveValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipedriveValueError";
  }
}

/**
 * Turns GSAM values back into a v2 deal update. Choice fields go back from
 * labels to option ids, the reverse of `flattenPipedriveDeal`. Throws
 * `PipedriveValueError` for a read-only field or a label Pipedrive does not have.
 */
export function buildPipedriveDealPatch(
  values: Array<{ externalField: string; value: CrmSyncFieldValue }>,
  fields: PipedriveDealField[],
): PipedriveDealPatch {
  const patch: PipedriveDealPatch = {};
  const byKey = new Map(fields.map((field) => [field.key, field]));
  for (const { externalField, value } of values) {
    if (PIPEDRIVE_READ_ONLY_DEAL_FIELDS.has(externalField)) {
      throw new PipedriveValueError(`Pipedrive field ${externalField} is read-only`);
    }
    const field = byKey.get(externalField);
    let out: unknown = value;
    if (field?.options?.length && value !== null) {
      const idByLabel = new Map(field.options.map((option) => [option.label.trim().toLowerCase(), option.id]));
      const toId = (label: string) => {
        const id = idByLabel.get(label.trim().toLowerCase());
        if (id === undefined) {
          throw new PipedriveValueError(`"${label}" is not an option of the Pipedrive field ${field.name ?? externalField}`);
        }
        return typeof id === "string" && /^\d+$/.test(id) ? Number(id) : id;
      };
      out = Array.isArray(value) ? value.map(toId) : toId(String(value));
    }
    if (isPipedriveCustomFieldKey(externalField)) {
      patch.custom_fields = { ...(patch.custom_fields ?? {}), [externalField]: out };
    } else {
      patch[externalField] = out;
    }
  }
  return patch;
}
