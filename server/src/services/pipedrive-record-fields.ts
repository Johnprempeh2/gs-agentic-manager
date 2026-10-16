// Every Pipedrive organisation and person field that GSAM has no column for,
// kept as named fields on the record (John, 16 Oct: every field must come
// across). The field list from `/v1/organizationFields` or `/v1/personFields`
// drives it, so custom fields, labels, the full address and fields Pipedrive
// adds later all come across without a code change.
import type { CrmRecordField } from "@greatstone/shared";
import type { PipedriveDealField } from "./crm-sync-pipedrive.js";

/** Longest text kept for one field, so one huge field cannot fill the record. */
const MAX_TEXT = 10_000;

/** Fields GSAM already holds in its own columns, or that mean nothing outside Pipedrive. */
export const ORGANISATION_COLUMN_KEYS = new Set([
  "id",
  "name",
  "owner_id",
  "address_country",
  "industry",
  "picture_id",
  "company_id",
  "active_flag",
  "first_char",
]);

export const PERSON_COLUMN_KEYS = new Set([
  "id",
  "name",
  "org_id",
  "job_title",
  "picture_id",
  "company_id",
  "active_flag",
  "first_char",
  "first_name",
  "last_name",
]);

function str(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return null;
}

function nameOf(value: unknown, users: Map<string, string>): string | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return str(record.name) ?? (str(record.value ?? record.id) ? users.get(String(record.value ?? record.id)) ?? null : null);
  }
  const id = str(value);
  return id ? users.get(id) ?? id : null;
}

/** "a@x (work), b@y (home)" from a v1 email or phone list. */
function contactList(value: unknown): string | null {
  if (!Array.isArray(value)) return str(value);
  const parts = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as { value?: unknown; label?: unknown };
    const text = str(item.value);
    if (!text) return [];
    const label = str(item.label);
    return [label ? `${text} (${label})` : text];
  });
  return parts.length ? parts.join(", ") : null;
}

function choiceIds(raw: unknown): string[] {
  if (raw === null || raw === undefined || raw === "") return [];
  if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean);
  return String(raw).split(",").map((item) => item.trim()).filter(Boolean);
}

/** One field's value as GSAM shows it, or null when it is empty. */
export function formatPipedriveFieldValue(
  field: PipedriveDealField,
  record: Record<string, unknown>,
  users: Map<string, string>,
): CrmRecordField["value"] | null {
  const raw = record[field.key];
  const options = new Map((field.options ?? []).map((option) => [String(option.id), option.label.trim()]));
  switch (field.field_type) {
    case "enum":
    case "set": {
      // `label_ids` is a list; older accounts answer `label` as one id.
      const labels = [...new Set(choiceIds(raw).map((id) => options.get(id) ?? id))];
      if (labels.length === 0) return null;
      return field.field_type === "enum" && labels.length === 1 ? labels[0]! : labels;
    }
    case "user":
      return nameOf(raw, users);
    case "org":
    case "people":
      return nameOf(raw, new Map());
    case "monetary": {
      const amount = raw && typeof raw === "object" ? (raw as Record<string, unknown>).value : raw;
      const currency = str(raw && typeof raw === "object" ? (raw as Record<string, unknown>).currency : record[`${field.key}_currency`]);
      const text = str(amount);
      return text ? (currency ? `${text} ${currency}` : text) : null;
    }
    case "double":
    case "int": {
      const number = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
      return Number.isFinite(number) ? number : str(raw);
    }
    case "daterange":
    case "timerange": {
      const from = str(raw);
      const until = str(record[`${field.key}_until`]);
      return from && until ? `${from} to ${until}` : from;
    }
    case "address": {
      if (raw && typeof raw === "object") {
        const address = raw as Record<string, unknown>;
        return str(address.formatted_address) ?? str(address.value);
      }
      return str(record[`${field.key}_formatted_address`]) ?? str(raw);
    }
    default: {
      if (Array.isArray(raw)) return contactList(raw);
      if (raw && typeof raw === "object") return nameOf(raw, users) ?? str((raw as Record<string, unknown>).value);
      return str(raw);
    }
  }
}

/**
 * Every field of a Pipedrive record that has a value and no GSAM column, in
 * Pipedrive's field order, labelled with Pipedrive's name for it.
 */
export function pipedriveRecordFields(
  record: Record<string, unknown>,
  fields: PipedriveDealField[],
  input: { skip: Set<string>; users?: Map<string, string> },
): CrmRecordField[] {
  const users = input.users ?? new Map<string, string>();
  const out: CrmRecordField[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    if (input.skip.has(field.key) || seen.has(field.key)) continue;
    seen.add(field.key);
    const value = formatPipedriveFieldValue(field, record, users);
    if (value === null || (Array.isArray(value) && value.length === 0)) continue;
    out.push({
      key: field.key,
      label: field.name?.trim() || field.key,
      value: typeof value === "string" ? value.slice(0, MAX_TEXT) : value,
    });
  }
  return out;
}

/** True when two field lists hold the same fields and values in the same order. */
export function sameRecordFields(a: CrmRecordField[] | null | undefined, b: CrmRecordField[] | null | undefined) {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((field, index) => {
    const other = right[index]!;
    return field.key === other.key && field.label === other.label && JSON.stringify(field.value) === JSON.stringify(other.value);
  });
}
