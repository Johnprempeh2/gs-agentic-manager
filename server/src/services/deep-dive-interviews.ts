import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  caseDocuments,
  cases,
  deepDiveFindings,
  deepDiveInterviewRounds,
  deepDiveInterviewSets,
  deepDiveOrgUnits,
  deepDivePeople,
  documents,
} from "@greatstone/db";
import {
  DEEP_DIVE_CASE_TYPES,
  DEEP_DIVE_GIF,
  DEEP_DIVE_INTERVIEW_DEFAULT_MINUTES,
  DEEP_DIVE_INTERVIEW_LABELS,
  DEEP_DIVE_STREAMS,
  deepDiveGifStubBody,
  draftDeepDiveInterviewSet,
  readDeepDiveInterviewContextPack,
  readDeepDiveStreamFields,
  type CreateDeepDiveInterviewRound,
  type DeepDiveFindingStatus,
  type DeepDiveInterviewCell,
  type DeepDiveInterviewKnownItem,
  type DeepDiveInterviewQuestion,
  type DeepDiveInterviewRound,
  type DeepDiveInterviewRoundStatus,
  type DeepDiveInterviewRoundView,
  type DeepDiveInterviewSet,
  type DeepDiveInterviewTarget,
  type DeepDiveStreamKey,
  type DraftDeepDiveInterviewSet,
  type UpdateDeepDiveInterviewRound,
  type UpdateDeepDiveInterviewSet,
} from "@greatstone/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import type { DeepDiveFindingActor } from "./deep-dive-findings.js";

// Parallel Interview rounds (GRE-2611), slice 1: the round's setup, a question
// set per team or person drafted from what the Deep Dive already knows, and a
// person's approval of each set. Place the Known, validate the Indicated,
// investigate only the Unknown. The guard triggers in migration 0405 enforce
// the same rules for any writer; these checks answer first with a plain
// message. Invites, progress and results come in the next slices.

export type DeepDiveInterviewActor = DeepDiveFindingActor;

type RoundRow = typeof deepDiveInterviewRounds.$inferSelect;
type SetRow = typeof deepDiveInterviewSets.$inferSelect;

const STREAM_KEYS = new Set<string>(DEEP_DIVE_STREAMS.map((stream) => stream.key));
const STUB_BODIES = new Set(DEEP_DIVE_GIF.map((gif) => deepDiveGifStubBody(gif).trim()));
const UNIT_TYPE_LABEL: Record<string, string> = { company: "Company", division: "Division", department: "Department", team: "Team" };

function asInterviewError(error: unknown): unknown {
  const cause = ((error as { cause?: unknown })?.cause ?? error) as { code?: string; message?: string; constraint_name?: string };
  if (cause?.code === "23505") {
    if (cause.constraint_name === "deep_dive_interview_rounds_company_uq") return conflict("This Deep Dive already has its interview round");
    return conflict("This team or person already has a question set");
  }
  if (cause?.code === "23514" && cause.message) return unprocessable(cause.message);
  return error;
}

async function write<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    throw asInterviewError(error);
  }
}

function notInSetup(status: DeepDiveInterviewRoundStatus, action: string) {
  return conflict(`The round is ${DEEP_DIVE_INTERVIEW_LABELS[status]}, so you cannot ${action}`);
}

function actorColumns(actor: DeepDiveInterviewActor, prefix: "created" | "drafted") {
  const agentId = actor.type === "agent" ? actor.agentId : null;
  const userId = actor.type === "user" ? actor.userId : null;
  return prefix === "created"
    ? { createdByAgentId: agentId, createdByUserId: userId }
    : { draftedByAgentId: agentId, draftedByUserId: userId };
}

export function deepDiveInterviewsService(db: Db) {
  async function loadRound(roundId: string): Promise<RoundRow> {
    const row = await db.select().from(deepDiveInterviewRounds).where(eq(deepDiveInterviewRounds.id, roundId)).then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Interview round not found");
    return row;
  }

  async function loadSet(setId: string): Promise<SetRow> {
    const row = await db.select().from(deepDiveInterviewSets).where(eq(deepDiveInterviewSets.id, setId)).then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Question set not found");
    return row;
  }

  /** Teams and people on the company's organisation board, as interview targets. */
  async function targets(companyId: string) {
    const [units, people] = await Promise.all([
      db
        .select({ id: deepDiveOrgUnits.id, name: deepDiveOrgUnits.name, unitType: deepDiveOrgUnits.unitType })
        .from(deepDiveOrgUnits)
        .where(eq(deepDiveOrgUnits.companyId, companyId))
        .orderBy(asc(deepDiveOrgUnits.position), asc(deepDiveOrgUnits.name)),
      db
        .select({ id: deepDivePeople.id, name: deepDivePeople.name, role: deepDivePeople.role, side: deepDivePeople.side })
        .from(deepDivePeople)
        .where(eq(deepDivePeople.companyId, companyId))
        .orderBy(asc(deepDivePeople.name)),
    ]);
    const unitTargets = new Map<string, DeepDiveInterviewTarget>(
      units
        // The whole company is not a team to interview.
        .filter((unit) => unit.unitType !== "company")
        .map((unit) => [unit.id, { kind: "unit", id: unit.id, name: unit.name, detail: UNIT_TYPE_LABEL[unit.unitType] ?? "Team" }]),
    );
    const personTargets = new Map<string, DeepDiveInterviewTarget>(
      people
        // Interviews are with the client's people, not Greatstone's or third parties.
        .filter((person) => person.side === "client")
        .map((person) => [person.id, { kind: "person", id: person.id, name: person.name, detail: person.role }]),
    );
    return { unitTargets, personTargets };
  }

  /** Every GIF cell of the company's streams, with what is already known about it. */
  async function cells(companyId: string): Promise<DeepDiveInterviewCell[]> {
    const streams = await db
      .select({ id: cases.id, key: cases.key, fields: cases.fields })
      .from(cases)
      .where(and(eq(cases.companyId, companyId), eq(cases.caseType, DEEP_DIVE_CASE_TYPES.stream)));
    const known = streams.filter((stream) => stream.key && STREAM_KEYS.has(stream.key));
    if (known.length === 0) return [];
    const streamIds = known.map((stream) => stream.id);
    const [docs, findings] = await Promise.all([
      db
        .select({ id: caseDocuments.id, caseId: caseDocuments.caseId, key: caseDocuments.key, body: documents.latestBody })
        .from(caseDocuments)
        .innerJoin(documents, eq(documents.id, caseDocuments.documentId))
        .where(and(eq(caseDocuments.companyId, companyId), inArray(caseDocuments.caseId, streamIds))),
      db
        .select({ streamCaseId: deepDiveFindings.streamCaseId, gifDocumentId: deepDiveFindings.gifDocumentId, statement: deepDiveFindings.statement, status: deepDiveFindings.status })
        .from(deepDiveFindings)
        .where(and(
          eq(deepDiveFindings.companyId, companyId),
          inArray(deepDiveFindings.streamCaseId, streamIds),
          inArray(deepDiveFindings.status, ["proposed", "validated"]),
        ))
        .orderBy(asc(deepDiveFindings.createdAt)),
    ]);
    const out: DeepDiveInterviewCell[] = [];
    for (const stream of known) {
      const streamKey = stream.key as DeepDiveStreamKey;
      const fields = readDeepDiveStreamFields(streamKey, stream.fields);
      for (const gif of DEEP_DIVE_GIF) {
        const doc = docs.find((d) => d.caseId === stream.id && d.key === gif.documentKey);
        const text = doc?.body.trim() ?? "";
        out.push({
          streamKey,
          gifKey: gif.key,
          depth: fields.depth,
          knowledge: fields.knowledge[gif.key],
          cellText: text && !STUB_BODIES.has(text) ? text : null,
          findings: doc
            ? findings
                .filter((f) => f.gifDocumentId === doc.id)
                .map((f) => ({ statement: f.statement, status: f.status as DeepDiveFindingStatus }))
            : [],
        });
      }
    }
    return out;
  }

  function setOut(row: SetRow, target: DeepDiveInterviewTarget): DeepDiveInterviewSet {
    return {
      id: row.id,
      roundId: row.roundId,
      target,
      status: row.status,
      questions: row.questions as DeepDiveInterviewQuestion[],
      known: row.known as DeepDiveInterviewKnownItem[],
      leftOut: row.leftOut,
      approvedByUserId: row.approvedByUserId,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      draftedByAgentId: row.draftedByAgentId,
      draftedByUserId: row.draftedByUserId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function view(companyId: string): Promise<DeepDiveInterviewRoundView> {
    const [round, { unitTargets, personTargets }] = await Promise.all([
      db.select().from(deepDiveInterviewRounds).where(eq(deepDiveInterviewRounds.companyId, companyId)).then((rows) => rows[0] ?? null),
      targets(companyId),
    ]);
    const pool = round?.mode === "per_person" ? personTargets : unitTargets;
    if (!round) return { round: null, available: [...unitTargets.values(), ...personTargets.values()] };
    const sets = await db
      .select()
      .from(deepDiveInterviewSets)
      .where(and(eq(deepDiveInterviewSets.companyId, companyId), eq(deepDiveInterviewSets.roundId, round.id)))
      .orderBy(asc(deepDiveInterviewSets.createdAt));
    const taken = new Set(sets.map((set) => set.unitId ?? set.personId));
    const out: DeepDiveInterviewRound = {
      id: round.id,
      companyId: round.companyId,
      websiteOrganisationId: round.websiteOrganisationId,
      mode: round.mode,
      targetMinutes: round.targetMinutes,
      contextPack: readDeepDiveInterviewContextPack(round.contextPack),
      status: round.status,
      createdAt: round.createdAt.toISOString(),
      updatedAt: round.updatedAt.toISOString(),
      sets: sets.map((set) => {
        const target = set.unitId ? unitTargets.get(set.unitId) : personTargets.get(set.personId!);
        return setOut(set, target ?? { kind: set.unitId ? "unit" : "person", id: (set.unitId ?? set.personId)!, name: "Removed from the board", detail: "" });
      }),
    };
    return { round: out, available: [...pool.values()].filter((target) => !taken.has(target.id)) };
  }

  async function create(companyId: string, input: CreateDeepDiveInterviewRound, actor: DeepDiveInterviewActor) {
    await write(db.insert(deepDiveInterviewRounds).values({
      companyId,
      websiteOrganisationId: input.websiteOrganisationId,
      mode: input.mode,
      targetMinutes: input.targetMinutes ?? DEEP_DIVE_INTERVIEW_DEFAULT_MINUTES,
      contextPack: input.contextPack ?? {},
      ...actorColumns(actor, "created"),
    }));
    return view(companyId);
  }

  async function update(roundId: string, input: UpdateDeepDiveInterviewRound) {
    const round = await loadRound(roundId);
    if (round.status !== "setup") throw notInSetup(round.status, "change its setup");
    if (input.mode && input.mode !== round.mode) {
      const [existing] = await db.select({ id: deepDiveInterviewSets.id }).from(deepDiveInterviewSets).where(eq(deepDiveInterviewSets.roundId, roundId)).limit(1);
      if (existing) throw conflict("Remove the question sets before changing between per team and per person");
    }
    await write(db.update(deepDiveInterviewRounds).set({
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.targetMinutes !== undefined ? { targetMinutes: input.targetMinutes } : {}),
      ...(input.contextPack ? { contextPack: input.contextPack } : {}),
      updatedAt: new Date(),
    }).where(eq(deepDiveInterviewRounds.id, roundId)));
    return view(round.companyId);
  }

  async function targetFor(round: RoundRow, input: DraftDeepDiveInterviewSet): Promise<DeepDiveInterviewTarget> {
    const { unitTargets, personTargets } = await targets(round.companyId);
    if (round.mode === "per_team") {
      if (!input.unitId) throw unprocessable("This round runs per team: choose a team");
      const target = unitTargets.get(input.unitId);
      if (!target) throw unprocessable("Team not found on this company's organisation board");
      return target;
    }
    if (!input.personId) throw unprocessable("This round runs per person: choose a person");
    const target = personTargets.get(input.personId);
    if (!target) throw unprocessable("Person not found among this client's people on the organisation board");
    return target;
  }

  /** Draft a set for one team or person from what the Deep Dive knows now. */
  async function draftSet(roundId: string, input: DraftDeepDiveInterviewSet, actor: DeepDiveInterviewActor) {
    const round = await loadRound(roundId);
    if (round.status !== "setup") throw notInSetup(round.status, "add a question set");
    const target = await targetFor(round, input);
    const draft = draftDeepDiveInterviewSet({ cells: await cells(round.companyId), target, targetMinutes: round.targetMinutes });
    if (draft.questions.length === 0) {
      throw unprocessable("Every cell of the Deep Dive is Known, so there is nothing to ask. Add a question of your own after drafting, or mark a cell Indicated or Unknown.");
    }
    const [row] = await write(db.insert(deepDiveInterviewSets).values({
      companyId: round.companyId,
      roundId,
      unitId: target.kind === "unit" ? target.id : null,
      personId: target.kind === "person" ? target.id : null,
      questions: draft.questions,
      known: draft.known,
      leftOut: draft.leftOut,
      ...actorColumns(actor, "drafted"),
    }).returning());
    return { set: row!, view: await view(round.companyId) };
  }

  async function setInSetup(setId: string, action: string) {
    const set = await loadSet(setId);
    const round = await loadRound(set.roundId);
    if (round.status !== "setup") throw notInSetup(round.status, action);
    return { set, round };
  }

  /** Draft again from what is known now. The set goes back to Draft. */
  async function redraftSet(setId: string, actor: DeepDiveInterviewActor) {
    const { set, round } = await setInSetup(setId, "redraft its questions");
    const target = await targetFor(round, { unitId: set.unitId ?? undefined, personId: set.personId ?? undefined });
    const draft = draftDeepDiveInterviewSet({ cells: await cells(round.companyId), target, targetMinutes: round.targetMinutes });
    if (draft.questions.length === 0) throw unprocessable("Every cell of the Deep Dive is Known, so there is nothing to ask");
    await write(db.update(deepDiveInterviewSets).set({
      questions: draft.questions,
      known: draft.known,
      leftOut: draft.leftOut,
      status: "draft",
      approvedAt: null,
      approvedByUserId: null,
      ...actorColumns(actor, "drafted"),
      updatedAt: new Date(),
    }).where(eq(deepDiveInterviewSets.id, setId)));
    return view(round.companyId);
  }

  /** A person's (or an agent's) edit of the list. Any edit needs approving again. */
  async function updateSet(setId: string, input: UpdateDeepDiveInterviewSet) {
    const { round } = await setInSetup(setId, "change its questions");
    await write(db.update(deepDiveInterviewSets).set({
      questions: input.questions,
      status: "draft",
      approvedAt: null,
      approvedByUserId: null,
      updatedAt: new Date(),
    }).where(eq(deepDiveInterviewSets.id, setId)));
    return view(round.companyId);
  }

  /** Only a person approves the questions that go out. */
  async function approveSet(setId: string, actor: DeepDiveInterviewActor) {
    if (actor.type !== "user") throw forbidden("Only a person approves interview questions");
    const { set, round } = await setInSetup(setId, "approve its questions");
    if (set.status === "approved") return view(round.companyId);
    if ((set.questions as unknown[]).length === 0) throw unprocessable("A question set needs at least one question");
    const at = new Date();
    await write(db.update(deepDiveInterviewSets).set({ status: "approved", approvedAt: at, approvedByUserId: actor.userId, updatedAt: at })
      .where(eq(deepDiveInterviewSets.id, setId)));
    return view(round.companyId);
  }

  async function removeSet(setId: string) {
    const { round } = await setInSetup(setId, "remove a question set");
    await write(db.delete(deepDiveInterviewSets).where(eq(deepDiveInterviewSets.id, setId)));
    return view(round.companyId);
  }

  async function companyOfRound(roundId: string) {
    return (await loadRound(roundId)).companyId;
  }

  async function companyOfSet(setId: string) {
    return (await loadSet(setId)).companyId;
  }

  return { view, create, update, draftSet, redraftSet, updateSet, approveSet, removeSet, companyOfRound, companyOfSet };
}
