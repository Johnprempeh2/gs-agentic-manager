import { z } from "zod";

/** Shared with the website outbox. A sequence is scoped to one website site. */
export const websiteActivityKinds = [
  "account.created", "interview.invited", "interview.started", "interview.completed", "interview.abandoned",
  "document.requested", "document.uploaded", "deliverable.published", "deliverable.accepted",
  "quote.made", "order.made", "invoice.issued", "invoice.paid", "enquiry.received", "deep_dive.shared_item_viewed",
] as const;

export const websiteActivityEventSchema = z.object({
  sequence: z.string().regex(/^[1-9]\d*$/),
  id: z.string().uuid(),
  organisationId: z.string().uuid(),
  kind: z.enum(websiteActivityKinds),
  subjectId: z.string().min(1).max(120).regex(/^[A-Za-z0-9_:-]+$/),
  label: z.string().min(1).max(120).regex(/^[^\r\n\t<>]*$/),
  occurredAt: z.string().datetime({ offset: true }),
}).strict();

export const websiteActivityBatchSchema = z.object({
  items: z.array(websiteActivityEventSchema).max(100),
  /** The last returned sequence, or the supplied cursor for an empty page. */
  nextCursor: z.string().regex(/^(0|[1-9]\d*)$/),
}).strict();

export type WebsiteActivityEvent = z.infer<typeof websiteActivityEventSchema>;
export type WebsiteActivityBatch = z.infer<typeof websiteActivityBatchSchema>;

/** GSAM's stored projection as returned to the client hub and agent API. */
export type WebsiteActivityItem = WebsiteActivityEvent & {
  companyId: string;
  siteId: string;
  ingestedAt: string;
};
