import { z } from "zod";
import {
  DOCUMENT_EVIDENCE_FRESHNESS,
  DOCUMENT_EVIDENCE_SOURCE_TYPES,
} from "../types/document-evidence.js";

/** Bullet IDs as written in the document: "S1", "E3", "R12", "KPI-4". */
export const DOCUMENT_EVIDENCE_BULLET_ID_PATTERN = /^[A-Z]{1,4}-?\d{1,4}$/;

export const documentEvidenceBulletIdSchema = z
  .string()
  .trim()
  .regex(DOCUMENT_EVIDENCE_BULLET_ID_PATTERN, "Use the bullet's ID from the document, e.g. S1 or E3");

const isoDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "Not a real date");

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value ? value : null));

/** Only `sourceId` is required: an incomplete link is stored and flagged by the check, not rejected. */
export const documentEvidenceSourceSchema = z
  .object({
    sourceId: z.string().trim().min(1).max(40),
    locator: optionalText(2_000),
    sourceDate: isoDateSchema.nullable().optional(),
    type: z.enum(DOCUMENT_EVIDENCE_SOURCE_TYPES).nullable().optional(),
    periodEnd: isoDateSchema.nullable().optional(),
    geography: optionalText(200),
    freshness: z.enum(DOCUMENT_EVIDENCE_FRESHNESS).nullable().optional(),
    note: optionalText(500),
  })
  .strict();

export const upsertDocumentEvidenceBulletSchema = z
  .object({
    bulletId: documentEvidenceBulletIdSchema,
    sources: z.array(documentEvidenceSourceSchema).max(20),
    inference: z.boolean().optional(),
    judgement: z.boolean().optional(),
  })
  .strict();

export const upsertDocumentEvidenceSchema = z
  .object({
    bullets: z.array(upsertDocumentEvidenceBulletSchema).min(1).max(200),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.bullets.forEach((bullet, index) => {
      if (seen.has(bullet.bulletId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Bullet ${bullet.bulletId} is listed twice`,
          path: ["bullets", index, "bulletId"],
        });
      }
      seen.add(bullet.bulletId);
    });
  });

export type UpsertDocumentEvidence = z.infer<typeof upsertDocumentEvidenceSchema>;
