import { redactEventPayload, redactSensitiveText } from "../redaction.js";

/**
 * Full approval preview for tools that send an email or post a chat message
 * (GRE-800). The short gateway preview cuts each field at 140 characters, so
 * the approver could not read the whole message. For a send we show who it
 * goes to, the subject and the full body, uncut, and list every other
 * argument. Values are still redacted.
 */

const SEND_VERBS = new Set(["send", "post", "reply", "forward"]);

const RECIPIENT_FIELDS: ReadonlyArray<{ label: string; keys: readonly string[] }> = [
  { label: "To", keys: ["to", "recipient", "recipients", "torecipients", "toaddresses"] },
  { label: "Cc", keys: ["cc", "ccrecipients", "ccaddresses"] },
  { label: "Bcc", keys: ["bcc", "bccrecipients", "bccaddresses"] },
  { label: "Channel", keys: ["channel", "channelname", "chat", "chatname", "conversation", "room"] },
];
const SUBJECT_KEYS = ["subject", "topic"];
const BODY_KEYS = [
  "body",
  "text",
  "message",
  "content",
  "bodytext",
  "textbody",
  "plaintext",
  "html",
  "bodyhtml",
  "htmlbody",
  "markdown",
  "bodymarkdown",
  "mrkdwn",
  "richtext",
];
/** Text fields inside a body object, e.g. Outlook's `{ contentType, content }`. */
const BODY_OBJECT_TEXT_KEYS = [...BODY_KEYS, "value", "data"];
const REDACTED_SENTINEL = "***REDACTED***";
/** Other text up to this length stays on one line; longer text is quoted in full. */
const SHORT_VALUE_MAX = 140;
/** Base64/`data:` text at least this long is treated as file content. */
const FILE_DATA_MIN = 1000;
/** Attachment fields that hold file bytes (Gmail/Slack `data`, Outlook `contentBytes`, ...). */
const FILE_DATA_KEYS = new Set(["data", "contentbytes", "base64", "filedata", "filecontent", "bytes"]);

/** `toRecipients`, `to_recipients`, `to-recipients` → `torecipients`. */
function normalizeKey(key: string): string {
  return key.replace(/[_-]+/g, "").toLowerCase();
}

/** Split `slack_post_message` / `gmail:sendEmail` / `Send email` into lower-case words. */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isSendMessageTool(tool: { name: string; displayName?: string | null }): boolean {
  return [tool.name, tool.displayName ?? ""].some((name) =>
    nameWords(name).some((word) => SEND_VERBS.has(word)),
  );
}

const ADDRESS_OBJECT_KEYS = new Set(["name", "email", "address", "emailaddress"]);

/**
 * One address as plain text: a string, or `{ name, email }` /
 * `{ emailAddress: { address } }`. Null when the item has any other shape.
 */
function renderAddress(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  // An unknown key may hold another address, so the item is not ours to read.
  if (Object.keys(record).some((key) => !ADDRESS_OBJECT_KEYS.has(normalizeKey(key))))
    return null;
  if (record.emailAddress !== undefined) {
    return Object.keys(record).length === 1 ? renderAddress(record.emailAddress) : null;
  }
  const address = [record.email, record.address].find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== "",
  );
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (address && name) return `${name} <${address.trim()}>`;
  return address?.trim() || name || null;
}

/** Empty items are skipped; any other item that does not read as an address is shown raw. */
function renderAddressList(value: unknown): string | null {
  const items = Array.isArray(value) ? value : [value];
  const rendered: string[] = [];
  for (const item of items) {
    if (item === null || item === undefined || (typeof item === "string" && !item.trim())) continue;
    rendered.push(renderAddress(item) ?? JSON.stringify(item));
  }
  return rendered.length > 0 ? rendered.join(", ") : null;
}

/**
 * Backslash-escape markdown so the approver sees the literal text, not rendered
 * links or HTML. `:` and `@` are escaped too, so URLs and addresses are not
 * auto-linked (an auto-link would also show the escapes inside it).
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>~|&#:@]/g, "\\$&");
}

/** Every argument whose key matches, in argument order. */
function pickFields(
  record: Record<string, unknown>,
  keys: readonly string[],
): Array<{ key: string; value: unknown }> {
  return Object.entries(record)
    .filter(([key]) => keys.includes(normalizeKey(key)))
    .map(([key, value]) => ({ key, value }));
}

const ACRONYMS: Record<string, string> = { html: "HTML", id: "ID", url: "URL" };

/** `bodyHtml` → `Body HTML`. */
function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return key;
  return words
    .map((word) => ACRONYMS[word.toLowerCase()] ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

type BodyPart = { label: string; text: string; hasNotes?: boolean; isHtml?: boolean };

/** Body keys that always hold HTML. */
const HTML_BODY_KEYS = new Set(["html", "bodyhtml", "htmlbody"]);
/** Fields that say which format a body is in (`contentType: "HTML"`, `mimeType: "text/html"`). */
const FORMAT_KEYS = new Set(["contenttype", "type", "mimetype", "format", "bodytype", "bodyformat"]);
/** Flags that say a body is HTML (`isHtml: true`). */
const HTML_FLAG_KEYS = new Set(["ishtml", "html", "bodyishtml"]);
/** Body keys whose format a flag can set; `text` and `markdown` say their own format. */
const FLAGGABLE_BODY_KEYS = new Set(["body", "message", "content"]);
/** Keys that hold plain text or markdown even inside an HTML body object. */
const TEXT_FORMAT_KEYS = new Set(["text", "plaintext", "markdown", "mrkdwn"]);

/** True when the flat fields next to a body say it is HTML. */
function declaresHtml(record: Record<string, unknown>): boolean {
  return Object.entries(record).some(([key, value]) => {
    const normalized = normalizeKey(key);
    if (FORMAT_KEYS.has(normalized)) return typeof value === "string" && /\bhtml\b/i.test(value);
    return HTML_FLAG_KEYS.has(normalized) && value === true;
  });
}

/**
 * The language of the fenced block that carries an HTML body (GRE-965). The
 * approval card draws it in a sandboxed frame; anywhere else it is plain code.
 */
export const EMAIL_HTML_FENCE_LANGUAGE = "email-html";

/** A fence longer than any backtick run in the text, so the HTML cannot close it. */
function fencedBlock(text: string, language: string): string[] {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return [`${fence}${language}`, ...text.split("\n"), fence];
}

/**
 * Every body field with text, each kept whole: a mail with both a text and an
 * HTML part shows both, because the recipient may see either. A body object
 * (`{ contentType, content }`) gives one part per text field inside it. Keys
 * that are used here are added to `used`.
 */
function collectBodyParts(
  record: Record<string, unknown>,
  used: Set<string>,
): BodyPart[] {
  const parts: BodyPart[] = [];
  // A format flag next to the body (`isHtml: true`) is about a plain `body`
  // field, and only when no field is named as HTML already.
  const flaggedHtml =
    declaresHtml(record) &&
    !pickFields(record, [...HTML_BODY_KEYS]).some((field) => typeof field.value === "string");
  for (const { key, value } of pickFields(record, BODY_KEYS)) {
    if (typeof value === "string") {
      used.add(key);
      const text = normalizeText(value);
      const normalized = normalizeKey(key);
      const isHtml =
        HTML_BODY_KEYS.has(normalized) ||
        (flaggedHtml && FLAGGABLE_BODY_KEYS.has(normalized));
      if (text) parts.push({ label: humanizeKey(key), text, isHtml });
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    // Only take a flat object apart; anything nested stays whole under
    // "Other details", so nothing is dropped.
    const entries = Object.entries(value as Record<string, unknown>);
    if (
      entries.some(([, inner]) => inner !== null && typeof inner === "object")
    )
      continue;
    const isText = ([innerKey, inner]: [string, unknown]) =>
      typeof inner === "string" &&
      BODY_OBJECT_TEXT_KEYS.includes(normalizeKey(innerKey));
    const textEntries = entries.filter(isText);
    if (textEntries.length === 0) continue;
    used.add(key);
    // Other flat fields (`contentType: HTML`) go in the label.
    const notes = entries
      .filter((entry) => !isText(entry) && entry[1] !== null && entry[1] !== "")
      .map(([innerKey, inner]) => `${humanizeKey(innerKey)}: ${String(inner)}`);
    const objectIsHtml = declaresHtml(value as Record<string, unknown>);
    for (const [innerKey, inner] of textEntries) {
      const text = normalizeText(inner as string);
      const innerNormalized = normalizeKey(innerKey);
      if (text)
        parts.push({
          label: [humanizeKey(`${key} ${innerKey}`), ...notes].join(", "),
          text,
          hasNotes: notes.length > 0,
          isHtml:
            HTML_BODY_KEYS.has(innerNormalized) ||
            (objectIsHtml && !TEXT_FORMAT_KEYS.has(innerNormalized)),
        });
    }
  }
  return parts;
}

/** Quote every line (blank ones as a bare `>`) so a long text is one block and keeps its line breaks. */
function quoteBlock(text: string, clean: (line: string) => string): string[] {
  return text
    .split("\n")
    .map((line) => (line.trim() ? `> ${clean(line)}` : ">"));
}

/**
 * Long base64 file content is not words the approver can read; it is the only
 * thing ever shortened, and the card says how much. Only a `data:` URL or a
 * file-data field counts, because a long word with no spaces is base64 too.
 * Gmail's `raw` (the whole mail) is not a file-data field, so it stays whole.
 */
function shortenFileData(text: string, key: string | null): string {
  if (text.length < FILE_DATA_MIN) return text;
  const isDataUrl = /^data:[^,\s]{0,200};base64,[A-Za-z0-9+/=_\r\n-]+$/i.test(text);
  const isFileField =
    key !== null &&
    FILE_DATA_KEYS.has(normalizeKey(key)) &&
    /^[A-Za-z0-9+/=_\r\n-]+$/.test(text);
  if (!isDataUrl && !isFileField) return text;
  return `[file data, ${text.length.toLocaleString("en-US")} characters not shown]`;
}

function shortenNestedFileData(value: unknown, key: string | null): unknown {
  if (typeof value === "string") return shortenFileData(value, key);
  if (Array.isArray(value)) return value.map((item) => shortenNestedFileData(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([innerKey, inner]) => [
        innerKey,
        shortenNestedFileData(inner, innerKey),
      ]),
    );
  }
  return value;
}

/**
 * Any other argument as plain text, never cut: Slack `blocks` or an MCP
 * `content` list can be the message the recipient sees. Lists and objects are
 * JSON (indented when long); only file data inside them is shortened.
 */
function renderOtherValue(key: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const text = normalizeText(value);
    if (!text) return null;
    return text === REDACTED_SENTINEL ? "hidden for privacy" : shortenFileData(text, key);
  }
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  const shortened = shortenNestedFileData(value, key);
  const json = JSON.stringify(shortened);
  if (!json || json === "[]" || json === "{}") return null;
  return json.length > SHORT_VALUE_MAX ? JSON.stringify(shortened, null, 2) : json;
}

/**
 * Markdown lines for a send/post tool, or null when the call does not look
 * like a message (no recipient, subject or body field), so the caller falls
 * back to the short preview.
 *
 * Nothing is dropped: every body field (text, HTML, markdown, ...) is shown in
 * full, and every other argument is listed under "Other details", so the
 * approver sees everything that goes out.
 */
export function buildSendMessagePreviewLines(
  parameters: unknown,
): string[] | null {
  if (
    !parameters ||
    typeof parameters !== "object" ||
    Array.isArray(parameters)
  )
    return null;
  const redacted =
    redactEventPayload(parameters as Record<string, unknown>) ?? {};
  const clean = (text: string) => escapeMarkdown(redactSensitiveText(text));
  const used = new Set<string>();

  const fieldLines: string[] = [];
  for (const { label, keys } of RECIPIENT_FIELDS) {
    for (const field of pickFields(redacted, keys)) {
      const rendered = renderAddressList(field.value);
      if (!rendered) continue;
      fieldLines.push(`- **${label}:** ${clean(rendered)}`);
      used.add(field.key);
    }
  }
  for (const field of pickFields(redacted, SUBJECT_KEYS)) {
    if (typeof field.value !== "string" || !field.value.trim()) continue;
    fieldLines.push(`- **Subject:** ${clean(field.value.trim())}`);
    used.add(field.key);
  }

  const bodyParts = collectBodyParts(redacted, used);
  if (fieldLines.length === 0 && bodyParts.length === 0) return null;

  const lines = [...fieldLines];
  for (const part of bodyParts) {
    const label =
      bodyParts.length === 1 && !part.hasNotes ? "Message" : `Message (${clean(part.label)})`;
    // HTML goes in a fenced block, unescaped, so the card can show it as the
    // recipient sees it; the fence keeps it literal everywhere else.
    const block = part.isHtml
      ? fencedBlock(redactSensitiveText(part.text), EMAIL_HTML_FENCE_LANGUAGE)
      : quoteBlock(part.text, clean);
    lines.push(`- **${label}:**`, "", ...block, "");
  }

  const otherLines: string[] = [];
  for (const [key, value] of Object.entries(redacted)) {
    if (used.has(key)) continue;
    const rendered = renderOtherValue(key, value);
    if (rendered === null) continue;
    // Keys come from the agent too, so they are escaped like values.
    const label = `**${clean(humanizeKey(key))}:**`;
    if (rendered.includes("\n") || rendered.length > SHORT_VALUE_MAX) {
      const quoted = quoteBlock(rendered, clean).map((line) => `  ${line}`);
      otherLines.push(`- ${label}`, "", ...quoted, "");
    } else {
      otherLines.push(`- ${label} ${clean(rendered)}`);
    }
  }

  if (bodyParts.length === 0 && otherLines.length === 0) lines.push("- **Message:** no text");
  if (otherLines.length > 0) {
    if (lines.at(-1) !== "") lines.push("");
    lines.push("**Other details:**", "", ...otherLines);
  }
  while (lines.at(-1) === "") lines.pop();
  return lines;
}
