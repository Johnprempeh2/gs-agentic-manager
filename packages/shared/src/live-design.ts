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
  /** Impeccable's action for this request ("impeccable" is freeform; others name a design command such as "bolder"). */
  action: z.string().max(40).default("impeccable"),
  count: z.number().int().min(1).max(8).default(3),
  /** Comments John pinned on the page before pressing Go (Impeccable's annotations). */
  notes: z.array(z.string().max(1000)).max(30).default([]),
  /** The marked-up screenshot, saved as an image attachment on the task, when John drew or commented. */
  screenshotAttachmentId: z.string().uuid().optional(),
  /** Impeccable's Insert: a new element goes before or after the element at `selector`, nothing is replaced. */
  insert: z.object({ position: z.enum(["before", "after"]) }).optional(),
});
export type LiveDesignRequest = z.infer<typeof liveDesignRequestSchema>;

export const liveDesignVariantSchema = z.object({
  /** One element that replaces the picked element. */
  html: z.string().min(1).max(40_000),
  /** CSS for this version only; shown alone, so it never clashes with the others. */
  css: z.string().max(20_000).default(""),
  /** A few words John reads in the switcher, such as "Soft halo". */
  name: z.string().max(60).default(""),
  /** Impeccable tune knobs for this version (live.md section 7): [{ id, kind: "range" | "steps" | "toggle", ... }]. */
  params: z.array(z.record(z.string(), z.unknown())).max(6).optional(),
});
export type LiveDesignVariant = z.infer<typeof liveDesignVariantSchema>;

export const liveDesignReplySchema = z.object({
  requestId: z.string().min(1).max(64),
  variants: z.array(liveDesignVariantSchema).min(1).max(4).optional(),
  /** After an accept: the new attachment that holds the updated page. */
  appliedAttachmentId: z.string().uuid().optional(),
  /** After an accept or applied edits: the complete updated page. GSAM saves it on the task, so the agent uploads nothing. */
  pageHtml: z.string().min(1).max(8_000_000).optional(),
  error: z.string().max(500).optional(),
  /** A short note for John's chat, such as "Trying a halo, a slow pulse and a bloom". Can be sent on its own. */
  message: z.string().max(1000).optional(),
  /** The project's DESIGN.md, for Impeccable's design panel. Sent once per session. */
  designMd: z.string().max(100_000).optional(),
});
export type LiveDesignReply = z.infer<typeof liveDesignReplySchema>;

/** One call from Impeccable's page scripts to their helper, relayed by the editor. */
export const liveDesignHelperRequestSchema = z.object({
  method: z.enum(["GET", "POST"]),
  path: z.string().startsWith("/").max(2000),
  body: z.string().max(200_000).nullable(),
  /** A binary body (the annotation screenshot), base64. */
  bodyBase64: z.string().max(9_800_000).optional(),
  extra: z.object({ selector: z.string().max(500).optional(), position: z.enum(["before", "after"]).optional() }).default({}),
});
export type LiveDesignHelperRequest = z.infer<typeof liveDesignHelperRequestSchema>;

export const liveDesignSteerSchema = z.object({ message: z.string().trim().min(1).max(2000) });

/** Start live design; with a deliverable, every saved change becomes its next version. */
export const liveDesignStartSchema = z.object({ deliverableId: z.string().uuid().optional() });

/** Bring back an earlier version: it becomes the newest version, so nothing is lost. */
export const liveDesignRestoreSchema = z.object({ attachmentId: z.string().uuid() });

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
  /** The deliverable this page is, when live design was opened from one; its latest version id. */
  deliverableId: string | null;
  /** The editor frame's address for the current version (Impeccable's tools inside). */
  frameSrc: string | null;
  /** A task file or a website page. */
  sourceKind: "attachment" | "website-page";
}

/**
 * A website page edited with live design (plan revision 8 on GRE-1831): the page
 * is one HTML document, stored as the page's revision content instead of Puck blocks.
 */
export const WEBSITE_HTML_PAGE_FORMAT = "gs-html";
export const websiteHtmlPageContentSchema = z.object({
  format: z.literal(WEBSITE_HTML_PAGE_FORMAT),
  html: z.string().min(1),
});
export type WebsiteHtmlPageContent = z.infer<typeof websiteHtmlPageContentSchema>;

export function isWebsiteHtmlPage(content: unknown): content is WebsiteHtmlPageContent {
  return websiteHtmlPageContentSchema.safeParse(content).success;
}
