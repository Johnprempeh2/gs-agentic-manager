import { chatConversations, chatEndpoints } from "@greatstone/db";
import { sql } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { Message, parseMarkdown, stringifyMarkdown, type Adapter, type ChatInstance, type WebhookOptions } from "chat";
import { z } from "zod";

const phone = z.string().regex(/^[1-9]\d{7,14}$/);
const messageId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const httpsTailnet = z.url().transform((value) => new URL(value)).refine((url) =>
  url.protocol === "https:" && /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(url.hostname)
  && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash,
);
const configSchema = z.object({
  companyId: z.uuid(),
  agentId: z.uuid(),
  ownerUserId: z.string().min(1).max(128),
  sender: phone,
  bot: phone,
  ingressOrigin: httpsTailnet,
  relayOrigin: httpsTailnet,
  ingressKey: z.string().regex(/^[a-f0-9]{64}$/),
  replyKey: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine((config) =>
  config.sender !== config.bot && config.ingressKey !== config.replyKey &&
  config.ingressOrigin.hostname.split(".").slice(1).join(".") === config.relayOrigin.hostname.split(".").slice(1).join("."),
);

export type WhatsAppWebConfig = z.infer<typeof configSchema>;

export function whatsappWebConfig(): WhatsAppWebConfig | null {
  const path = process.env.GSAM_WHATSAPP_WEB_CONFIG_FILE;
  if (!path) return null;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.() || info.size > 4096) return null;
    const config = configSchema.safeParse(JSON.parse(readFileSync(fd, "utf8")));
    return config.success ? config.data : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function whatsappWebIssueBinding(companyId: string, issueId: string) {
  return sql<boolean>`exists (
    select 1 from ${chatConversations} as conversation
    join ${chatEndpoints} as endpoint on endpoint.id = conversation.endpoint_id
      and endpoint.company_id = conversation.company_id
    where conversation.company_id = ${companyId}
      and conversation.issue_id = ${issueId}
      and endpoint.provider = 'whatsapp-web'
  )`;
}

export function isWhatsAppWebRunner(adapterType: string | null, adapterConfig: unknown) {
  if (adapterType !== "paperclip_runner" || !adapterConfig || typeof adapterConfig !== "object") return false;
  const config = adapterConfig as Record<string, unknown>;
  return config.provider === "acpx";
}

const inboundSchema = z.object({
  id: messageId,
  sender: phone,
  bot: phone,
  kind: z.literal("direct"),
  text: z.string().trim().min(1).max(4000),
}).strict();
type Inbound = z.infer<typeof inboundSchema>;

function authenticates(header: string | null, key: string) {
  const expected = `Bearer ${key}`;
  if (!header || header.length !== expected.length) return false;
  const provided = Buffer.from(header);
  const correct = Buffer.from(expected);
  return provided.length === correct.length && timingSafeEqual(provided, correct);
}

export function authorizedWhatsAppWebIngress(request: Request, config = whatsappWebConfig()) {
  return config !== null && new URL(request.url).origin === config.ingressOrigin.origin &&
    authenticates(request.headers.get("authorization"), config.ingressKey);
}

export class WhatsAppWebDeliveryError extends Error {
  constructor(readonly retryable: boolean, message: string) { super(message); }
}

export class WhatsAppWebChatAdapter implements Adapter<string, Inbound> {
  readonly name = "whatsapp-web";
  readonly userName: string;
  private chat?: ChatInstance;

  constructor(
    readonly config: WhatsAppWebConfig,
    userName: string,
    private readonly send: typeof fetch = fetch,
  ) {
    this.userName = userName;
  }

  get botUserId() { return this.config.bot; }
  get threadId() { return `whatsapp-web:${this.config.sender}`; }
  isDM(threadId: string) { return threadId === this.threadId; }

  encodeThreadId(sender: string) {
    if (sender !== this.config.sender) throw new Error("WhatsApp sender is outside this connection");
    return this.threadId;
  }

  decodeThreadId(threadId: string) {
    if (!this.isDM(threadId)) throw new Error("WhatsApp destination is outside this connection");
    return this.config.sender;
  }

  channelIdFromThreadId(threadId: string) {
    return this.encodeThreadId(this.decodeThreadId(threadId));
  }

  async initialize(chat: ChatInstance) { this.chat = chat; }

  parseMessage(raw: Inbound) {
    return new Message({
      id: raw.id,
      threadId: this.encodeThreadId(raw.sender),
      text: raw.text,
      formatted: parseMarkdown(raw.text),
      raw,
      attachments: [],
      author: { userId: raw.sender, userName: "Owner", fullName: "WhatsApp owner", isMe: false, isBot: false },
      metadata: { dateSent: new Date(), edited: false },
    });
  }

  async handleWebhook(request: Request, options?: WebhookOptions) {
    if (!authorizedWhatsAppWebIngress(request, this.config))
      return new Response(null, { status: 401 });

    const body = await request.text();
    if (Buffer.byteLength(body) > 24_000) return new Response(null, { status: 413 });
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response(null, { status: 400 });
    }
    const envelope = inboundSchema.safeParse(payload);
    if (!envelope.success) return new Response(null, { status: 400 });
    if (envelope.data.sender !== this.config.sender || envelope.data.bot !== this.config.bot)
      return new Response(null, { status: 403 });
    if (!this.chat) return new Response(null, { status: 503 });

    await this.chat.processMessage(this, this.threadId, this.parseMessage(envelope.data), options);
    return new Response(null, { status: 204 });
  }

  async postPublication(threadId: string, id: string, text: string) {
    const sender = this.decodeThreadId(threadId);
    const boundedText = text.length <= 3900
      ? text
      : `${Array.from(text).slice(0, 1900).join("")}\n\nReply shortened. Full text is in GSAM.`;
    const response = await this.send(new URL("/v1/whatsapp-web/replies", this.config.relayOrigin), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.replyKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id, sender, bot: this.config.bot, text: boundedText }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    }).catch(() => { throw new WhatsAppWebDeliveryError(true, "WhatsApp relay response was unavailable"); });
    if (!response.ok) throw new WhatsAppWebDeliveryError(
      response.status >= 500 || response.status === 429,
      `WhatsApp relay rejected delivery (HTTP ${response.status})`,
    );
    const result = z.object({ messageId }).safeParse(await response.json().catch(() => null));
    if (!result.success) throw new WhatsAppWebDeliveryError(true, "WhatsApp relay returned no delivery receipt");
    return { id: result.data.messageId };
  }

  async postMessage(): Promise<never> { throw new Error("WhatsApp replies require a durable GSAM publication"); }
  async editMessage(): Promise<never> { throw new Error("WhatsApp edits are disabled"); }
  async deleteMessage(): Promise<never> { throw new Error("WhatsApp deletes are disabled"); }
  async fetchMessages() { return { messages: [] }; }
  async fetchThread(threadId: string) {
    return { id: threadId, channelId: this.channelIdFromThreadId(threadId), channelVisibility: "private" as const, isDM: true, metadata: {} };
  }
  async addReaction() {}
  async removeReaction() {}
  async startTyping() {}
  renderFormatted = stringifyMarkdown;
}
