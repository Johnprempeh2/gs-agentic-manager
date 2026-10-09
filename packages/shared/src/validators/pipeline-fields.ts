import { z } from "zod";
import {
  PIPELINE_FIELD_KEY_PATTERN,
  PIPELINE_FIELD_TYPES,
  PIPELINE_FIELD_TYPES_WITH_OPTIONS,
} from "../pipeline-fields.js";

export const pipelineFieldTypeSchema = z.enum(PIPELINE_FIELD_TYPES);

export const pipelineFieldKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(PIPELINE_FIELD_KEY_PATTERN, "Start with a letter; use letters, numbers and _ only");

const optionSchema = z.string().trim().min(1).max(200);

export const pipelineFieldOptionsSchema = z.array(optionSchema).max(200).superRefine((options, ctx) => {
  const seen = new Set<string>();
  options.forEach((option, index) => {
    if (seen.has(option)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: "Each choice can appear once" });
    }
    seen.add(option);
  });
});

export const createPipelineFieldSchema = z.object({
  key: pipelineFieldKeySchema,
  label: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).optional().nullable(),
  type: pipelineFieldTypeSchema,
  required: z.boolean().optional().default(false),
  options: pipelineFieldOptionsSchema.optional().default([]),
  position: z.number().int().min(0).optional(),
}).strict().superRefine((value, ctx) => {
  const needsOptions = PIPELINE_FIELD_TYPES_WITH_OPTIONS.includes(value.type);
  if (needsOptions && value.options.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: "Add at least one choice" });
  }
  if (!needsOptions && value.options.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: "Only choice fields have choices" });
  }
});

/** Key and type are fixed once created; archive the field and add a new one to change them. */
export const updatePipelineFieldSchema = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2_000).optional().nullable(),
  required: z.boolean().optional(),
  options: pipelineFieldOptionsSchema.optional(),
  position: z.number().int().min(0).optional(),
  archived: z.boolean().optional(),
}).strict();

export const listPipelineFieldsQuerySchema = z.object({
  includeArchived: z.enum(["true", "false"]).optional().transform((value) => value === "true"),
}).strict();

export type CreatePipelineField = z.infer<typeof createPipelineFieldSchema>;
export type UpdatePipelineField = z.infer<typeof updatePipelineFieldSchema>;
export type ListPipelineFieldsQuery = z.infer<typeof listPipelineFieldsQuerySchema>;
