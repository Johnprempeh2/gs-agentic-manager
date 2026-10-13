import { z } from "zod";

/**
 * Intelligence page (the Daily Pulse and the AI Intelligence Hub, inside GSAM).
 * Agents write reports and board snapshots through the API; the page reads
 * them. Every shape is strict, so a bad agent write is refused with the path
 * of the field that is wrong, and every news, tool or signal item carries an
 * https source URL.
 */

export const INTELLIGENCE_REPORT_KINDS = ["daily_pulse", "ai_briefing"] as const;
export type IntelligenceReportKind = (typeof INTELLIGENCE_REPORT_KINDS)[number];

export const INTELLIGENCE_REPORT_STATUSES = ["draft", "published"] as const;
export type IntelligenceReportStatus = (typeof INTELLIGENCE_REPORT_STATUSES)[number];

export const INTELLIGENCE_BOARDS = ["ai_systems", "frontier_models", "tools_agents"] as const;
export type IntelligenceBoard = (typeof INTELLIGENCE_BOARDS)[number];

export const INTELLIGENCE_BOARD_LABELS: Record<IntelligenceBoard, string> = {
  ai_systems: "AI Systems",
  frontier_models: "Frontier Models",
  tools_agents: "Tools and Agents",
};

export const INTELLIGENCE_RECOMMENDATION_KINDS = ["gsam_feature", "skill"] as const;
export type IntelligenceRecommendationKind = (typeof INTELLIGENCE_RECOMMENDATION_KINDS)[number];

export const INTELLIGENCE_RECOMMENDATION_STATUSES = ["new", "accepted", "dismissed"] as const;
export type IntelligenceRecommendationStatus = (typeof INTELLIGENCE_RECOMMENDATION_STATUSES)[number];

export const INTELLIGENCE_EFFORTS = ["quick", "medium", "deep"] as const;
export type IntelligenceEffort = (typeof INTELLIGENCE_EFFORTS)[number];

/** The agent permission that lets an agent write reports, snapshots and recommendations. */
export const INTELLIGENCE_WRITE_PERMISSION = "intelligence:write" as const;

export const intelligenceDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date as YYYY-MM-DD")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "Not a real date");

export const httpsUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "Every item needs a real source: an https URL");

const countWords = (value: string) => value.trim().split(/\s+/).filter(Boolean).length;

/** Text with a word ceiling: card text is short by rule, long analysis lives in the drawer. */
const words = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((value) => countWords(value) <= max, `Keep this to ${max} words or fewer`);

const label = (max = 200) => z.string().trim().min(1).max(max);

export const intelligenceLinkSchema = z
  .object({ label: label(), url: httpsUrlSchema, tag: label(40).optional() })
  .strict();
export type IntelligenceLink = z.infer<typeof intelligenceLinkSchema>;

const learnMore = z.array(intelligenceLinkSchema).max(5).default([]);
const rating = z.number().int().min(1).max(5);

// ---------- Daily Pulse ----------

export const pulseQuickWinSchema = z
  .object({
    title: label(),
    action: words(60),
    timeNeeded: label(40),
    outcome: words(40),
    url: httpsUrlSchema.optional(),
  })
  .strict();

export const pulseSkillIdeaSchema = z
  .object({
    name: label(80),
    what: words(50),
    whyNow: words(50),
    buildEstimate: z.enum(INTELLIGENCE_EFFORTS),
    clientValue: words(50),
    sourceUrl: httpsUrlSchema.optional(),
  })
  .strict();

export const pulseTrendSchema = z
  .object({
    headline: label(),
    whyItMatters: words(50),
    freshness: z.enum(["today", "this_week", "emerging"]),
    sourceName: label(120),
    url: httpsUrlSchema,
    learnMore,
  })
  .strict();

export const PULSE_TOOL_CATEGORIES = [
  "automation",
  "ai_coding",
  "design",
  "productivity",
  "data",
  "content",
  "other",
] as const;

export const pulseToolSchema = z
  .object({
    name: label(80),
    url: httpsUrlSchema,
    what: words(35),
    category: z.enum(PULSE_TOOL_CATEGORIES),
    pricing: label(80),
    personalRating: rating,
    clientRating: rating,
    flaggedBy: label(120),
    quickTake: words(50),
    learnMore,
  })
  .strict();

export const pulseCreatorSchema = z
  .object({
    creator: label(120),
    platform: label(60),
    content: label(),
    why: words(35),
    url: httpsUrlSchema,
    newFace: z.boolean().default(false),
  })
  .strict();

export const pulseOpportunitySchema = z
  .object({
    title: label(),
    triggeredBy: words(35),
    targetClients: words(30),
    revenuePotential: z.enum(["low", "medium", "high"]),
    revenueReason: words(40).optional(),
    nextStep: words(40),
    explorePrompt: z.string().trim().min(1).max(2000).optional(),
    sources: z.array(intelligenceLinkSchema).min(1, "An opportunity needs at least one source").max(5),
  })
  .strict();

export const dailyPulseSectionsSchema = z
  .object({
    quickWin: pulseQuickWinSchema,
    skillIdeas: z.array(pulseSkillIdeaSchema).max(5).default([]),
    trends: z.array(pulseTrendSchema).max(8).default([]),
    tools: z.array(pulseToolSchema).max(8).default([]),
    creators: z.array(pulseCreatorSchema).max(6).default([]),
    opportunities: z.array(pulseOpportunitySchema).max(5).default([]),
    /** Friday edition only. */
    weekInReview: words(150).optional(),
  })
  .strict();
export type DailyPulseSections = z.infer<typeof dailyPulseSectionsSchema>;

// ---------- AI briefing (the hub's News and Radar) ----------

/**
 * Two-layer rule: the card shows `verdict`, the first three `points` and
 * `action` ("Do this"). `take` and `lens` sit behind "Full analysis".
 */
export const briefingNewsItemSchema = z
  .object({
    headline: label(400),
    tag: label(60),
    date: intelligenceDateSchema,
    sourceName: label(120),
    url: httpsUrlSchema,
    verdict: words(40),
    points: z.array(words(25)).min(1, "Give at least one point").max(5),
    action: words(35),
    take: words(400).optional(),
    lens: words(160).optional(),
    lead: z.boolean().default(false),
    rumoured: z.boolean().default(false),
  })
  .strict();

export const radarEmergingSchema = z
  .object({
    name: label(120),
    by: label(120),
    what: words(40),
    why: words(40),
    status: label(120),
    url: httpsUrlSchema,
  })
  .strict();

export const radarMoverSchema = z
  .object({
    name: label(),
    direction: z.enum(["up", "down"]),
    note: words(40),
    tag: label(60),
    url: httpsUrlSchema,
  })
  .strict();

export const radarWatchSchema = z
  .object({ name: label(), note: words(60), tag: label(60), url: httpsUrlSchema })
  .strict();

export const aiBriefingSectionsSchema = z
  .object({
    news: z.array(briefingNewsItemSchema).max(20).default([]),
    radar: z
      .object({
        emerging: z.array(radarEmergingSchema).max(10).default([]),
        movers: z.array(radarMoverSchema).max(10).default([]),
        watchlist: z.array(radarWatchSchema).max(10).default([]),
      })
      .strict()
      .default({ emerging: [], movers: [], watchlist: [] }),
  })
  .strict();
export type AiBriefingSections = z.infer<typeof aiBriefingSectionsSchema>;

const reportHeadline = z.string().trim().min(1).max(300).nullable().optional();
const reportStatus = z.enum(INTELLIGENCE_REPORT_STATUSES).default("draft");

/** `PUT /companies/:companyId/intelligence/reports/:reportDate`: one report per company, date and kind. */
export const upsertIntelligenceReportSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("daily_pulse"),
      status: reportStatus,
      headline: reportHeadline,
      sections: dailyPulseSectionsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("ai_briefing"),
      status: reportStatus,
      headline: reportHeadline,
      sections: aiBriefingSectionsSchema,
    })
    .strict(),
]);
export type UpsertIntelligenceReport = z.infer<typeof upsertIntelligenceReportSchema>;

// ---------- Leaderboards ----------

export const boardEntrySchema = z
  .object({
    name: label(120),
    rank: z.number().int().min(1).max(500),
    /** Board score (AI Systems, Tools and Agents) or Intelligence Index (Frontier Models). */
    score: z.number().finite().nullable(),
    maker: label(120).optional(),
    flagship: label(160).optional(),
    verdict: words(40).optional(),
    url: httpsUrlSchema.optional(),
    /** Compare tab: price, context, speed, benchmark figures. Unpublished is null. */
    specs: z.record(z.string().min(1).max(40), z.union([z.number().finite(), z.string().max(80), z.null()])).optional(),
  })
  .strict();
export type IntelligenceBoardEntry = z.infer<typeof boardEntrySchema>;

/** `PUT /companies/:companyId/intelligence/boards/:board/snapshots/:snapshotDate` */
export const upsertBoardSnapshotSchema = z
  .object({
    entries: z
      .array(boardEntrySchema)
      .min(1)
      .max(100)
      .superRefine((entries, ctx) => {
        const seen = new Set<string>();
        entries.forEach((entry, index) => {
          const key = entry.name.toLowerCase();
          if (seen.has(key)) ctx.addIssue({ code: "custom", message: `Duplicate entry: ${entry.name}`, path: [index, "name"] });
          seen.add(key);
        });
      }),
  })
  .strict();
export type UpsertBoardSnapshot = z.infer<typeof upsertBoardSnapshotSchema>;

export interface IntelligenceBoardMovement {
  /** Places gained since the compared snapshot (positive is up); null when there is nothing to compare. */
  rankDelta: number | null;
  scoreDelta: number | null;
  isNew: boolean;
}

/** Movement for each entry against an earlier snapshot of the same board. */
export function computeBoardMovement(
  entries: Pick<IntelligenceBoardEntry, "name" | "rank" | "score">[],
  prior: Pick<IntelligenceBoardEntry, "name" | "rank" | "score">[] | null,
): IntelligenceBoardMovement[] {
  const before = new Map((prior ?? []).map((entry) => [entry.name.toLowerCase(), entry]));
  return entries.map((entry) => {
    if (!prior) return { rankDelta: null, scoreDelta: null, isNew: false };
    const previous = before.get(entry.name.toLowerCase());
    if (!previous) return { rankDelta: null, scoreDelta: null, isNew: true };
    const scoreDelta =
      typeof entry.score === "number" && typeof previous.score === "number"
        ? Math.round((entry.score - previous.score) * 10) / 10
        : null;
    return { rankDelta: previous.rank - entry.rank, scoreDelta, isNew: false };
  });
}

/**
 * The snapshot to compare against, as the hub did it: the latest one at least
 * `windowDays` before `date`, or the earliest earlier one while history is short.
 */
export function pickComparisonSnapshotDate(dates: string[], date: string, windowDays = 7): string | null {
  const earlier = dates.filter((d) => d < date).sort();
  if (earlier.length === 0) return null;
  const target = new Date(Date.parse(`${date}T00:00:00Z`) - windowDays * 86_400_000).toISOString().slice(0, 10);
  const inWindow = earlier.filter((d) => d <= target);
  return inWindow.at(-1) ?? earlier[0]!;
}

// ---------- Recommendations ----------

export const createIntelligenceRecommendationSchema = z
  .object({
    kind: z.enum(INTELLIGENCE_RECOMMENDATION_KINDS),
    title: label(140),
    why: words(80),
    effort: z.enum(INTELLIGENCE_EFFORTS),
    sourceUrl: httpsUrlSchema.optional(),
    reportDate: intelligenceDateSchema.optional(),
  })
  .strict();
export type CreateIntelligenceRecommendation = z.infer<typeof createIntelligenceRecommendationSchema>;

export const updateIntelligenceRecommendationSchema = z
  .object({ status: z.enum(INTELLIGENCE_RECOMMENDATION_STATUSES) })
  .strict();

export const createIntelligenceRecommendationTaskSchema = z
  .object({ projectId: z.string().uuid().nullable().optional() })
  .strict();
