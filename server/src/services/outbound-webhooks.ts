// Outbound webhooks. A person pastes a URL in Settings > Integrations and picks
// events; when one happens GSAM posts a JSON payload there. The payload carries
// a top-level `text` line so Slack and Teams incoming webhooks show it as a
// message, and the full details for Zapier, Make or custom code. Nothing is
// sent until a person adds a URL, and only to public https addresses.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { approvals, companies, issues, organisations, outboundWebhookDeliveries, outboundWebhooks } from "@greatstone/db";
import {
  OUTBOUND_WEBHOOK_EVENTS,
  type CreateOutboundWebhook,
  type OutboundWebhookDelivery,
  type OutboundWebhookEvent,
  type OutboundWebhookSummary,
  type OutboundWebhookWithSecret,
  type UpdateOutboundWebhook,
} from "@greatstone/shared";
import { notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { ActivityPublication } from "./activity-log.js";

/** Deliveries kept per webhook; older ones are pruned. */
const DELIVERY_LOG_LIMIT = 50;
const SEND_TIMEOUT_MS = 10_000;
const MAX_ERROR_LENGTH = 300;

type WebhookRow = typeof outboundWebhooks.$inferSelect;

export interface OutboundSendResult {
  ok: boolean;
  httpStatus: number | null;
  error: string | null;
}

export type OutboundSender = (url: string, body: string, headers: Record<string, string>) => Promise<OutboundSendResult>;

export interface OutboundWebhookDeps {
  /** Replaces the network call, for tests. */
  send?: OutboundSender;
  /** Instance address, such as `https://gsam.example.com`, used to add links to payloads. */
  publicBaseUrl?: string | null;
  now?: () => Date;
}

/** The payload posted to a webhook. */
export interface OutboundPayload {
  event: OutboundWebhookEvent | "test";
  deliveryId: string;
  occurredAt: string;
  company: { id: string; name: string };
  /** One line, ready to show in Slack, Teams or a notification. */
  text: string;
  link: string | null;
  data: Record<string, unknown>;
}

/** Hides the part of a webhook address that works as a password. */
export function maskWebhookUrl(url: string) {
  try {
    const parsed = new URL(url);
    const tail = `${parsed.pathname}${parsed.search}`.replace(/\/$/, "");
    const last = tail.slice(-4);
    return `${parsed.protocol}//${parsed.host}/…${last}`;
  } catch {
    return "…";
  }
}

/** True for loopback, private, link-local and other addresses a webhook must never reach. */
export function isBlockedAddress(ip: string): boolean {
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped?.[1]) return isBlockedAddress(mapped[1]);
  if (isIP(lower) === 4) {
    const [a, b] = lower.split(".").map((part) => Number(part));
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b! >= 16 && b! <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b! >= 64 && b! <= 127) return true;
    if (a! >= 224) return true;
    return false;
  }
  if (lower === "::" || lower === "::1") return true;
  return lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

/** DNS lookup that refuses private addresses, used at connect time so a rebinding name cannot slip through. */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true })
    .then((results) => {
      const safe = results.filter((entry) => !isBlockedAddress(entry.address));
      if (safe.length === 0) {
        callback(Object.assign(new Error(`${hostname} is a private or local address`), { code: "EBLOCKED" }), "", 4);
        return;
      }
      if ((options as { all?: boolean }).all) {
        (callback as unknown as (err: null, addresses: typeof safe) => void)(null, safe);
        return;
      }
      callback(null, safe[0]!.address, safe[0]!.family);
    })
    .catch((err: NodeJS.ErrnoException) => callback(err, "", 4));
};

/** Posts to a public https address with a timeout. Never throws. */
export const sendOverHttps: OutboundSender = (url, body, headers) =>
  new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ ok: false, httpStatus: null, error: "The address is not a valid URL" });
      return;
    }
    if (parsed.protocol !== "https:") {
      resolve({ ok: false, httpStatus: null, error: "The address must start with https://" });
      return;
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    if (isIP(hostname) && isBlockedAddress(hostname)) {
      resolve({ ok: false, httpStatus: null, error: "Private and local addresses are not allowed" });
      return;
    }
    const req = httpsRequest(
      parsed,
      {
        method: "POST",
        headers: { ...headers, "content-length": Buffer.byteLength(body).toString() },
        lookup: publicOnlyLookup,
        timeout: SEND_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.resume();
        res.on("end", () =>
          resolve({
            ok: status >= 200 && status < 300,
            httpStatus: status,
            error: status >= 200 && status < 300 ? null : `The address answered ${status}`,
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error(`No answer within ${SEND_TIMEOUT_MS / 1000} seconds`)));
    req.on("error", (err) => resolve({ ok: false, httpStatus: null, error: err.message.slice(0, MAX_ERROR_LENGTH) }));
    req.end(body);
  });

function summary(row: WebhookRow): OutboundWebhookSummary {
  return {
    id: row.id,
    name: row.name,
    maskedUrl: maskWebhookUrl(row.url),
    events: row.events.filter((event): event is OutboundWebhookEvent =>
      (OUTBOUND_WEBHOOK_EVENTS as readonly string[]).includes(event),
    ),
    enabled: !row.disabledAt,
    lastDeliveryAt: row.lastDeliveryAt?.toISOString() ?? null,
    lastDeliveryOk: row.lastDeliveryOk,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  };
}

export function signPayload(secret: string, timestamp: string, body: string) {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

function str(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The webhook event an activity stands for, or null when it is not one people can subscribe to. */
export function outboundEventForActivity(payload: Record<string, unknown>): OutboundWebhookEvent | null {
  const action = str(payload.action);
  const details = record(payload.details);
  switch (action) {
    case "issue.created":
      return "task.created";
    case "issue.updated": {
      const status = str(details.status);
      const previous = str(record(details._previous).status);
      if (!status || status === previous) return null;
      if (status === "done") return "task.done";
      if (status === "blocked") return "task.blocked";
      return null;
    }
    case "approval.created":
      return "decision.needed";
    case "issue.thread_interaction_created":
      // Questions an agent asks another agent are not decisions for a person.
      return details.addresseeAgentId ? null : "decision.needed";
    case "organisation.updated":
      return str(details.status) && details.status !== details.previousStatus ? "client.stage_changed" : null;
    default:
      return null;
  }
}

export function outboundWebhookService(db: Db, deps: OutboundWebhookDeps = {}) {
  const send = deps.send ?? sendOverHttps;
  const now = deps.now ?? (() => new Date());
  const origin = deps.publicBaseUrl?.trim().replace(/\/+$/, "") || null;

  async function getRow(companyId: string, webhookId: string) {
    const row = await db
      .select()
      .from(outboundWebhooks)
      .where(and(eq(outboundWebhooks.id, webhookId), eq(outboundWebhooks.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Webhook not found");
    return row;
  }

  async function company(companyId: string) {
    return db
      .select({ id: companies.id, name: companies.name, prefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
  }

  /** Builds the text, link and data for an event, or null when the thing it is about has gone. */
  async function describe(
    companyId: string,
    prefix: string,
    event: OutboundWebhookEvent,
    payload: Record<string, unknown>,
  ): Promise<Pick<OutboundPayload, "text" | "link" | "data"> | null> {
    const details = record(payload.details);
    const entityId = str(payload.entityId);
    if (!entityId) return null;

    if (event === "client.stage_changed") {
      const org = await db
        .select({ id: organisations.id, name: organisations.name, status: organisations.status })
        .from(organisations)
        .where(and(eq(organisations.companyId, companyId), eq(organisations.id, entityId)))
        .then((rows) => rows[0] ?? null);
      if (!org) return null;
      const previous = str(details.previousStatus);
      return {
        text: `${org.name} moved ${previous ? `from ${previous} ` : ""}to ${org.status}`,
        link: origin ? `${origin}/${prefix}/organisations/${org.id}` : null,
        data: { client: { id: org.id, name: org.name, stage: org.status, previousStage: previous } },
      };
    }

    if (payload.entityType === "approval") {
      const approval = await db
        .select({ id: approvals.id, type: approvals.type, status: approvals.status })
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.id, entityId)))
        .then((rows) => rows[0] ?? null);
      if (!approval) return null;
      const kind = approval.type.replaceAll("_", " ");
      return {
        text: `Decision needed: approve ${kind}`,
        link: origin ? `${origin}/${prefix}/approvals/${approval.id}` : null,
        data: { decision: { kind: "approval", id: approval.id, type: approval.type, status: approval.status } },
      };
    }

    const issue = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        dueDate: issues.dueDate,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, entityId)))
      .then((rows) => rows[0] ?? null);
    if (!issue) return null;
    const name = issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title;
    const link = origin ? `${origin}/${prefix}/issues/${issue.identifier ?? issue.id}` : null;
    const task = {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
      dueDate: issue.dueDate,
      assigneeAgentId: issue.assigneeAgentId,
    };
    if (event === "decision.needed") {
      return {
        text: `Decision needed on ${name}`,
        link,
        data: { decision: { kind: str(details.interactionKind) ?? "question", id: str(details.interactionId) }, task },
      };
    }
    const verb = event === "task.created" ? "New task" : event === "task.done" ? "Done" : "Blocked";
    return { text: `${verb}: ${name}`, link, data: { task } };
  }

  async function deliver(
    row: WebhookRow,
    payload: OutboundPayload,
    summaryLine: string,
  ): Promise<OutboundWebhookDelivery> {
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(now().getTime() / 1000).toString();
    const started = Date.now();
    const result = await send(row.url, body, {
      "content-type": "application/json",
      "user-agent": "GSAM-Webhooks/1",
      "x-gsam-event": payload.event,
      "x-gsam-delivery": payload.deliveryId,
      "x-gsam-timestamp": timestamp,
      "x-gsam-signature": signPayload(row.signingSecret, timestamp, body),
    }).catch((err: Error) => ({ ok: false, httpStatus: null, error: err.message } satisfies OutboundSendResult));
    const durationMs = Date.now() - started;
    const error = result.error?.slice(0, MAX_ERROR_LENGTH) ?? null;
    const at = now();
    const [delivery] = await db
      .insert(outboundWebhookDeliveries)
      .values({
        id: payload.deliveryId,
        companyId: row.companyId,
        webhookId: row.id,
        event: payload.event,
        summary: summaryLine.slice(0, 300),
        ok: result.ok,
        httpStatus: result.httpStatus,
        error,
        durationMs,
        createdAt: at,
      })
      .returning();
    await db
      .update(outboundWebhooks)
      .set({ lastDeliveryAt: at, lastDeliveryOk: result.ok, lastError: result.ok ? null : error, updatedAt: at })
      .where(eq(outboundWebhooks.id, row.id));
    await prune(row.id);
    return toDelivery(delivery!);
  }

  async function prune(webhookId: string) {
    const cutoff = await db
      .select({ createdAt: outboundWebhookDeliveries.createdAt })
      .from(outboundWebhookDeliveries)
      .where(eq(outboundWebhookDeliveries.webhookId, webhookId))
      .orderBy(desc(outboundWebhookDeliveries.createdAt))
      .offset(DELIVERY_LOG_LIMIT - 1)
      .limit(1)
      .then((rows) => rows[0]?.createdAt ?? null);
    if (!cutoff) return;
    await db
      .delete(outboundWebhookDeliveries)
      .where(and(eq(outboundWebhookDeliveries.webhookId, webhookId), lt(outboundWebhookDeliveries.createdAt, cutoff)));
  }

  function toDelivery(row: typeof outboundWebhookDeliveries.$inferSelect): OutboundWebhookDelivery {
    return {
      id: row.id,
      event: row.event as OutboundWebhookDelivery["event"],
      summary: row.summary,
      ok: row.ok,
      httpStatus: row.httpStatus,
      error: row.error,
      durationMs: row.durationMs,
      createdAt: row.createdAt.toISOString(),
    };
  }

  return {
    async list(companyId: string): Promise<OutboundWebhookSummary[]> {
      const rows = await db
        .select()
        .from(outboundWebhooks)
        .where(eq(outboundWebhooks.companyId, companyId))
        .orderBy(outboundWebhooks.createdAt);
      return rows.map(summary);
    },

    async create(companyId: string, input: CreateOutboundWebhook, userId: string | null): Promise<OutboundWebhookWithSecret> {
      const signingSecret = `gsam_whsec_${randomBytes(24).toString("hex")}`;
      const [row] = await db
        .insert(outboundWebhooks)
        .values({
          companyId,
          name: input.name,
          url: input.url,
          events: [...new Set(input.events)],
          signingSecret,
          createdByUserId: userId,
        })
        .returning();
      return { ...summary(row!), signingSecret };
    },

    async update(companyId: string, webhookId: string, input: UpdateOutboundWebhook): Promise<OutboundWebhookSummary> {
      await getRow(companyId, webhookId);
      const [row] = await db
        .update(outboundWebhooks)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.url !== undefined ? { url: input.url, lastError: null, lastDeliveryOk: null } : {}),
          ...(input.events !== undefined ? { events: [...new Set(input.events)] } : {}),
          ...(input.enabled !== undefined ? { disabledAt: input.enabled ? null : now() } : {}),
          updatedAt: now(),
        })
        .where(and(eq(outboundWebhooks.id, webhookId), eq(outboundWebhooks.companyId, companyId)))
        .returning();
      return summary(row!);
    },

    async remove(companyId: string, webhookId: string) {
      const row = await getRow(companyId, webhookId);
      await db.delete(outboundWebhooks).where(eq(outboundWebhooks.id, row.id));
      return summary(row);
    },

    async deliveries(companyId: string, webhookId: string): Promise<OutboundWebhookDelivery[]> {
      await getRow(companyId, webhookId);
      const rows = await db
        .select()
        .from(outboundWebhookDeliveries)
        .where(eq(outboundWebhookDeliveries.webhookId, webhookId))
        .orderBy(desc(outboundWebhookDeliveries.createdAt))
        .limit(DELIVERY_LOG_LIMIT);
      return rows.map(toDelivery);
    },

    /** Sends a sample payload now, even when the webhook is turned off, so people can check the address. */
    async sendTest(companyId: string, webhookId: string): Promise<OutboundWebhookDelivery> {
      const row = await getRow(companyId, webhookId);
      const owner = await company(companyId);
      const text = `Test from GSAM: ${row.name} is connected`;
      return deliver(
        row,
        {
          event: "test",
          deliveryId: randomUUID(),
          occurredAt: now().toISOString(),
          company: { id: companyId, name: owner?.name ?? "" },
          text,
          link: origin && owner ? `${origin}/${owner.prefix}/company/settings/integrations` : null,
          data: { webhook: { id: row.id, name: row.name, events: row.events } },
        },
        text,
      );
    },

    /** Sends an activity to every turned-on webhook that wants its event. Never throws. */
    async handleActivity(publication: ActivityPublication) {
      const event = outboundEventForActivity(publication.payload);
      if (!event) return [];
      const hooks = await db
        .select()
        .from(outboundWebhooks)
        .where(and(eq(outboundWebhooks.companyId, publication.companyId), isNull(outboundWebhooks.disabledAt)));
      const wanted = hooks.filter((hook) => hook.events.includes(event));
      if (wanted.length === 0) return [];
      const owner = await company(publication.companyId);
      if (!owner) return [];
      const described = await describe(publication.companyId, owner.prefix, event, publication.payload);
      if (!described) return [];
      const occurredAt = now().toISOString();
      return Promise.all(
        wanted.map((hook) =>
          deliver(
            hook,
            {
              event,
              deliveryId: randomUUID(),
              occurredAt,
              company: { id: owner.id, name: owner.name },
              ...described,
            },
            described.text,
          ),
        ),
      );
    },

  };
}

let stopDispatch: (() => void) | null = null;

/** Wires outbound webhooks to the activity log, replacing any earlier wiring. Returns an unsubscribe. */
export function startOutboundWebhookDispatch(
  db: Db,
  addListener: (listener: (publication: ActivityPublication) => void) => () => void,
  deps: OutboundWebhookDeps = {},
) {
  stopDispatch?.();
  const service = outboundWebhookService(db, deps);
  stopDispatch = addListener((publication) => {
    if (!outboundEventForActivity(publication.payload)) return;
    void service.handleActivity(publication).catch((err) => {
      logger.warn({ err, companyId: publication.companyId }, "outbound webhook dispatch failed");
    });
  });
  return stopDispatch;
}

