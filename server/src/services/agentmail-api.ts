import { z } from "zod";
import { Webhook } from "svix";
import type { EmailEnvelope } from "@greatstone/shared";
import type { HttpError } from "../errors.js";
import {
  providerStep,
  providerStepError,
  sanitizeProviderText,
} from "./provider-setup-errors.js";

const strings = z.array(z.string());
export const agentmailMessageSchema = z.object({
  inbox_id: z.string().min(1),
  thread_id: z.string().min(1),
  message_id: z.string().min(1),
  from: z.string().default(""),
  to: strings.default([]),
  cc: strings.optional(),
  bcc: strings.optional(),
  reply_to: strings.optional(),
  subject: z.string().default("(No subject)"),
  text: z.string().optional(),
  html: z.string().optional(),
  extracted_text: z.string().optional(),
  timestamp: z.string().datetime({ offset: true }),
  created_at: z.string().datetime({ offset: true }).optional(),
  labels: strings.default([]),
  headers: z.record(z.string(), z.string()).default({}),
  attachments: z
    .array(
      z.object({
        attachment_id: z.string(),
        filename: z.string().optional(),
        content_type: z.string().optional(),
        size: z.number().nonnegative(),
      }),
    )
    .default([]),
});
export type AgentmailMessage = z.infer<typeof agentmailMessageSchema>;
export interface AgentmailInbox {
  inbox_id: string;
  display_name?: string;
}
export interface AgentmailScope {
  scope_type: "organization" | "pod" | "inbox";
  organization_id: string;
  pod_id?: string;
  inbox_id?: string;
}
export interface AgentmailErrorDetail {
  /** HTTP method of the failed request. */
  method?: string;
  /** Path template with identifiers replaced, e.g. `/inboxes/{id}/api-keys`. */
  path?: string;
  /** Provider machine code (`code`, else `name`), sanitised. */
  providerCode?: string;
  /** Provider human message, sanitised and length-capped. */
  providerMessage?: string;
}
export class AgentmailApiError extends Error {
  readonly method?: string;
  readonly path?: string;
  readonly providerCode?: string;
  readonly providerMessage?: string;
  constructor(
    readonly status: number,
    readonly retryAfterMs = 1000,
    detail: AgentmailErrorDetail = {},
  ) {
    // Only the structured `code` and `message` fields of a JSON error body are
    // kept, sanitised. Raw bodies may contain private mail and are never kept.
    const said = [detail.providerCode, detail.providerMessage]
      .filter(Boolean)
      .join(": ");
    super(
      `AgentMail request failed (${status})${detail.method && detail.path ? ` on ${detail.method} ${detail.path}` : ""}${said ? `: ${said}` : ""}`,
    );
    this.name = "AgentmailApiError";
    this.method = detail.method;
    this.path = detail.path;
    this.providerCode = detail.providerCode;
    this.providerMessage = detail.providerMessage;
  }
}

const AGENTMAIL_COLLECTIONS = new Set([
  "inboxes",
  "domains",
  "messages",
  "threads",
  "api-keys",
  "webhooks",
  "attachments",
  "pods",
  "drafts",
]);
const AGENTMAIL_LITERAL_SEGMENTS = new Set(["send", "reply", "me"]);
/** Replace identifiers in an API path so it can be logged and shown. */
export function agentmailPathTemplate(path: string): string {
  const segments = path.split("?")[0].split("/");
  return segments
    .map((segment, index) =>
      index > 0 &&
      AGENTMAIL_COLLECTIONS.has(segments[index - 1]) &&
      segment &&
      !AGENTMAIL_LITERAL_SEGMENTS.has(segment)
        ? "{id}"
        : segment,
    )
    .join("/");
}

/** Extract a safe code and message from an AgentMail error response. */
export async function agentmailErrorDetail(
  response: Response,
  apiKey: string,
): Promise<Pick<AgentmailErrorDetail, "providerCode" | "providerMessage">> {
  let text = "";
  try {
    text = (await response.text()).slice(0, 16 * 1024);
  } catch {
    return {};
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON bodies are not structured errors and may echo private data.
    return {};
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const record = body as Record<string, unknown>;
  const code = [record.code, record.name].find(
    (value): value is string =>
      typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value),
  );
  const message = [record.message, record.error, record.detail].find(
    (value): value is string => typeof value === "string",
  );
  return {
    providerCode: code,
    providerMessage: sanitizeProviderText(message, [apiKey]),
  };
}
export const AGENTMAIL_EVENTS = [
  "message.received",
  "message.sent",
  "message.delivered",
  "message.bounced",
  "message.complained",
  "message.rejected",
];
export function emailText(message: AgentmailMessage): string {
  return (
    message.extracted_text ??
    message.text ??
    (message.html
      ? message.html
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]*>/g, " ")
      : "")
  ).slice(0, 100_000);
}
/** Reconstruct only visible recipients; never let provider reply-all inherit Bcc. */
export function emailReplyRecipients(
  message: EmailEnvelope,
  ownAddress: string,
  replyAll: boolean,
) {
  const address = (value: string) =>
    (value.match(/<([^>]+)>/)?.[1] ?? value).trim();
  const seen = new Set([address(ownAddress).toLowerCase()]);
  const unique = (values: string[]) =>
    values.map(address).filter((value) => {
      const key = value.toLowerCase();
      if (!value || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const replyTargets = message.replyTo?.length ? message.replyTo : [message.from];
  const to = unique([...replyTargets, ...(replyAll ? message.to : [])]);
  const cc = unique(replyAll ? (message.cc ?? []) : []);
  return { to, cc, bcc: [], reply_all: false };
}
export function isAutomaticEmail(message: AgentmailMessage): boolean {
  const headers = Object.fromEntries(
    Object.entries(message.headers).map(([k, v]) => [
      k.toLowerCase(),
      v.toLowerCase(),
    ]),
  );
  return Boolean(
    (headers["auto-submitted"] && headers["auto-submitted"] !== "no") ||
      /^(bulk|list|junk)$/.test(headers.precedence ?? "") ||
      headers["x-autoreply"] ||
      headers["x-autorespond"],
  );
}
export function isFilteredEmail(message: AgentmailMessage): boolean {
  return message.labels.some((label) =>
    ["spam", "blocked", "unauthenticated", "trash"].includes(label),
  );
}
export function verifyAgentmailWebhook(
  body: Buffer,
  headers: Record<string, string>,
  secret: string,
): unknown {
  return new Webhook(secret).verify(body.toString("utf8"), headers);
}
export function normalizeAgentmailEvent(value: unknown) {
  const parsed = z
    .object({
      type: z.string().optional(),
      event_type: z.string().optional(),
      event_id: z.string().optional(),
      message: z.unknown().optional(),
      send: z.unknown().optional(),
      delivery: z.unknown().optional(),
      bounce: z.unknown().optional(),
      complaint: z.unknown().optional(),
      reject: z.unknown().optional(),
    })
    .parse(value);
  const kind =
    parsed.event_type ?? parsed.type?.replace(/^message_/, "message.");
  if (!kind || !AGENTMAIL_EVENTS.includes(kind)) return null;
  // Provider receipts use event-specific envelopes, shared by both transports.
  // Internal reconciliation events may supply the fetched message directly.
  const receipts: Record<string, unknown> = {
    "message.sent": parsed.send,
    "message.delivered": parsed.delivery,
    "message.bounced": parsed.bounce,
    "message.complained": parsed.complaint,
    "message.rejected": parsed.reject,
  };
  // Fetch the authoritative message before intake; delivery events have reduced payloads.
  const message = z
    .object({ inbox_id: z.string(), message_id: z.string() })
    .parse(receipts[kind] ?? parsed.message);
  return {
    kind,
    ...message,
    eventId: parsed.event_id ?? `${kind}:${message.message_id}`,
  };
}

/** Steps of AgentMail connection setup, with the next action for common refusals. */
export const AGENTMAIL_STEPS = {
  checkKey: {
    step: "accept the API key",
    hints: {
      401: "Check that you pasted the complete AgentMail API key (it starts with am_) and that it has not been revoked or expired.",
      403: "AgentMail did not accept this key. Paste the complete key from console.agentmail.to again, check it has not been revoked, and check it is not limited by permissions. GS Agentic Manager uses api.agentmail.to, so keys for AgentMail's EU region (api.agentmail.eu) are not supported yet.",
    },
  },
  readDomains: {
    step: "read your custom domains",
    hints: {
      403: "This key cannot read domains (domain_read). Use the agentmail.to domain, or create the inbox in the AgentMail dashboard and choose it here.",
    },
  },
  readInbox: {
    step: "read the inbox",
    hints: {
      403: "This key cannot read that inbox (inbox_read). Use a key that covers the inbox.",
      404: "AgentMail could not find that inbox for this key. Check the address and that the key belongs to the same organisation, pod or inbox.",
    },
  },
  listInboxes: {
    step: "list your inboxes",
    hints: {
      403: "This key cannot list inboxes (inbox_read). Use a key with inbox_read, or an inbox-scoped key.",
    },
  },
  createInbox: {
    step: "create an inbox",
    hints: {
      402: "Your AgentMail plan does not allow another inbox. Upgrade the plan, or choose an existing inbox here.",
      403: "Your key or plan may not allow creating inboxes (inbox_create). Create the inbox in the AgentMail dashboard and choose it here, or use an organisation key with inbox_create.",
      409: "That email address is already taken. Choose a different username.",
      422: "AgentMail could not create that address. Check the username and domain, or your plan's inbox limit.",
    },
  },
  createInboxKey: {
    step: "create an inbox-scoped API key",
    hints: {
      402: "Your AgentMail plan does not allow creating keys: create an inbox and an inbox-scoped key in the AgentMail dashboard, choose that inbox here, and use WebSocket receiving.",
      403: "Your plan or key may not allow creating keys: create an inbox and an inbox-scoped key in the AgentMail dashboard, choose that inbox here, and use WebSocket receiving.",
    },
  },
  checkRuntimeKey: {
    step: "accept the inbox-scoped runtime key",
    hints: {
      403: "The inbox-scoped key was refused. Create an inbox-scoped key for this inbox in the AgentMail dashboard and reconnect with it.",
    },
  },
  createWebhook: {
    step: "register the webhook",
    hints: {
      403: "This AgentMail key cannot create webhooks. Enable webhook_create, webhook_read and webhook_delete for this inbox's key in AgentMail, or use WebSocket receiving (Live connection).",
      409: "A webhook for this inbox already exists in AgentMail. Remove it in the AgentMail dashboard, or use WebSocket receiving.",
      422: "AgentMail did not accept the webhook URL. Check that the public HTTPS URL is reachable from the internet, or use WebSocket receiving.",
    },
  },
  removeWebhook: { step: "remove the previous webhook", hints: {} },
  removeInboxKey: { step: "remove the previous inbox-scoped key", hints: {} },
} as const satisfies Record<
  string,
  { step: string; hints: Partial<Record<number, string>> }
>;
export type AgentmailStep = keyof typeof AGENTMAIL_STEPS;

/** Turn an AgentMail refusal during setup into a step-named 4xx. */
export function agentmailStepError(
  step: AgentmailStep,
  error: unknown,
): HttpError | undefined {
  if (!(error instanceof AgentmailApiError)) return undefined;
  const definition = AGENTMAIL_STEPS[step];
  return providerStepError({
    provider: "AgentMail",
    step: definition.step,
    status: error.status,
    providerCode: error.providerCode,
    providerMessage: error.providerMessage,
    hint: (definition.hints as Partial<Record<number, string>>)[error.status],
    request: error.method && error.path ? `${error.method} ${error.path}` : undefined,
  });
}

/** Run one AgentMail setup step, mapping provider refusals to a clear 4xx. */
export function agentmailStep<T>(
  step: AgentmailStep,
  run: () => Promise<T>,
): Promise<T> {
  return providerStep("AgentMail", AGENTMAIL_STEPS[step].step, run, (error) =>
    agentmailStepError(step, error),
  );
}

/** REST is the email protocol boundary; credentials never enter an agent runtime. */
export function agentmailApi(apiKey: string, fetchImpl: typeof fetch = fetch) {
  async function request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const response = await fetchImpl(`https://api.agentmail.to/v0${path}`, {
      method,
      signal: AbortSignal.timeout(25_000),
      redirect: "error",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      const seconds = Number(retryAfter ?? 1);
      const delay = Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(retryAfter ?? "") - Date.now();
      throw new AgentmailApiError(
        response.status,
        Math.max(1000, Math.min(300_000, Number.isFinite(delay) ? delay : 1000)),
        {
          method,
          path: agentmailPathTemplate(path),
          ...(await agentmailErrorDetail(response, apiKey)),
        },
      );
    }
    if (response.status === 204) return undefined as T;
    if (!response.body) throw new Error("Empty AgentMail response");
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 16 * 1024 * 1024)
          throw new Error("AgentMail response exceeds the processing limit");
        parts.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8")) as T;
  }
  const inboxPath = (id: string) => `/inboxes/${encodeURIComponent(id)}`;
  return {
    request,
    whoami: () => request<AgentmailScope>("/auth/me"),
    getInbox: (id: string) => request<AgentmailInbox>(inboxPath(id)),
    listInboxes: () =>
      request<{ inboxes: AgentmailInbox[] }>("/inboxes?limit=100"),
    listDomains: () =>
      request<{ domains: { domain_id: string; domain: string }[] }>(
        "/domains?limit=100",
      ),
    getDomain: (id: string) =>
      request<{ domain_id: string; domain: string; status: string }>(
        `/domains/${encodeURIComponent(id)}`,
      ),
    createInbox: (body: unknown) =>
      request<AgentmailInbox>("/inboxes", "POST", body),
    createInboxKey: (id: string) =>
      request<{ api_key: string; api_key_id: string }>(
        `${inboxPath(id)}/api-keys`,
        "POST",
        { name: "GS Agentic Manager email runtime" },
      ),
    deleteInboxKey: (id: string, keyId: string) =>
      request<void>(
        `${inboxPath(id)}/api-keys/${encodeURIComponent(keyId)}`,
        "DELETE",
      ),
    createWebhook: (id: string, url: string, clientId: string) =>
      request<{ webhook_id: string; secret: string }>(
        `${inboxPath(id)}/webhooks`,
        "POST",
        { url, event_types: AGENTMAIL_EVENTS, client_id: clientId },
      ),
    deleteWebhook: (id: string, webhookId: string) =>
      request<void>(
        `${inboxPath(id)}/webhooks/${encodeURIComponent(webhookId)}`,
        "DELETE",
      ),
    getMessage: async (id: string, messageId: string) =>
      agentmailMessageSchema.parse(
        await request(
          `${inboxPath(id)}/messages/${encodeURIComponent(messageId)}`,
        ),
      ),
    getThread: async (id: string, threadId: string) =>
      z
        .object({ messages: z.array(agentmailMessageSchema) })
        .parse(
          await request(
            `${inboxPath(id)}/threads/${encodeURIComponent(threadId)}`,
          ),
        ),
    listMessages: (id: string, after?: string, page?: string) =>
      request<{
        messages: {
          message_id: string;
          created_at?: string;
          timestamp?: string;
        }[];
        next_page_token?: string;
      }>(
        `${inboxPath(id)}/messages?${new URLSearchParams({ ...(after ? { after } : {}), ascending: "true", limit: "100", ...(page ? { page_token: page } : {}) })}`,
      ),
    send: (id: string, body: unknown, key: string, replyId?: string) =>
      request<{ message_id: string; thread_id: string }>(
        `${inboxPath(id)}/messages/${replyId ? `${encodeURIComponent(replyId)}/reply` : "send"}`,
        "POST",
        body,
        key,
      ),
    getAttachment: (id: string, messageId: string, attachmentId: string) =>
      request<{ download_url: string; size: number }>(
        `${inboxPath(id)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      ),
  };
}
