import { Router, type Request } from "express";
import { and, asc, desc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  intelligenceBoardSnapshots,
  intelligenceRecommendations,
  intelligenceReports,
  issues,
  projects,
} from "@greatstone/db";
import {
  INTELLIGENCE_BOARDS,
  INTELLIGENCE_REPORT_KINDS,
  INTELLIGENCE_WRITE_PERMISSION,
  computeBoardMovement,
  createIntelligenceRecommendationSchema,
  createIntelligenceRecommendationTaskSchema,
  intelligenceDateSchema,
  pickComparisonSnapshotDate,
  updateIntelligenceRecommendationSchema,
  upsertBoardSnapshotSchema,
  upsertIntelligenceReportSchema,
  type IntelligenceBoard,
  type IntelligenceBoardEntry,
  type IntelligenceBoardHistory,
  type IntelligenceBoardView,
  type IntelligenceRecommendation,
  type IntelligenceReport,
  type IntelligenceReportKind,
  type IntelligenceReportSummary,
  type UpsertIntelligenceReport,
} from "@greatstone/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { requireEntitlement } from "../services/entitlements.js";
import { accessService, issueService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";

// Intelligence page: the Daily Pulse and the AI Intelligence Hub inside GSAM.
// Everyone in the company reads. Board users write; an agent writes only with
// the `intelligence:write` grant (a refusal names it, so the board gets a
// Grant / Deny item). Accept, dismiss and create-task are board actions.
// `enableIntelligence` gates every route first: off answers 403 not_entitled.

function parseDate(raw: unknown): string {
  const parsed = intelligenceDateSchema.safeParse(raw);
  if (!parsed.success) throw unprocessable("Use a date as YYYY-MM-DD");
  return parsed.data;
}

function parseKind(raw: unknown): IntelligenceReportKind {
  const kind = raw ?? "daily_pulse";
  if (!(INTELLIGENCE_REPORT_KINDS as readonly unknown[]).includes(kind)) {
    throw unprocessable(`kind must be one of: ${INTELLIGENCE_REPORT_KINDS.join(", ")}`);
  }
  return kind as IntelligenceReportKind;
}

function parseBoard(raw: unknown): IntelligenceBoard {
  if (!(INTELLIGENCE_BOARDS as readonly unknown[]).includes(raw)) {
    throw unprocessable(`board must be one of: ${INTELLIGENCE_BOARDS.join(", ")}`);
  }
  return raw as IntelligenceBoard;
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

function toReport(row: typeof intelligenceReports.$inferSelect): IntelligenceReport {
  return {
    id: row.id,
    companyId: row.companyId,
    reportDate: row.reportDate,
    kind: row.kind,
    status: row.status,
    headline: row.headline,
    sections: row.sections,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    publishedAt: iso(row.publishedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  } as IntelligenceReport;
}

function toRecommendation(
  row: typeof intelligenceRecommendations.$inferSelect,
  issueIdentifier: string | null,
): IntelligenceRecommendation {
  return {
    id: row.id,
    companyId: row.companyId,
    kind: row.kind as IntelligenceRecommendation["kind"],
    title: row.title,
    why: row.why,
    effort: row.effort as IntelligenceRecommendation["effort"],
    status: row.status as IntelligenceRecommendation["status"],
    sourceUrl: row.sourceUrl,
    reportDate: row.reportDate,
    issueId: row.issueId,
    issueIdentifier,
    createdByAgentId: row.createdByAgentId,
    decidedByUserId: row.decidedByUserId,
    decidedAt: iso(row.decidedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function intelligenceRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);

  router.use("/companies/:companyId/intelligence", requireEntitlement(db, "enableIntelligence"));
  router.use("/intelligence", requireEntitlement(db, "enableIntelligence"));

  /** Board users, or an agent holding `intelligence:write`. */
  async function assertCanWrite(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return;
    if (req.actor.type === "agent" && req.actor.agentId) {
      if (await access.hasPermission(companyId, "agent", req.actor.agentId, INTELLIGENCE_WRITE_PERMISSION)) return;
    }
    throw forbidden(`Missing permission: ${INTELLIGENCE_WRITE_PERMISSION}`);
  }

  async function log(req: Request, companyId: string, action: string, entityType: string, entityId: string, details: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action,
      entityType,
      entityId,
      ...(actor.agentId ? { agentId: actor.agentId } : {}),
      ...(actor.runId ? { runId: actor.runId } : {}),
      details,
    });
  }

  // ---------- Reports ----------

  router.get("/companies/:companyId/intelligence/reports", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const kind = req.query.kind === undefined ? null : parseKind(req.query.kind);
    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 366);
    const rows = await db
      .select({
        id: intelligenceReports.id,
        reportDate: intelligenceReports.reportDate,
        kind: intelligenceReports.kind,
        status: intelligenceReports.status,
        headline: intelligenceReports.headline,
        updatedAt: intelligenceReports.updatedAt,
      })
      .from(intelligenceReports)
      .where(and(eq(intelligenceReports.companyId, companyId), kind ? eq(intelligenceReports.kind, kind) : undefined))
      .orderBy(desc(intelligenceReports.reportDate), asc(intelligenceReports.kind))
      .limit(limit);
    const reports: IntelligenceReportSummary[] = rows.map((row) => ({
      ...row,
      kind: row.kind as IntelligenceReportKind,
      status: row.status as IntelligenceReportSummary["status"],
      updatedAt: row.updatedAt.toISOString(),
    }));
    res.json({ reports });
  });

  /** `latest` reads the newest report of the kind (published first, a draft only when nothing is published). */
  router.get("/companies/:companyId/intelligence/reports/:reportDate", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const kind = parseKind(req.query.kind);
    const raw = req.params.reportDate as string;
    const scope = and(eq(intelligenceReports.companyId, companyId), eq(intelligenceReports.kind, kind));
    const [row] =
      raw === "latest"
        ? await db
            .select()
            .from(intelligenceReports)
            .where(scope)
            .orderBy(sql`(${intelligenceReports.status} = 'published') desc`, desc(intelligenceReports.reportDate))
            .limit(1)
        : await db
            .select()
            .from(intelligenceReports)
            .where(and(scope, eq(intelligenceReports.reportDate, parseDate(raw))))
            .limit(1);
    if (!row) throw notFound("No intelligence report for that date");
    res.json(toReport(row));
  });

  router.put(
    "/companies/:companyId/intelligence/reports/:reportDate",
    validate(upsertIntelligenceReportSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanWrite(req, companyId);
      const reportDate = parseDate(req.params.reportDate);
      const body = req.body as UpsertIntelligenceReport;
      const actor = getActorInfo(req);
      const now = new Date();
      const publishedAt = body.status === "published" ? now : null;
      const [row] = await db
        .insert(intelligenceReports)
        .values({
          companyId,
          reportDate,
          kind: body.kind,
          status: body.status,
          headline: body.headline ?? null,
          sections: body.sections as Record<string, unknown>,
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          publishedAt,
        })
        .onConflictDoUpdate({
          target: [intelligenceReports.companyId, intelligenceReports.reportDate, intelligenceReports.kind],
          set: {
            status: body.status,
            headline: body.headline ?? null,
            sections: body.sections as Record<string, unknown>,
            // Keep the first publish time; a draft write clears it.
            publishedAt: publishedAt ? sql`coalesce(${intelligenceReports.publishedAt}, now())` : null,
            updatedAt: now,
          },
        })
        .returning();
      await log(req, companyId, "intelligence.report_written", "intelligence_report", row!.id, {
        reportDate,
        kind: body.kind,
        status: body.status,
      });
      res.json(toReport(row!));
    },
  );

  // ---------- Leaderboards ----------

  /** Each board at `date` (default: latest), with movement against the hub's week-over-week comparison snapshot. */
  router.get("/companies/:companyId/intelligence/boards", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const date = req.query.date === undefined ? null : parseDate(req.query.date);
    const boards: IntelligenceBoardView[] = [];
    for (const board of INTELLIGENCE_BOARDS) {
      const scope = and(eq(intelligenceBoardSnapshots.companyId, companyId), eq(intelligenceBoardSnapshots.board, board));
      const [current] = await db
        .select()
        .from(intelligenceBoardSnapshots)
        .where(and(scope, date ? lte(intelligenceBoardSnapshots.snapshotDate, date) : undefined))
        .orderBy(desc(intelligenceBoardSnapshots.snapshotDate))
        .limit(1);
      if (!current) continue;
      // ponytail: reads every earlier date for this board (90 a quarter); add a window if history grows to years.
      const earlierDates = await db
        .select({ snapshotDate: intelligenceBoardSnapshots.snapshotDate })
        .from(intelligenceBoardSnapshots)
        .where(and(scope, lt(intelligenceBoardSnapshots.snapshotDate, current.snapshotDate)));
      const comparedTo = pickComparisonSnapshotDate(
        earlierDates.map((row) => row.snapshotDate),
        current.snapshotDate,
      );
      const [prior] = comparedTo
        ? await db
            .select({ entries: intelligenceBoardSnapshots.entries })
            .from(intelligenceBoardSnapshots)
            .where(and(scope, eq(intelligenceBoardSnapshots.snapshotDate, comparedTo)))
        : [];
      const entries = [...(current.entries as unknown as IntelligenceBoardEntry[])].sort((a, b) => a.rank - b.rank);
      const movement = computeBoardMovement(entries, prior ? (prior.entries as unknown as IntelligenceBoardEntry[]) : null);
      boards.push({
        board,
        snapshotDate: current.snapshotDate,
        comparedTo,
        entries: entries.map((entry, index) => ({ ...entry, movement: movement[index]! })),
      });
    }
    res.json({ boards });
  });

  /** The last `limit` snapshots of each board (default 12, at most 90), up to `date`, for score sparklines. */
  router.get("/companies/:companyId/intelligence/boards/history", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const date = req.query.date === undefined ? null : parseDate(req.query.date);
    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 2), 90);
    const history: IntelligenceBoardHistory[] = [];
    for (const board of INTELLIGENCE_BOARDS) {
      const rows = await db
        .select({ snapshotDate: intelligenceBoardSnapshots.snapshotDate, entries: intelligenceBoardSnapshots.entries })
        .from(intelligenceBoardSnapshots)
        .where(
          and(
            eq(intelligenceBoardSnapshots.companyId, companyId),
            eq(intelligenceBoardSnapshots.board, board),
            date ? lte(intelligenceBoardSnapshots.snapshotDate, date) : undefined,
          ),
        )
        .orderBy(desc(intelligenceBoardSnapshots.snapshotDate))
        .limit(limit);
      if (rows.length === 0) continue;
      history.push({
        board,
        points: rows.reverse().map((row) => ({
          snapshotDate: row.snapshotDate,
          scores: Object.fromEntries(
            (row.entries as unknown as IntelligenceBoardEntry[]).map((entry) => [entry.name.toLowerCase(), entry.score]),
          ),
        })),
      });
    }
    res.json({ history });
  });

  router.put(
    "/companies/:companyId/intelligence/boards/:board/snapshots/:snapshotDate",
    validate(upsertBoardSnapshotSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanWrite(req, companyId);
      const board = parseBoard(req.params.board);
      const snapshotDate = parseDate(req.params.snapshotDate);
      const entries = (req.body as { entries: IntelligenceBoardEntry[] }).entries as unknown as Record<string, unknown>[];
      const actor = getActorInfo(req);
      const [row] = await db
        .insert(intelligenceBoardSnapshots)
        .values({ companyId, board, snapshotDate, entries, createdByAgentId: actor.agentId })
        .onConflictDoUpdate({
          target: [intelligenceBoardSnapshots.companyId, intelligenceBoardSnapshots.board, intelligenceBoardSnapshots.snapshotDate],
          set: { entries, updatedAt: new Date() },
        })
        .returning();
      await log(req, companyId, "intelligence.snapshot_written", "intelligence_board_snapshot", row!.id, {
        board,
        snapshotDate,
        entries: entries.length,
      });
      res.json({
        id: row!.id,
        companyId,
        board,
        snapshotDate,
        entries: row!.entries,
        createdAt: row!.createdAt.toISOString(),
        updatedAt: row!.updatedAt.toISOString(),
      });
    },
  );

  // ---------- Recommendations ----------

  async function withIdentifiers(rows: (typeof intelligenceRecommendations.$inferSelect)[]) {
    const ids = rows.flatMap((row) => (row.issueId ? [row.issueId] : []));
    const linked = ids.length
      ? await db.select({ id: issues.id, identifier: issues.identifier }).from(issues).where(inArray(issues.id, ids))
      : [];
    const byId = new Map(linked.map((issue) => [issue.id, issue.identifier]));
    return rows.map((row) => toRecommendation(row, row.issueId ? byId.get(row.issueId) ?? null : null));
  }

  async function loadRecommendation(req: Request) {
    const [row] = await db
      .select()
      .from(intelligenceRecommendations)
      .where(eq(intelligenceRecommendations.id, req.params.id as string));
    // Another company's recommendation answers 404 like a missing one, so the
    // id cannot be probed across companies (403 would say it exists).
    if (!row || !hasCompanyAccess(req, row.companyId)) throw notFound("Recommendation not found");
    assertCompanyAccess(req, row.companyId);
    assertBoard(req);
    return row;
  }

  router.get("/companies/:companyId/intelligence/recommendations", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await db
      .select()
      .from(intelligenceRecommendations)
      .where(eq(intelligenceRecommendations.companyId, companyId))
      .orderBy(desc(intelligenceRecommendations.createdAt));
    res.json({ recommendations: await withIdentifiers(rows) });
  });

  router.post(
    "/companies/:companyId/intelligence/recommendations",
    validate(createIntelligenceRecommendationSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanWrite(req, companyId);
      const body = req.body as typeof createIntelligenceRecommendationSchema._output;
      const actor = getActorInfo(req);
      const [row] = await db
        .insert(intelligenceRecommendations)
        .values({
          companyId,
          kind: body.kind,
          title: body.title,
          why: body.why,
          effort: body.effort,
          sourceUrl: body.sourceUrl ?? null,
          reportDate: body.reportDate ?? null,
          createdByAgentId: actor.agentId,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) throw conflict(`A ${body.kind} recommendation titled "${body.title}" already exists`);
      await log(req, companyId, "intelligence.recommendation_created", "intelligence_recommendation", row.id, {
        kind: row.kind,
        title: row.title,
      });
      res.status(201).json(toRecommendation(row, null));
    },
  );

  router.patch(
    "/intelligence/recommendations/:id",
    validate(updateIntelligenceRecommendationSchema),
    async (req, res) => {
      const existing = await loadRecommendation(req);
      const status = (req.body as { status: IntelligenceRecommendation["status"] }).status;
      const actor = getActorInfo(req);
      const [row] = await db
        .update(intelligenceRecommendations)
        .set({
          status,
          decidedByUserId: status === "new" ? null : actor.actorId,
          decidedAt: status === "new" ? null : new Date(),
          updatedAt: new Date(),
        })
        .where(eq(intelligenceRecommendations.id, existing.id))
        .returning();
      await log(req, existing.companyId, "intelligence.recommendation_decided", "intelligence_recommendation", existing.id, { status });
      res.json((await withIdentifiers([row!]))[0]);
    },
  );

  /** One task per recommendation; it is accepted with it. A second call returns the same link. */
  router.post(
    "/intelligence/recommendations/:id/task",
    validate(createIntelligenceRecommendationTaskSchema),
    async (req, res) => {
      const existing = await loadRecommendation(req);
      if (existing.issueId) {
        res.json((await withIdentifiers([existing]))[0]);
        return;
      }
      const projectId = (req.body as { projectId?: string | null }).projectId ?? null;
      if (projectId) {
        const [project] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, projectId), eq(projects.companyId, existing.companyId)));
        if (!project) throw notFound("Project not found");
      }
      const label = existing.kind === "skill" ? "Skill" : "GSAM feature";
      const issue = await issueService(db).create(existing.companyId, {
        title: `${label}: ${existing.title}`,
        description: [
          existing.why,
          "",
          `Effort: ${existing.effort}.`,
          existing.sourceUrl ? `Source: ${existing.sourceUrl}` : null,
          "",
          `From the Intelligence page${existing.reportDate ? ` (${existing.reportDate})` : ""}.`,
        ]
          .filter((line) => line !== null)
          .join("\n"),
        status: "todo",
        projectId,
      });
      const actor = getActorInfo(req);
      const [row] = await db
        .update(intelligenceRecommendations)
        .set({ issueId: issue.id, status: "accepted", decidedByUserId: actor.actorId, decidedAt: new Date(), updatedAt: new Date() })
        .where(eq(intelligenceRecommendations.id, existing.id))
        .returning();
      await log(req, existing.companyId, "intelligence.recommendation_task_created", "intelligence_recommendation", existing.id, {
        issueId: issue.id,
      });
      res.status(201).json(toRecommendation(row!, issue.identifier ?? null));
    },
  );

  return router;
}
