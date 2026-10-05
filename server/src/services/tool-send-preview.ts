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
const OBJECT_VALUE_MAX = 500;

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

/** One address as plain text: a string, or `{ name, email }` / `{ emailAddress: { address } }`. */
function renderAddress(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.emailAddress && typeof record.emailAddress === "object") {
    return renderAddress(record.emailAddress);
  }
  const address = [record.email, record.address].find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== "",
  );
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (address && name) return `${name} <${address.trim()}>`;
  return address?.trim() || name || null;
}

function renderAddressList(value: unknown): string | null {
  const items = Array.isArray(value) ? value : [value];
  const rendered = items.map(renderAddress).filter((item): item is string => item !== null);
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

type BodyPart = { label: string; text: string; hasNotes?: boolean };

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
  for (const { key, value } of pickFields(record, BODY_KEYS)) {
    if (typeof value === "string") {
      used.add(key);
      const text = normalizeText(value);
      if (text) parts.push({ label: humanizeKey(key), text });
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
    for (const [innerKey, inner] of textEntries) {
      const text = normalizeText(inner as string);
      if (text)
        parts.push({
          label: [humanizeKey(`${key} ${innerKey}`), ...notes].join(", "),
          text,
          hasNotes: notes.length > 0,
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
 * Any other argument as plain text. Text is kept whole; lists and objects
 * (attachments, blocks) are shown as compact JSON, cut at OBJECT_VALUE_MAX
 * so a large file does not fill the card.
 */
function renderOtherValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const text = normalizeText(value);
    if (!text) return null;
    return text === REDACTED_SENTINEL ? "hidden for privacy" : text;
  }
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  const json = JSON.stringify(value);
  if (!json || json === "[]" || json === "{}") return null;
  return json.length > OBJECT_VALUE_MAX
    ? `${json.slice(0, OBJECT_VALUE_MAX - 1)}…`
    : json;
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
    lines.push(`- **${label}:**`, "", ...quoteBlock(part.text, clean), "");
  }

  const otherLines: string[] = [];
  for (const [key, value] of Object.entries(redacted)) {
    if (used.has(key)) continue;
    const rendered = renderOtherValue(value);
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
