import { z } from "zod";

/** Events an outbound webhook can receive. */
export const OUTBOUND_WEBHOOK_EVENTS = [
  "task.created",
  "task.done",
  "task.blocked",
  "decision.needed",
  "client.stage_changed",
] as const;
export type OutboundWebhookEvent = (typeof OUTBOUND_WEBHOOK_EVENTS)[number];

export const OUTBOUND_WEBHOOK_EVENT_LABELS: Record<OutboundWebhookEvent, string> = {
  "task.created": "A task is created",
  "task.done": "A task is done",
  "task.blocked": "A task is blocked",
  "decision.needed": "A decision is needed from you",
  "client.stage_changed": "A client moves stage",
};

const webhookUrl = z
  .string()
  .trim()
  .url("Paste the full address, starting with https://")
  .max(2000)
  .refine((value) => value.startsWith("https://"), "The address must start with https://");

export const createOutboundWebhookSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    url: webhookUrl,
    events: z.array(z.enum(OUTBOUND_WEBHOOK_EVENTS)).min(1, "Pick at least one event"),
  })
  .strict();
export type CreateOutboundWebhook = z.infer<typeof createOutboundWebhookSchema>;

export const updateOutboundWebhookSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    url: webhookUrl.optional(),
    events: z.array(z.enum(OUTBOUND_WEBHOOK_EVENTS)).min(1, "Pick at least one event").optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type UpdateOutboundWebhook = z.infer<typeof updateOutboundWebhookSchema>;

export interface OutboundWebhookSummary {
  id: string;
  name: string;
  /** The address with its secret part hidden, such as `https://hooks.slack.com/…a1b2`. */
  maskedUrl: string;
  events: OutboundWebhookEvent[];
  enabled: boolean;
  lastDeliveryAt: string | null;
  lastDeliveryOk: boolean | null;
  lastError: string | null;
  createdAt: string;
}

/** Returned once, when a webhook is made: includes the signing secret for the `X-GSAM-Signature` header. */
export interface OutboundWebhookWithSecret extends OutboundWebhookSummary {
  signingSecret: string;
}

export interface OutboundWebhookDelivery {
  id: string;
  event: OutboundWebhookEvent | "test";
  summary: string;
  ok: boolean;
  httpStatus: number | null;
  error: string | null;
  durationMs: number;
  createdAt: string;
}
