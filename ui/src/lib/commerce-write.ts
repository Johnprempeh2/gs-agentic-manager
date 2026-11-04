import { ApiError } from "@/api/client";
import type { CommerceRow } from "@/api/website-commerce";
import { text } from "@/lib/commerce";

// Commerce writes (GRE-3972, Phase C of GRE-2326). Agents draft; people publish, archive, change FX, apply imports
// and issue invoices. GSAM refuses those to anyone but a person clicking in GSAM (403 website_commerce_people_only),
// and the site refuses again. These screens hide them from anyone else, and say so.

/** Where a person makes the bridge's write and refund keys: Website > Releases > Site connection. */
export const BRIDGE_KEY_SETTINGS_PATH = "/website?tab=releases";

/** 128 random bits as 22 base64url characters: the shape GSAM's commerce routes take. */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Who may click a people-only button: a person signed in to GSAM (a session, or the local board). An agent, a
 * board API key or an unknown caller is not; the server draws the same line (`personClickOrRefuse`).
 */
export function isPersonAccess(access: { source?: string | null } | null | undefined): boolean {
  return access?.source === "session" || access?.source === "local_implicit";
}

export type CommerceWriteFailure =
  | { kind: "no_key"; capability: "write" | "refund_request"; message: string }
  | { kind: "people_only"; message: string }
  | { kind: "conflict"; message: string; current: CommerceRow | null }
  /** Activation steps that hold a full licence key (GRE-3982): the site refused them and kept the old text. */
  | { kind: "licence_key_in_text"; message: string }
  | { kind: "other"; message: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** What a failed write means for the screen. GSAM's error body is `{ error, code?, details? }`. */
export function commerceWriteFailure(error: unknown): CommerceWriteFailure {
  const message = error instanceof Error && error.message.trim() ? error.message : "The change did not go through. Try again.";
  if (!(error instanceof ApiError)) return { kind: "other", message };
  const body = record(error.body);
  const details = record(body?.details);
  const code = text(body?.code) ?? text(details?.code);
  if (error.status === 409 && code === "capability_not_configured") {
    const capability = (details?.capability ?? body?.capability) === "refund_request" ? "refund_request" : "write";
    return { kind: "no_key", capability, message };
  }
  if (error.status === 403 && code === "website_commerce_people_only") return { kind: "people_only", message };
  if (error.status === 400 && code === "website_bridge_licence_key_in_text") return { kind: "licence_key_in_text", message };
  if (error.status === 409 && code === "website_bridge_conflict") {
    return { kind: "conflict", message, current: record(details?.current ?? body?.current) };
  }
  return { kind: "other", message };
}

/** A definite answer (any 4xx): the next attempt is a new change and takes a new Idempotency-Key. */
export function isDefiniteAnswer(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

/** The row's version, for `expectedRowVersion`. */
export function rowVersionOf(row: CommerceRow | null | undefined): number | undefined {
  const value = typeof row?.row_version === "string" ? Number(row.row_version) : row?.row_version;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** "12.50", "£1,299" or "1299" in major units → minor units; "" → null; anything else → undefined (invalid). */
export function parseMajorToMinor(raw: string): number | null | undefined {
  const value = raw.trim().replace(/[£$€,\s]/g, "");
  if (value === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return undefined;
  const [whole, fraction = ""] = value.split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(minor) ? minor : undefined;
}

/** Minor units as the site sends them (a decimal string or a number) → "12.50" for an input. */
export function minorToMajor(value: unknown): string {
  const minor = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof minor !== "number" || !Number.isFinite(minor)) return "";
  return (minor / 100).toFixed(2);
}

// ---- catalogue forms ----

export type CommerceFieldKind =
  | "text" | "textarea" | "slug" | "int" | "money" | "decimal" | "bool" | "select" | "ref" | "currency" | "datetime" | "date" | "words";

export interface CommerceFieldDef {
  /** The site's body name (camelCase). */
  name: string;
  /** The row's column (snake_case). */
  column: string;
  label: string;
  kind: CommerceFieldKind;
  required?: boolean;
  help?: string;
  options?: readonly { value: string; label: string }[];
  /** A `ref` field: the resource whose rows it picks from. */
  ref?: "vendors" | "categories" | "offerings" | "customer-tiers";
  /** Wide fields span the form's two columns. */
  wide?: boolean;
}

/** The form's value for one field, from a row. Every value is a string while the person edits it. */
export function formValueOf(field: CommerceFieldDef, row: CommerceRow | null | undefined): string {
  const value = row?.[field.column];
  if (value === null || value === undefined) return field.kind === "bool" ? "false" : "";
  if (field.kind === "money") return minorToMajor(value);
  if (field.kind === "bool") return value === true || value === "true" ? "true" : "false";
  if (field.kind === "words") return Array.isArray(value) ? value.map(String).join(", ") : String(value);
  if (field.kind === "datetime") {
    const at = Date.parse(String(value));
    if (Number.isNaN(at)) return "";
    const local = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  }
  if (field.kind === "date") return String(value).slice(0, 10);
  return String(value);
}

export function formValuesOf(fields: readonly CommerceFieldDef[], row: CommerceRow | null | undefined): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field.name, formValueOf(field, row)]));
}

type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

/** One field's value for the site's body, or why it cannot be sent. Empty is null. */
export function parseFieldValue(field: CommerceFieldDef, raw: string): Parsed {
  const value = raw.trim();
  if (field.kind === "bool") return { ok: true, value: raw === "true" };
  if (value === "") {
    return field.required ? { ok: false, error: `${field.label} is required.` } : { ok: true, value: null };
  }
  switch (field.kind) {
    case "slug":
      return /^[^\s]{1,200}$/.test(value) ? { ok: true, value } : { ok: false, error: `${field.label} cannot have spaces.` };
    case "int": {
      const n = Number(value);
      return Number.isInteger(n) ? { ok: true, value: n } : { ok: false, error: `${field.label} must be a whole number.` };
    }
    case "money": {
      const minor = parseMajorToMinor(value);
      return minor === undefined ? { ok: false, error: `${field.label} must be an amount, like 12.50.` } : { ok: true, value: minor };
    }
    case "decimal":
      return /^\d{1,6}(\.\d{1,6})?$/.test(value) ? { ok: true, value } : { ok: false, error: `${field.label} must be a number, like 0.79.` };
    case "currency":
      return /^[A-Za-z]{3}$/.test(value) ? { ok: true, value: value.toUpperCase() } : { ok: false, error: `${field.label} must be a 3-letter code, like GBP.` };
    case "datetime": {
      const at = Date.parse(value);
      return Number.isNaN(at) ? { ok: false, error: `${field.label} is not a date.` } : { ok: true, value: new Date(at).toISOString() };
    }
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(value) ? { ok: true, value } : { ok: false, error: `${field.label} is not a date.` };
    case "words":
      return { ok: true, value: value.split(",").map((word) => word.trim()).filter(Boolean) };
    default:
      return { ok: true, value };
  }
}

/**
 * The site's body for a create (every filled field) or an edit (only what changed from `base`). Returns the first
 * field error instead when a value cannot be sent.
 */
export function bodyFromForm(
  fields: readonly CommerceFieldDef[],
  values: Record<string, string>,
  base: CommerceRow | null,
): { body: Record<string, unknown>; error: null } | { body: null; error: string } {
  const body: Record<string, unknown> = {};
  const before = base ? formValuesOf(fields, base) : null;
  for (const field of fields) {
    const raw = values[field.name] ?? "";
    if (before && raw === before[field.name]) continue;
    if (!before && raw.trim() === "" && field.kind !== "bool") {
      if (field.required) return { body: null, error: `${field.label} is required.` };
      continue;
    }
    if (!before && field.kind === "bool" && raw !== "true") continue;
    const parsed = parseFieldValue(field, raw);
    if (!parsed.ok) return { body: null, error: parsed.error };
    body[field.name] = parsed.value;
  }
  return { body, error: null };
}
