import { z } from "zod";
import { ISSUE_EXECUTION_STAGE_TYPES } from "../constants.js";
import { issueDocumentKeySchema, issueExecutionStagePrincipalSchema } from "./issue.js";

/** Step, review and template keys: short lowercase slugs, stable across edits. */
const workflowTemplateKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use lowercase letters, numbers, - and _");

export const workflowTemplateDocumentSlotSchema = z.object({
  key: issueDocumentKeySchema,
  title: z.string().trim().min(1).max(200),
});

export const workflowTemplateStepSchema = z.object({
  key: workflowTemplateKeySchema,
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).optional().nullable(),
  assigneeAgentId: z.string().guid().optional().nullable(),
  /** Empty issue documents created on the step issue. */
  documents: z.array(workflowTemplateDocumentSlotSchema).max(20).default([]),
  /** Keys of earlier steps that must be done first. */
  blockedBy: z.array(workflowTemplateKeySchema).max(30).default([]),
});

export const workflowTemplateReviewSchema = z.object({
  key: workflowTemplateKeySchema,
  label: z.string().trim().min(1).max(120),
  /** The step whose completion this review gates. */
  stepKey: workflowTemplateKeySchema,
  type: z.enum(ISSUE_EXECUTION_STAGE_TYPES),
  /** Empty means "the reviewer chosen when the pack starts". */
  participants: z.array(issueExecutionStagePrincipalSchema).max(10).default([]),
});

export const workflowTemplateDefinitionSchema = z
  .object({
    version: z.literal(1),
    coordinator: z
      .object({
        description: z.string().max(20_000).optional().nullable(),
        assigneeAgentId: z.string().guid().optional().nullable(),
        documents: z.array(workflowTemplateDocumentSlotSchema).max(20).default([]),
      })
      .default({ documents: [] }),
    steps: z.array(workflowTemplateStepSchema).min(1).max(30),
    reviews: z.array(workflowTemplateReviewSchema).max(10).default([]),
  })
  .superRefine((value, ctx) => {
    const seenSteps = new Set<string>();
    value.steps.forEach((step, index) => {
      if (seenSteps.has(step.key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate step key "${step.key}"`, path: ["steps", index, "key"] });
      }
      step.blockedBy.forEach((blockerKey, blockerIndex) => {
        // Only earlier steps may block a step, so the order is always a valid plan (no cycles).
        if (!seenSteps.has(blockerKey)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Step "${step.key}" can only wait for an earlier step, not "${blockerKey}"`,
            path: ["steps", index, "blockedBy", blockerIndex],
          });
        }
      });
      const seenDocs = new Set<string>();
      step.documents.forEach((doc, docIndex) => {
        if (seenDocs.has(doc.key)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate document key "${doc.key}"`, path: ["steps", index, "documents", docIndex, "key"] });
        }
        seenDocs.add(doc.key);
      });
      seenSteps.add(step.key);
    });
    const seenReviews = new Set<string>();
    value.reviews.forEach((review, index) => {
      if (seenReviews.has(review.key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate review key "${review.key}"`, path: ["reviews", index, "key"] });
      }
      seenReviews.add(review.key);
      if (!seenSteps.has(review.stepKey)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Review "${review.key}" names an unknown step "${review.stepKey}"`, path: ["reviews", index, "stepKey"] });
      }
    });
  });

export type WorkflowTemplateDefinitionInput = z.input<typeof workflowTemplateDefinitionSchema>;

export const createWorkflowTemplateSchema = z.object({
  key: workflowTemplateKeySchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5_000).optional().nullable(),
  definition: workflowTemplateDefinitionSchema,
});
export type CreateWorkflowTemplate = z.infer<typeof createWorkflowTemplateSchema>;

export const updateWorkflowTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5_000).optional().nullable(),
  definition: workflowTemplateDefinitionSchema.optional(),
  archived: z.boolean().optional(),
});
export type UpdateWorkflowTemplate = z.infer<typeof updateWorkflowTemplateSchema>;

export const startWorkflowTemplateSchema = z.object({
  /** Coordinator issue title; step issues are titled "<title>: <step title>". */
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).optional().nullable(),
  projectId: z.string().guid().optional().nullable(),
  goalId: z.string().guid().optional().nullable(),
  parentId: z.string().guid().optional().nullable(),
  /** Used for every review with no participants in the template. Defaults to the signed-in user. */
  reviewerUserId: z.string().trim().min(1).max(200).optional().nullable(),
});
export type StartWorkflowTemplate = z.infer<typeof startWorkflowTemplateSchema>;
