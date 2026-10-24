import { z } from "zod";

// Motion studies (GRE-2212): the Greatstone Animation Lab's self-contained
// HTML studies, kept in GS Studio's Motion section. Each study file is a
// company asset served sandboxed with no network; this record carries the
// catalogue fields that used to live in Notion, plus the decisions on it.
// People set Status and Decision; agents propose, and a person accepts.

export const MOTION_STUDY_STATUSES = ["new", "reviewed", "approved", "implemented", "archived"] as const;
export type MotionStudyStatus = (typeof MOTION_STUDY_STATUSES)[number];

export const MOTION_STUDY_DECISIONS = ["undecided", "implement", "maybe", "pass"] as const;
export type MotionStudyDecision = (typeof MOTION_STUDY_DECISIONS)[number];

export const MOTION_STUDY_STATUS_LABELS: Record<MotionStudyStatus, string> = {
  new: "New",
  reviewed: "Reviewed",
  approved: "Approved",
  implemented: "Implemented",
  archived: "Archived",
};

export const MOTION_STUDY_DECISION_LABELS: Record<MotionStudyDecision, string> = {
  undecided: "Undecided",
  implement: "Implement",
  maybe: "Maybe",
  pass: "Pass",
};

/** Where a study came from: the one-off Lab import, the daily routine, or an agent or person by hand. */
export const MOTION_STUDY_SOURCES = ["lab_import", "routine", "manual"] as const;
export type MotionStudySource = (typeof MOTION_STUDY_SOURCES)[number];

/** The theme tag the Lab gives studies built to the background contract. */
export const MOTION_TEXT_SAFE_THEME = "Text-safe";

/**
 * The background contract a text-safe study meets: words can sit on it.
 * Shown on the card so a reader knows what "text-safe" promises.
 */
export const MOTION_TEXT_SAFE_CONTRACT = [
  "A quiet zone over the centre",
  "Body text contrast of at least 7:1",
  "Lime never behind copy",
  "Very slow motion",
  "Tunable with the CEIL and QUIET knobs",
] as const;

export function isTextSafeTheme(theme: readonly string[]): boolean {
  return theme.some((tag) => tag.trim().toLowerCase() === MOTION_TEXT_SAFE_THEME.toLowerCase());
}

/** A study file is a small single HTML page; this keeps one well inside the attachment limit. */
export const MOTION_STUDY_HTML_MAX_BYTES = 2 * 1024 * 1024;
export const MOTION_STUDIES_IMPORT_MAX = 100;

/** A card's poster: one still frame of the study, so the grid shows pictures without running every study. */
export const MOTION_STUDY_POSTER_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type MotionStudyPosterType = (typeof MOTION_STUDY_POSTER_TYPES)[number];
export const MOTION_STUDY_POSTER_MAX_BYTES = 512 * 1024;

const posterSchema = z.object({
  contentType: z.enum(MOTION_STUDY_POSTER_TYPES),
  /** The image, base64 encoded. */
  dataBase64: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "Give the poster as base64")
    .refine((value) => Math.floor((value.length * 3) / 4) <= MOTION_STUDY_POSTER_MAX_BYTES, {
      message: "Keep the poster under 512 KB",
    }),
});

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lower-case letters, numbers and single hyphens");

const numberSchema = z
  .string()
  .trim()
  .regex(/^\d{1,4}$/, "Use the study number, for example 021");

const studyFieldsSchema = z.object({
  /** The Lab's running number, for example "021". Left out, the next number is used. */
  number: numberSchema.optional(),
  slug: slugSchema,
  title: z.string().trim().min(1).max(120),
  concept: z.string().trim().max(2000).default(""),
  theme: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
  tech: z.string().trim().max(120).default(""),
  notes: z.string().trim().max(5000).nullable().optional(),
  /** The day the study was made, YYYY-MM-DD. */
  studyDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  /** Where the study was published before GSAM, if anywhere. */
  sourceUrl: z.string().url().max(500).nullable().optional(),
  /** The whole study as one self-contained HTML page. */
  html: z
    .string()
    .min(1)
    .refine((value) => new TextEncoder().encode(value).byteLength <= MOTION_STUDY_HTML_MAX_BYTES, {
      message: "Keep the study file under 2 MB",
    }),
  /** Left out, it follows the theme: a study tagged Text-safe is text-safe. */
  textSafe: z.boolean().optional(),
  /** A still frame for the card. Left out on a re-import, the poster already kept stays. */
  poster: posterSchema.nullable().optional(),
});

/** One new study, from the daily routine or by hand. It always starts as New and Undecided. */
export const createMotionStudySchema = studyFieldsSchema.extend({
  source: z.enum(["routine", "manual"]).default("manual"),
});
export type CreateMotionStudy = z.input<typeof createMotionStudySchema>;

/**
 * The one-off import of the Lab's existing studies. Matching is by slug:
 * a study already here keeps its Status and Decision and gets the new file
 * and fields; a new one takes the given Status and Decision.
 */
export const importMotionStudiesSchema = z.object({
  studies: z
    .array(
      studyFieldsSchema.extend({
        number: numberSchema,
        status: z.enum(MOTION_STUDY_STATUSES).default("new"),
        decision: z.enum(MOTION_STUDY_DECISIONS).default("undecided"),
      }),
    )
    .min(1)
    .max(MOTION_STUDIES_IMPORT_MAX),
});
export type ImportMotionStudies = z.input<typeof importMotionStudiesSchema>;

/**
 * A change to a study's decisions or notes. From a person it takes effect;
 * from an agent, Status and Decision are saved as a proposal for a person.
 */
export const updateMotionStudySchema = z
  .object({
    status: z.enum(MOTION_STUDY_STATUSES).optional(),
    decision: z.enum(MOTION_STUDY_DECISIONS).optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
    /** Why, for a proposal. Kept with it so the person deciding can read it. */
    reason: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Change at least one field",
  });
export type UpdateMotionStudy = z.input<typeof updateMotionStudySchema>;

/** A person's answer to an agent's proposal. */
export const resolveMotionStudyProposalSchema = z.object({
  accept: z.boolean(),
});
export type ResolveMotionStudyProposal = z.input<typeof resolveMotionStudyProposalSchema>;

export const motionStudiesQuerySchema = z.object({
  status: z.enum(MOTION_STUDY_STATUSES).optional(),
  decision: z.enum(MOTION_STUDY_DECISIONS).optional(),
  textSafe: z.union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")]).optional(),
  q: z.string().trim().max(200).optional(),
});
export type MotionStudiesQuery = z.infer<typeof motionStudiesQuerySchema>;

export interface MotionStudyProposal {
  status: MotionStudyStatus | null;
  decision: MotionStudyDecision | null;
  reason: string | null;
  agentId: string | null;
  proposedAt: string;
}

export interface MotionStudy {
  id: string;
  companyId: string;
  number: string;
  slug: string;
  title: string;
  concept: string;
  theme: string[];
  tech: string;
  notes: string | null;
  studyDate: string | null;
  sourceUrl: string | null;
  textSafe: boolean;
  status: MotionStudyStatus;
  decision: MotionStudyDecision;
  /** An agent's open proposal on Status or Decision, waiting for a person. */
  proposal: MotionStudyProposal | null;
  source: MotionStudySource;
  assetId: string | null;
  /** Where the sandboxed study page is served; null if its file is missing. */
  previewPath: string | null;
  posterAssetId: string | null;
  /** The card's still frame; null until one is captured. */
  posterPath: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MotionStudiesResponse {
  studies: MotionStudy[];
}

export interface ImportMotionStudiesResult {
  created: number;
  updated: number;
  studies: MotionStudy[];
}
