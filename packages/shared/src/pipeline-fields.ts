// Typed pipeline fields (GRE-1075). A pipeline declares the fields its cases
// carry; case values in `fields.<key>` are checked against these types on
// create and edit. The value check lives here so the server and UI agree.

export const PIPELINE_FIELD_TYPES = [
  "text",
  "long_text",
  "number",
  "boolean",
  "date",
  "select",
  "multi_select",
  "email",
  "phone",
  "url",
] as const;
export type PipelineFieldType = (typeof PIPELINE_FIELD_TYPES)[number];

/** Types whose values must come from the field's option list. */
export const PIPELINE_FIELD_TYPES_WITH_OPTIONS: readonly PipelineFieldType[] = ["select", "multi_select"];

/** Same shape as `fields.<key>` in the CRM sync field map. */
export const PIPELINE_FIELD_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

export const PIPELINE_FIELD_TEXT_MAX = 500;
export const PIPELINE_FIELD_LONG_TEXT_MAX = 10_000;

/** What the value check needs to know about a field. */
export interface PipelineFieldRule {
  type: PipelineFieldType;
  options: string[];
}

export type PipelineFieldValueCheck =
  | { ok: true }
  | { ok: false; message: string };

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9 ().-]{3,40}$/;

/** Null, missing, blank text and an empty list count as "no value". */
export function isEmptyPipelineFieldValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function isCalendarDate(value: string) {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Checks one non-empty value against its field type. Callers decide what an
 * empty value means (see `isEmptyPipelineFieldValue`); this only checks shape.
 */
export function checkPipelineFieldValue(rule: PipelineFieldRule, value: unknown): PipelineFieldValueCheck {
  switch (rule.type) {
    case "text":
    case "long_text": {
      if (typeof value !== "string") return { ok: false, message: "must be text" };
      const max = rule.type === "text" ? PIPELINE_FIELD_TEXT_MAX : PIPELINE_FIELD_LONG_TEXT_MAX;
      if (value.length > max) return { ok: false, message: `must be at most ${max} characters` };
      return { ok: true };
    }
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, message: "must be a number" };
      return { ok: true };
    case "boolean":
      if (typeof value !== "boolean") return { ok: false, message: "must be true or false" };
      return { ok: true };
    case "date":
      if (typeof value !== "string" || !isCalendarDate(value)) {
        return { ok: false, message: "must be a date (YYYY-MM-DD)" };
      }
      return { ok: true };
    case "select":
      if (typeof value !== "string" || !rule.options.includes(value)) {
        return { ok: false, message: "must use one of the available choices" };
      }
      return { ok: true };
    case "multi_select": {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        return { ok: false, message: "must be a list of choices" };
      }
      if (value.some((item) => !rule.options.includes(item as string))) {
        return { ok: false, message: "must use only the available choices" };
      }
      if (new Set(value).size !== value.length) return { ok: false, message: "must not repeat a choice" };
      return { ok: true };
    }
    case "email":
      if (typeof value !== "string" || value.length > 320 || !EMAIL_PATTERN.test(value.trim())) {
        return { ok: false, message: "must be an email address" };
      }
      return { ok: true };
    case "phone":
      if (typeof value !== "string" || !PHONE_PATTERN.test(value.trim())) {
        return { ok: false, message: "must be a phone number" };
      }
      return { ok: true };
    case "url":
      if (typeof value !== "string" || value.length > 2_000 || !isHttpUrl(value.trim())) {
        return { ok: false, message: "must be a web address starting with http:// or https://" };
      }
      return { ok: true };
  }
}
