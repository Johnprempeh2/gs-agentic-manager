import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { caseDocuments, cases, deepDiveFindings, deepDiveSessionQuestions, deepDiveSessions, documents } from "@greatstone/db";
import {
  DEEP_DIVE_CASE_TYPES,
  DEEP_DIVE_GIF,
  DEEP_DIVE_SESSION_LABELS,
  DEEP_DIVE_SESSION_MAX_QUESTIONS,
  deepDiveGifStubBody,
  deepDiveSessionNextSteps,
  readDeepDiveStreamFields,
  type AddDeepDiveSessionQuestion,
  type AnswerToDeepDiveFinding,
  type DeepDiveCellKnown,
  type DeepDiveFindingStatus,
  type DeepDiveGifKey,
  type DeepDiveSession,
  type DeepDiveSessionQuestion,
  type DeepDiveSessionStatus,
  type DeepDiveSessionSummary,
  type DeepDiveStreamKey,
  type DeepDiveVisibility,
  type PlanDeepDiveSession,
  type UpdateDeepDiveSession,
  type UpdateDeepDiveSessionQuestion,
} from "@greatstone/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { deepDiveFindingsService, type DeepDiveFindingActor } from "./deep-dive-findings.js";

// Deep Dive sessions (GRE-2368): Screen 2 of the GRE-2327 plan. A session is
// planned as questions in GIF cells, run live one question at a time, and
// closed. Beside each question the service returns what is already known
// about its cell (Known/Indicated/Unknown, the cell's text, its findings and
// earlier answers) so nothing is asked twice. The guard triggers in migration
// 0397 enforce the same order for any writer; these checks answer first.

export type DeepDiveSessionActor = DeepDiveFindingActor;

type SessionRow = typeof deepDiveSessions.$inferSelect;
type QuestionRow = typeof deepDiveSessionQuestions.$inferSelect;

const GIF_BY_KEY = new Map(DEEP_DIVE_GIF.map((gif) => [gif.key, gif]));
const GIF_KEY_BY_DOCUMENT_KEY = new Map<string, DeepDiveGifKey>(DEEP_DIVE_GIF.map((gif) => [gif.documentKey, gif.key]));
const STUB_BODIES = new Set(DEEP_DIVE_GIF.map((gif) => deepDiveGifStubBody(gif).trim()));

function asSessionError(error: unknown): unknown {
  const cause = ((error as { cause?: unknown })?.cause ?? error) as { code?: string; message?: string };
  if (cause?.code === "23505") return conflict("This answer is already a finding");
  if (cause?.code === "23514" && cause.message) return unprocessable(cause.message);
  return error;
}

function notAllowed(status: DeepDiveSessionStatus, action: string) {
  return conflict(`This session is ${DEEP_DIVE_SESSION_LABELS[status]}, so you cannot ${action}`);
}

export function deepDiveSessionsService(db: Db) {
  const findings = deepDiveFindingsService(db);

  async function loadSession(sessionId: string): Promise<SessionRow> {
    const row = await db
      .select()
      .from(deepDiveSessions)
      .where(eq(deepDiveSessions.id, sessionId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Session not found");
    return row;
  }

  async function loadQuestion(questionId: string): Promise<QuestionRow> {
    const row = await db
      .select()
      .from(deepDiveSessionQuestions)
      .where(eq(deepDiveSessionQuestions.id, questionId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Question not found");
    return row;
  }

  /** The stream and GIF cell a question will sit in, checked against the company. */
  async function resolveCell(companyId: string, input: AddDeepDiveSessionQuestion) {
    const stream = await db
      .select({ id: cases.id })
      .from(cases)
      .where(and(eq(cases.id, input.streamCaseId), eq(cases.companyId, companyId), eq(cases.caseType, DEEP_DIVE_CASE_TYPES.stream)))
      .then((rows) => rows[0] ?? null);
    if (!stream) throw unprocessable("Investigation Stream not found in this company");
    const gif = GIF_BY_KEY.get(input.gifKey)!;
    const cell = await db
      .select({ id: caseDocuments.id })
      .from(caseDocuments)
      .where(and(eq(caseDocuments.companyId, companyId), eq(caseDocuments.caseId, stream.id), eq(caseDocuments.key, gif.documentKey)))
      .then((rows) => rows[0] ?? null);
    if (!cell) throw unprocessable(`The ${gif.label} cell of this stream has no document yet; complete the record first`);
    return { streamCaseId: stream.id, gifDocumentId: cell.id, prompt: input.prompt ?? gif.question };
  }

  /** What is already known about each cell, keyed by GIF document id. */
  async function knownFor(companyId: string, rows: QuestionRow[]) {
    const known = new Map<string, DeepDiveCellKnown & { gifKey: DeepDiveGifKey }>();
    if (rows.length === 0) return known;
    const cellIds = [...new Set(rows.map((row) => row.gifDocumentId))];
    const [cells, cellFindings, answers] = await Promise.all([
      db
        .select({
          id: caseDocuments.id,
          key: caseDocuments.key,
          streamKey: cases.key,
          fields: cases.fields,
          body: documents.latestBody,
        })
        .from(caseDocuments)
        .innerJoin(cases, eq(cases.id, caseDocuments.caseId))
        .innerJoin(documents, eq(documents.id, caseDocuments.documentId))
        .where(and(eq(caseDocuments.companyId, companyId), inArray(caseDocuments.id, cellIds))),
      db
        .select({
          id: deepDiveFindings.id,
          gifDocumentId: deepDiveFindings.gifDocumentId,
          statement: deepDiveFindings.statement,
          status: deepDiveFindings.status,
        })
        .from(deepDiveFindings)
        .where(and(
          eq(deepDiveFindings.companyId, companyId),
          inArray(deepDiveFindings.gifDocumentId, cellIds),
          inArray(deepDiveFindings.status, ["proposed", "validated"]),
        ))
        .orderBy(asc(deepDiveFindings.createdAt)),
      db
        .select({
          questionId: deepDiveSessionQuestions.id,
          sessionId: deepDiveSessionQuestions.sessionId,
          gifDocumentId: deepDiveSessionQuestions.gifDocumentId,
          sessionTitle: deepDiveSessions.title,
          answer: deepDiveSessionQuestions.answer,
          answeredAt: deepDiveSessionQuestions.answeredAt,
        })
        .from(deepDiveSessionQuestions)
        .innerJoin(deepDiveSessions, eq(deepDiveSessions.id, deepDiveSessionQuestions.sessionId))
        .where(and(
          eq(deepDiveSessionQuestions.companyId, companyId),
          inArray(deepDiveSessionQuestions.gifDocumentId, cellIds),
          isNotNull(deepDiveSessionQuestions.answer),
          ne(sql`btrim(${deepDiveSessionQuestions.answer})`, ""),
        ))
        .orderBy(desc(deepDiveSessionQuestions.answeredAt)),
    ]);
    for (const cell of cells) {
      const gifKey = GIF_KEY_BY_DOCUMENT_KEY.get(cell.key) ?? "current-state";
      const streamFields = readDeepDiveStreamFields((cell.streamKey ?? "") as DeepDiveStreamKey, cell.fields);
      const text = cell.body.trim();
      known.set(cell.id, {
        gifKey,
        knowledge: streamFields.knowledge[gifKey],
        cellText: text && !STUB_BODIES.has(text) ? text : null,
        findings: cellFindings
          .filter((finding) => finding.gifDocumentId === cell.id)
          .map((finding) => ({ id: finding.id, statement: finding.statement, status: finding.status as DeepDiveFindingStatus })),
        earlierAnswers: answers
          .filter((answer) => answer.gifDocumentId === cell.id)
          .map((answer) => ({
            questionId: answer.questionId,
            sessionId: answer.sessionId,
            sessionTitle: answer.sessionTitle,
            answer: answer.answer!,
            answeredAt: answer.answeredAt!.toISOString(),
          })),
      });
    }
    return known;
  }

  function summary(row: SessionRow, questions: { answer: string | null }[]): DeepDiveSessionSummary {
    return {
      id: row.id,
      companyId: row.companyId,
      title: row.title,
      status: row.status as DeepDiveSessionStatus,
      visibility: row.visibility as DeepDiveVisibility,
      plannedFor: row.plannedFor?.toISOString() ?? null,
      startedAt: row.startedAt?.toISOString() ?? null,
      closedAt: row.closedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      questionCount: questions.length,
      answeredCount: questions.filter((question) => !!question.answer?.trim()).length,
    };
  }

  async function getOne(sessionId: string): Promise<DeepDiveSession> {
    const row = await loadSession(sessionId);
    const questions = await db
      .select()
      .from(deepDiveSessionQuestions)
      .where(eq(deepDiveSessionQuestions.sessionId, sessionId))
      .orderBy(asc(deepDiveSessionQuestions.position), asc(deepDiveSessionQuestions.createdAt));
    const known = await knownFor(row.companyId, questions);
    return {
      ...summary(row, questions),
      questions: questions.map((question): DeepDiveSessionQuestion => {
        const cell = known.get(question.gifDocumentId);
        return {
          id: question.id,
          sessionId: question.sessionId,
          position: question.position,
          streamCaseId: question.streamCaseId,
          gifKey: cell?.gifKey ?? "current-state",
          gifDocumentId: question.gifDocumentId,
          prompt: question.prompt,
          answer: question.answer,
          answeredAt: question.answeredAt?.toISOString() ?? null,
          answeredByUserId: question.answeredByUserId,
          answeredByAgentId: question.answeredByAgentId,
          findingId: question.findingId,
          known: {
            knowledge: cell?.knowledge ?? "unknown",
            cellText: cell?.cellText ?? null,
            findings: cell?.findings ?? [],
            // Not this question's own answer: only what is known from elsewhere.
            earlierAnswers: (cell?.earlierAnswers ?? []).filter((answer) => answer.sessionId !== question.sessionId),
          },
        };
      }),
    };
  }

  async function nextPosition(sessionId: string): Promise<number> {
    const [row] = await db
      .select({ max: sql<number | null>`max(${deepDiveSessionQuestions.position})` })
      .from(deepDiveSessionQuestions)
      .where(eq(deepDiveSessionQuestions.sessionId, sessionId));
    return (row?.max ?? -1) + 1;
  }

  return {
    companyOfSession: async (sessionId: string) => (await loadSession(sessionId)).companyId,
    companyOfQuestion: async (questionId: string) => (await loadQuestion(questionId)).companyId,
    sessionOfQuestion: async (questionId: string) => (await loadQuestion(questionId)).sessionId,

    get: getOne,

    list: async (companyId: string): Promise<DeepDiveSessionSummary[]> => {
      const rows = await db
        .select()
        .from(deepDiveSessions)
        .where(eq(deepDiveSessions.companyId, companyId))
        .orderBy(desc(deepDiveSessions.createdAt), desc(deepDiveSessions.id));
      if (rows.length === 0) return [];
      const questions = await db
        .select({ sessionId: deepDiveSessionQuestions.sessionId, answer: deepDiveSessionQuestions.answer })
        .from(deepDiveSessionQuestions)
        .where(inArray(deepDiveSessionQuestions.sessionId, rows.map((row) => row.id)));
      return rows.map((row) => summary(row, questions.filter((question) => question.sessionId === row.id)));
    },

    plan: async (companyId: string, input: PlanDeepDiveSession, actor: DeepDiveSessionActor) => {
      const cells: Awaited<ReturnType<typeof resolveCell>>[] = [];
      for (const question of input.questions ?? []) cells.push(await resolveCell(companyId, question));
      const id = await db.transaction(async (tx) => {
        const [row] = await tx.insert(deepDiveSessions).values({
          companyId,
          title: input.title,
          plannedFor: input.plannedFor ? new Date(input.plannedFor) : null,
          createdByAgentId: actor.type === "agent" ? actor.agentId : null,
          createdByUserId: actor.type === "user" ? actor.userId : null,
        }).returning({ id: deepDiveSessions.id });
        if (cells.length > 0) {
          await tx.insert(deepDiveSessionQuestions).values(
            cells.map((cell, position) => ({ companyId, sessionId: row!.id, position, ...cell })),
          );
        }
        return row!.id;
      }).catch((error) => {
        throw asSessionError(error);
      });
      return getOne(id);
    },

    update: async (sessionId: string, input: UpdateDeepDiveSession, actor: DeepDiveSessionActor) => {
      const row = await loadSession(sessionId);
      if (input.visibility !== undefined && actor.type !== "user") {
        throw forbidden("Only a person can share or unshare a session");
      }
      const changesPlan = input.title !== undefined || input.plannedFor !== undefined;
      if (changesPlan && row.status === "closed") throw notAllowed("closed", "change its title or date");
      await db
        .update(deepDiveSessions)
        .set({
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.plannedFor !== undefined ? { plannedFor: input.plannedFor ? new Date(input.plannedFor) : null } : {}),
          ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
          updatedAt: new Date(),
        })
        .where(eq(deepDiveSessions.id, sessionId))
        .catch((error) => {
          throw asSessionError(error);
        });
      return getOne(sessionId);
    },

    /** Planned -> Live. A session with no questions has nothing to run. */
    start: async (sessionId: string) => {
      const row = await loadSession(sessionId);
      if (!deepDiveSessionNextSteps(row.status as DeepDiveSessionStatus).start) {
        throw notAllowed(row.status as DeepDiveSessionStatus, "start it");
      }
      const [count] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(deepDiveSessionQuestions)
        .where(eq(deepDiveSessionQuestions.sessionId, sessionId));
      if (!count?.n) throw unprocessable("Add at least one question before you start the session");
      const now = new Date();
      await db
        .update(deepDiveSessions)
        .set({ status: "live", startedAt: now, updatedAt: now })
        .where(and(eq(deepDiveSessions.id, sessionId), eq(deepDiveSessions.status, "planned")));
      return getOne(sessionId);
    },

    /** Live -> Closed. Unanswered questions stay unanswered on record. */
    close: async (sessionId: string) => {
      const row = await loadSession(sessionId);
      if (!deepDiveSessionNextSteps(row.status as DeepDiveSessionStatus).close) {
        throw notAllowed(row.status as DeepDiveSessionStatus, "close it");
      }
      const now = new Date();
      await db
        .update(deepDiveSessions)
        .set({ status: "closed", closedAt: now, updatedAt: now })
        .where(and(eq(deepDiveSessions.id, sessionId), eq(deepDiveSessions.status, "live")));
      return getOne(sessionId);
    },

    addQuestion: async (sessionId: string, input: AddDeepDiveSessionQuestion) => {
      const row = await loadSession(sessionId);
      if (!deepDiveSessionNextSteps(row.status as DeepDiveSessionStatus).addQuestion) {
        throw notAllowed(row.status as DeepDiveSessionStatus, "add questions");
      }
      const position = await nextPosition(sessionId);
      if (position >= DEEP_DIVE_SESSION_MAX_QUESTIONS) {
        throw unprocessable(`A session holds at most ${DEEP_DIVE_SESSION_MAX_QUESTIONS} questions`);
      }
      const cell = await resolveCell(row.companyId, input);
      await db
        .insert(deepDiveSessionQuestions)
        .values({ companyId: row.companyId, sessionId, position, ...cell })
        .catch((error) => {
          throw asSessionError(error);
        });
      return getOne(sessionId);
    },

    updateQuestion: async (questionId: string, input: UpdateDeepDiveSessionQuestion, actor: DeepDiveSessionActor) => {
      const question = await loadQuestion(questionId);
      const session = await loadSession(question.sessionId);
      const steps = deepDiveSessionNextSteps(session.status as DeepDiveSessionStatus);
      if (input.prompt !== undefined && !steps.editPrompt) {
        throw notAllowed(session.status as DeepDiveSessionStatus, "change the question");
      }
      if (input.answer !== undefined && !steps.answer) {
        throw notAllowed(session.status as DeepDiveSessionStatus, "answer it");
      }
      if (input.answer !== undefined && question.findingId) {
        throw conflict("This answer is already a finding, so it is kept as it was");
      }
      const answer = input.answer === undefined ? undefined : input.answer?.trim() ? input.answer.trim() : null;
      const now = new Date();
      await db
        .update(deepDiveSessionQuestions)
        .set({
          ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
          ...(answer !== undefined
            ? {
                answer,
                answeredAt: answer ? now : null,
                answeredByUserId: answer && actor.type === "user" ? actor.userId : null,
                answeredByAgentId: answer && actor.type === "agent" ? actor.agentId : null,
              }
            : {}),
          updatedAt: now,
        })
        .where(eq(deepDiveSessionQuestions.id, questionId))
        .catch((error) => {
          throw asSessionError(error);
        });
      return getOne(question.sessionId);
    },

    removeQuestion: async (questionId: string) => {
      const question = await loadQuestion(questionId);
      const session = await loadSession(question.sessionId);
      if (!deepDiveSessionNextSteps(session.status as DeepDiveSessionStatus).removeQuestion) {
        throw notAllowed(session.status as DeepDiveSessionStatus, "remove questions");
      }
      await db.delete(deepDiveSessionQuestions).where(eq(deepDiveSessionQuestions.id, questionId)).catch((error) => {
        throw asSessionError(error);
      });
      return getOne(question.sessionId);
    },

    /**
     * Propose a finding from an answer, in the question's stream and GIF cell,
     * and link the answer to it. Once per answer.
     */
    answerToFinding: async (questionId: string, input: AnswerToDeepDiveFinding, actor: DeepDiveSessionActor) => {
      const question = await loadQuestion(questionId);
      if (question.findingId) throw conflict("This answer is already a finding");
      if (!question.answer?.trim()) throw unprocessable("Answer the question before you turn it into a finding");
      const cell = await db
        .select({ key: caseDocuments.key })
        .from(caseDocuments)
        .where(eq(caseDocuments.id, question.gifDocumentId))
        .then((rows) => rows[0] ?? null);
      const gifKey = cell ? GIF_KEY_BY_DOCUMENT_KEY.get(cell.key) : undefined;
      if (!gifKey) throw unprocessable("The question's GIF cell is gone");
      const finding = await findings.propose(
        question.companyId,
        {
          streamCaseId: question.streamCaseId,
          gifKey,
          statement: input.statement ?? question.answer,
          evidenceIds: input.evidenceIds,
        },
        actor,
      );
      const linked = await db
        .update(deepDiveSessionQuestions)
        .set({ findingId: finding.id, updatedAt: new Date() })
        .where(and(eq(deepDiveSessionQuestions.id, questionId), sql`${deepDiveSessionQuestions.findingId} is null`))
        .returning({ id: deepDiveSessionQuestions.id })
        .catch((error) => {
          throw asSessionError(error);
        });
      if (linked.length === 0) throw conflict("This answer became a finding at the same moment; reload the session");
      return { finding, session: await getOne(question.sessionId) };
    },
  };
}
