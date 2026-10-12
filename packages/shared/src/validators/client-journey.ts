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
