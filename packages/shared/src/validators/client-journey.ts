import { z } from "zod";

/** POST /api/cases/:caseId/journey/deliverables — file a deliverable under a stage. */
export const createClientJourneyDeliverableSchema = z.object({
  stageId: z.string().guid(),
  deliverableId: z.string().guid(),
  clientFacing: z.boolean().optional().default(false),
});

/** PATCH /api/cases/:caseId/journey/deliverables/:linkId — move it to another stage or change who sees it. */
export const updateClientJourneyDeliverableSchema = z
  .object({
    stageId: z.string().guid().optional(),
    clientFacing: z.boolean().optional(),
  })
  .refine((value) => value.stageId !== undefined || value.clientFacing !== undefined, "Give stageId or clientFacing");

export type CreateClientJourneyDeliverable = z.infer<typeof createClientJourneyDeliverableSchema>;
export type CreateClientJourneyDeliverableInput = z.input<typeof createClientJourneyDeliverableSchema>;
export type UpdateClientJourneyDeliverable = z.infer<typeof updateClientJourneyDeliverableSchema>;

/**
 * The client's NDA (Ben and John, 13 Oct). Every engagement needs a mutual NDA
 * (governing law England and Wales). `required` is the default and holds
 * client-labelled items off the portal; `accepted` records the signed NDA;
 * `suspended` lets an engagement that was already under way proceed without
 * waiving the NDA, and always carries the reason.
 */
export const ndaStatusSchema = z.enum(["required", "accepted", "suspended"]);
export const NDA_SUSPENDED_REASON_MAX = 500;

/**
 * PUT /api/cases/:caseId/nda (board only). `{ status, reason }` sets the
 * three-way status; the older `{ accepted }` body still works and maps to
 * accepted or required.
 */
export const setCaseNdaSchema = z.union([
  z.object({ accepted: z.boolean() }).strict(),
  z.object({
    status: ndaStatusSchema,
    reason: z.string().trim().max(NDA_SUSPENDED_REASON_MAX).optional().nullable(),
  }).strict().superRefine((value, ctx) => {
    if (value.status === "suspended" && !value.reason) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "A suspended NDA needs a reason" });
    }
  }),
]);

export type NdaStatus = z.infer<typeof ndaStatusSchema>;
export type SetCaseNda = z.infer<typeof setCaseNdaSchema>;

/** The status a set-NDA body asks for, and the reason (kept only for a suspension). */
export function resolveSetCaseNda(body: SetCaseNda): { status: NdaStatus; reason: string | null } {
  if ("accepted" in body) return { status: body.accepted ? "accepted" : "required", reason: null };
  return { status: body.status, reason: body.status === "suspended" ? body.reason ?? null : null };
}

/** Accepted and suspended both let the engagement proceed; required holds it. */
export function ndaClears(status: NdaStatus): boolean {
  return status !== "required";
}

/**
 * The engagement pack (Ben, 8 and 12 Oct): it goes out once the NDA is
 * accepted or suspended, then the client accepts it. not_sent is the default.
 */
export const engagementStatusSchema = z.enum(["not_sent", "sent", "accepted"]);

/** PUT /api/cases/:caseId/engagement (board only). */
export const setCaseEngagementSchema = z.object({ status: engagementStatusSchema }).strict();

export type EngagementStatus = z.infer<typeof engagementStatusSchema>;
export type SetCaseEngagement = z.infer<typeof setCaseEngagementSchema>;
