import { z } from "zod";

/**
 * Live design on an agent's HTML prototype (John, 2 Nov): pick any element,
 * ask for a change, flick through the agent's versions in place and keep one.
 * GSAM relays everything, so it works from any device that can reach GSAM.
 */

export const LIVE_DESIGN_VARIANT_COUNT = 3;

export const liveDesignRequestSchema = z.object({
  selector: z.string().min(1).max(500),
  tag: z.string().max(40),
  label: z.string().max(200),
  text: z.string().max(300),
  html: z.string().max(20_000),
  prompt: z.string().trim().min(1).max(2000),
});
export type LiveDesignRequest = z.infer<typeof liveDesignRequestSchema>;

export const liveDesignVariantSchema = z.object({
  /** One element that replaces the picked element. */
  html: z.string().min(1).max(40_000),
  /** CSS for this version only; shown alone, so it never clashes with the others. */
  css: z.string().max(20_000).default(""),
  /** A few words John reads in the switcher, such as "Soft halo". */
  name: z.string().max(60).default(""),
});
export type LiveDesignVariant = z.infer<typeof liveDesignVariantSchema>;

export const liveDesignReplySchema = z.object({
  requestId: z.string().min(1).max(64),
  variants: z.array(liveDesignVariantSchema).min(1).max(4).optional(),
  /** After an accept: the new attachment that holds the updated page. */
  appliedAttachmentId: z.string().uuid().optional(),
  error: z.string().max(500).optional(),
  /** A short note for John's chat, such as "Trying a halo, a slow pulse and a bloom". Can be sent on its own. */
  message: z.string().max(1000).optional(),
});
export type LiveDesignReply = z.infer<typeof liveDesignReplySchema>;

export const liveDesignAcceptSchema = z.object({
  requestId: z.string().min(1).max(64),
  variant: z.number().int().min(0).max(3),
});

export type LiveDesignStatus = "waiting_agent" | "idle" | "generating" | "ready" | "applying" | "ended";

export interface LiveDesignMessage {
  from: "john" | "agent" | "gsam";
  text: string;
  at: string;
}

export interface LiveDesignView {
  id: string;
  issueId: string;
  attachmentId: string;
  status: LiveDesignStatus;
  agentConnected: boolean;
  request: (LiveDesignRequest & { id: string; startedAt: string }) | null;
  variants: LiveDesignVariant[];
  /** Set when the agent saved an accepted version as a new attachment. */
  appliedAttachmentId: string | null;
  error: string | null;
  /** The editor's chat: John's requests, the agent's notes and GSAM's status lines. */
  messages: LiveDesignMessage[];
}
