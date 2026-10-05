import { redactEventPayload, redactSensitiveText } from "../redaction.js";

/**
 * Full approval preview for tools that send an email or post a chat message
 * (GRE-800). The short gateway preview cuts each field at 140 characters, so
 * the approver could not read the whole message. For a send we show who it
 * goes to, the subject and the full body, uncut. Values are still redacted.
 */

const SEND_VERBS = new Set(["send", "post", "reply", "forward"]);

const RECIPIENT_FIELDS: ReadonlyArray<{ label: string; keys: readonly string[] }> = [
  { label: "To", keys: ["to", "recipient", "recipients", "torecipients", "toaddresses"] },
  { label: "Cc", keys: ["cc", "ccrecipients", "ccaddresses"] },
  { label: "Bcc", keys: ["bcc", "bccrecipients", "bccaddresses"] },
  { label: "Channel", keys: ["channel", "channelname", "chat", "chatname", "conversation", "room"] },
];
const SUBJECT_KEYS = ["subject", "topic"];
const BODY_KEYS = ["body", "text", "message", "content", "bodytext", "plaintext", "html", "bodyhtml"];

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

/** Backslash-escape markdown so the approver sees the literal text, not rendered links or HTML. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>~|&#]/g, "\\$&");
}

function pickField(
  record: Record<string, unknown>,
  keys: readonly string[],
): { key: string; value: unknown } | null {
  for (const [key, value] of Object.entries(record)) {
    if (keys.includes(normalizeKey(key))) return { key, value };
  }
  return null;
}

/**
 * Markdown lines for a send/post tool, or null when the call does not look
 * like a message (no recipient, subject or body field), so the caller falls
 * back to the short preview.
 */
export function buildSendMessagePreviewLines(parameters: unknown): string[] | null {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return null;
  const redacted = redactEventPayload(parameters as Record<string, unknown>) ?? {};
  const clean = (text: string) => escapeMarkdown(redactSensitiveText(text));

  const fieldLines: string[] = [];
  for (const { label, keys } of RECIPIENT_FIELDS) {
    const field = pickField(redacted, keys);
    const rendered = field ? renderAddressList(field.value) : null;
    if (rendered) fieldLines.push(`- **${label}:** ${clean(rendered)}`);
  }
  const subject = pickField(redacted, SUBJECT_KEYS);
  if (typeof subject?.value === "string" && subject.value.trim()) {
    fieldLines.push(`- **Subject:** ${clean(subject.value.trim())}`);
  }

  const body = pickField(redacted, BODY_KEYS);
  const bodyText = typeof body?.value === "string" ? body.value.replace(/\r\n?/g, "\n").trim() : "";
  if (fieldLines.length === 0 && !bodyText) return null;
  if (!bodyText) return [...fieldLines, "- **Message:** (empty)"];

  // Quote every body line (blank ones as a bare `>`) so the whole message is
  // one block and keeps its line breaks.
  const quoted = bodyText
    .split("\n")
    .map((line) => (line.trim() ? `> ${clean(line)}` : ">"));
  return [...fieldLines, "- **Message:**", "", ...quoted];
}
