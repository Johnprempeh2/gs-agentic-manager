import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  deepDiveInterviewInvites,
  deepDiveInterviewRounds,
  deepDiveInterviewSets,
  deepDiveOrgUnits,
  deepDivePeople,
} from "@greatstone/db";
import {
  DEEP_DIVE_INTERVIEW_LABELS,
  GS_INTERVIEW_ROUND_SCHEMA,
  deepDiveInterviewReadiness,
  emptyDeepDiveInterviewStatusCounts,
  readDeepDiveInterviewContextPack,
  type DeepDiveInterviewKnownItem,
  type DeepDiveInterviewProgress,
  type DeepDiveInterviewProgressPerson,
  type DeepDiveInterviewProgressTeam,
  type DeepDiveInterviewQuestion,
  type GsInterviewInvitePerson,
  type GsInterviewRoundPayload,
  type InviteDeepDiveInterviewPeople,
  type OpenDeepDiveInterviewRound,
  type SendDeepDiveInterviewInvites,
} from "@greatstone/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import type { DeepDiveInterviewActor } from "./deep-dive-interviews.js";
import { WebsiteBridgeError, type WebsiteBridgeActor } from "./website/data-bridge-client.js";
import type { InterviewBridge, InterviewBridgeScope } from "./website/interview-bridge.js";

// Parallel Interview invites and live progress (GRE-2665), slice 2 of GRE-2611.
// A person opens the round on the website once every question set is approved,
// then invites people: each invite names an existing website user, or asks the
// website to hold an invitation by email until the person makes their account.
// GSAM keeps only the website employee, user and organisation ids per invite
// (and which set they get); names, emails and status are read live through
// gs-interview-v1 and never stored.

type RoundRow = typeof deepDiveInterviewRounds.$inferSelect;
type SetRow = typeof deepDiveInterviewSets.$inferSelect;
type InviteRow = typeof deepDiveInterviewInvites.$inferSelect;

const MODE_ON_SITE = { per_team: "team", per_person: "person" } as const;
const NO_TEAM = "No team";

/** One set as the interviewer reads it: what is known (never asked), then the questions in order. */
export function renderDeepDiveInterviewSet(set: Pick<SetRow, "questions" | "known">): string {
  const known = set.known as DeepDiveInterviewKnownItem[];
  const questions = set.questions as DeepDiveInterviewQuestion[];
  const lines: string[] = [];
  if (known.length > 0) {
    lines.push("Already known, do not ask:");
    for (const item of known) lines.push(`- ${item.text}`);
    lines.push("");
  }
  lines.push("Questions:");
  questions.forEach((question, index) => lines.push(`${index + 1}. ${question.prompt}`));
  return lines.join("\n");
}

function onlyPeople(actor: DeepDiveInterviewActor, action: string) {
  if (actor.type !== "user") throw forbidden(`Only a person ${action}`);
}

function notReady(sets: Pick<SetRow, "status">[]) {
  const readiness = deepDiveInterviewReadiness({ sets });
  if (readiness.ready) return null;
  return conflict(
    readiness.total === 0
      ? "Invites go out only after a person approves a question set for each team or person. There are no question sets yet."
      : `Invites go out only after a person approves every question set: ${readiness.approved} of ${readiness.total} approved.`,
  );
}

export function deepDiveInterviewInvitesService(db: Db, bridge: InterviewBridge) {
  async function loadRound(roundId: string): Promise<RoundRow> {
    const row = await db.select().from(deepDiveInterviewRounds).where(eq(deepDiveInterviewRounds.id, roundId)).then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Interview round not found");
    return row;
  }

  const scopeOf = (round: RoundRow): InterviewBridgeScope => ({
    companyId: round.companyId,
    organisationId: round.websiteOrganisationId,
    roundId: round.id,
  });

  function setsOf(round: RoundRow) {
    return db
      .select()
      .from(deepDiveInterviewSets)
      .where(and(eq(deepDiveInterviewSets.companyId, round.companyId), eq(deepDiveInterviewSets.roundId, round.id)))
      .orderBy(asc(deepDiveInterviewSets.createdAt));
  }

  function invitesOf(round: RoundRow) {
    return db
      .select()
      .from(deepDiveInterviewInvites)
      .where(and(eq(deepDiveInterviewInvites.companyId, round.companyId), eq(deepDiveInterviewInvites.roundId, round.id)))
      .orderBy(asc(deepDiveInterviewInvites.createdAt));
  }

  function unitsOf(companyId: string) {
    return db
      .select({ id: deepDiveOrgUnits.id, name: deepDiveOrgUnits.name, unitType: deepDiveOrgUnits.unitType, parentId: deepDiveOrgUnits.parentId })
      .from(deepDiveOrgUnits)
      .where(eq(deepDiveOrgUnits.companyId, companyId))
      .orderBy(asc(deepDiveOrgUnits.position), asc(deepDiveOrgUnits.name));
  }

  /**
   * The round as the website stores it. Teams are the board's units (not the
   * whole company). The context pack carries each team's approved questions
   * (per team) or each invited person's (per person, keyed by the website user
   * id). There is no client name: the website uses the organisation's own.
   */
  async function payloadOf(round: RoundRow, sets: SetRow[], people: Record<string, string>): Promise<GsInterviewRoundPayload> {
    const units = (await unitsOf(round.companyId)).filter((unit) => unit.unitType !== "company");
    const sent = new Set(units.map((unit) => unit.id));
    const unitPack: Record<string, string> = {};
    if (round.mode === "per_team") {
      for (const set of sets) if (set.unitId) unitPack[set.unitId] = renderDeepDiveInterviewSet(set);
    }
    return {
      schema: GS_INTERVIEW_ROUND_SCHEMA,
      sponsor: null,
      mode: MODE_ON_SITE[round.mode],
      targetMinutes: round.targetMinutes,
      status: "open",
      seatTotal: round.seatTotal ?? 0,
      enrol: {
        enabled: true,
        expiresAt: null,
        allowedEmailDomains: round.allowedEmailDomains,
        defaultUnitId: null,
        rotateToken: false,
      },
      units: units.map((unit) => ({
        id: unit.id,
        parentId: unit.parentId && sent.has(unit.parentId) ? unit.parentId : null,
        name: unit.name,
        kind: unit.unitType,
      })),
      contextPack: { ...readDeepDiveInterviewContextPack(round.contextPack), units: unitPack, people },
    };
  }

  /**
   * Per person: each invited person's own set, keyed by the website user id, or
   * by their lower-case email (read live, never stored) until they have an account.
   */
  async function personPack(round: RoundRow, sets: SetRow[], actor: WebsiteBridgeActor) {
    const [people, invites] = await Promise.all([bridge.people(scopeOf(round), actor), invitesOf(round)]);
    const setById = new Map(sets.map((set) => [set.id, set]));
    const setByEmployee = new Map(invites.map((invite) => [invite.websiteEmployeeId, invite.setId ? setById.get(invite.setId) : undefined]));
    const pack: Record<string, string> = {};
    for (const person of people) {
      const set = setByEmployee.get(person.employeeId);
      const key = person.userId ?? person.email.toLowerCase();
      if (set && key) pack[key] = renderDeepDiveInterviewSet(set);
    }
    return pack;
  }

  /** An invitation held by email becomes the person's user id once they make their account. */
  async function linkJoined(round: RoundRow, onSite: { employeeId: string; userId: string | null }[], invites: InviteRow[]) {
    const joined = new Map(onSite.flatMap((p) => (p.userId ? [[p.employeeId, p.userId] as const] : [])));
    for (const invite of invites) {
      const userId = joined.get(invite.websiteEmployeeId);
      if (invite.websiteUserId !== null || !userId) continue;
      await db.update(deepDiveInterviewInvites).set({ websiteUserId: userId, updatedAt: new Date() })
        .where(and(eq(deepDiveInterviewInvites.id, invite.id), isNull(deepDiveInterviewInvites.websiteUserId)));
      invite.websiteUserId = userId;
    }
  }

  async function progress(companyId: string, actor: WebsiteBridgeActor): Promise<DeepDiveInterviewProgress> {
    const round = await db.select().from(deepDiveInterviewRounds).where(eq(deepDiveInterviewRounds.companyId, companyId)).then((rows) => rows[0] ?? null);
    const base: DeepDiveInterviewProgress = {
      roundId: round?.id ?? null,
      status: round?.status ?? null,
      websiteOrganisationId: round?.websiteOrganisationId ?? null,
      allowedEmailDomains: round?.allowedEmailDomains ?? [],
      seatTotal: round?.seatTotal ?? null,
      readAt: null,
      total: 0,
      counts: emptyDeepDiveInterviewStatusCounts(),
      teams: [],
      people: [],
    };
    if (!round || round.status === "setup") return base;

    const [onSite, invites, units] = await Promise.all([bridge.people(scopeOf(round), actor), invitesOf(round), unitsOf(companyId)]);
    await linkJoined(round, onSite, invites);
    const inviteByEmployee = new Map(invites.map((invite) => [invite.websiteEmployeeId, invite]));
    const unitName = new Map(units.map((unit) => [unit.id, unit.name]));
    const unitOrder = new Map(units.map((unit, index) => [unit.id, index]));

    const people: DeepDiveInterviewProgressPerson[] = onSite.map((person) => {
      const invite = inviteByEmployee.get(person.employeeId);
      return {
        websiteEmployeeId: person.employeeId,
        websiteUserId: person.userId,
        name: person.name,
        email: person.email,
        roleTitle: person.roleTitle,
        unitId: person.unitId,
        teamName: (person.unitId && unitName.get(person.unitId)) || NO_TEAM,
        setId: invite?.setId ?? null,
        status: person.status,
        startedAt: person.sessionStartedAt,
        endedAt: person.sessionEndedAt,
        completionScore: person.completionScore,
        invitedAt: invite?.createdAt.toISOString() ?? null,
        sentCount: invite?.sentCount ?? 0,
        lastSentAt: invite?.lastSentAt.toISOString() ?? null,
        remindedCount: invite?.remindedCount ?? 0,
        lastRemindedAt: invite?.lastRemindedAt?.toISOString() ?? null,
      };
    });
    const order = (unitId: string | null) => (unitId === null ? Number.MAX_SAFE_INTEGER : unitOrder.get(unitId) ?? Number.MAX_SAFE_INTEGER - 1);
    people.sort((a, b) => order(a.unitId) - order(b.unitId) || a.name.localeCompare(b.name));

    const teams = new Map<string | null, DeepDiveInterviewProgressTeam>();
    const counts = emptyDeepDiveInterviewStatusCounts();
    for (const person of people) {
      const team = teams.get(person.unitId) ?? { unitId: person.unitId, name: person.teamName, total: 0, counts: emptyDeepDiveInterviewStatusCounts() };
      team.total += 1;
      team.counts[person.status] += 1;
      counts[person.status] += 1;
      teams.set(person.unitId, team);
    }
    return { ...base, readAt: new Date().toISOString(), total: people.length, counts, teams: [...teams.values()], people };
  }

  /** Open the round on the website. Refused until a person has approved every question set. */
  async function open(roundId: string, input: OpenDeepDiveInterviewRound, actor: DeepDiveInterviewActor, bridgeActor: WebsiteBridgeActor) {
    onlyPeople(actor, "opens the round and sends invites");
    const round = await loadRound(roundId);
    if (round.status !== "setup") throw conflict(`The round is ${DEEP_DIVE_INTERVIEW_LABELS[round.status]} already`);
    const sets = await setsOf(round);
    const refusal = notReady(sets);
    if (refusal) throw refusal;
    const ready: RoundRow = { ...round, allowedEmailDomains: [...new Set(input.allowedEmailDomains)], seatTotal: input.seatTotal };
    // The website first: if it refuses, nothing changes in GSAM.
    await bridge.pushRound(scopeOf(ready), await payloadOf(ready, sets, {}), bridgeActor);
    const at = new Date();
    await db.update(deepDiveInterviewRounds).set({
      status: "open",
      allowedEmailDomains: ready.allowedEmailDomains,
      seatTotal: ready.seatTotal,
      openedAt: at,
      updatedAt: at,
    }).where(eq(deepDiveInterviewRounds.id, roundId));
    return progress(round.companyId, bridgeActor);
  }

  async function invite(roundId: string, input: InviteDeepDiveInterviewPeople, actor: DeepDiveInterviewActor, bridgeActor: WebsiteBridgeActor) {
    onlyPeople(actor, "sends invites");
    const round = await loadRound(roundId);
    const sets = await setsOf(round);
    const refusal = notReady(sets);
    if (refusal) throw refusal;
    if (round.status === "setup") throw conflict("Open the round on the website before you invite anyone");
    if (round.status === "closed") throw conflict("The round is closed, so you cannot invite anyone");

    const boardIds = input.people.flatMap((p) => (p.boardPersonId ? [p.boardPersonId] : []));
    const board = boardIds.length === 0 ? [] : await db
      .select({ id: deepDivePeople.id, name: deepDivePeople.name, role: deepDivePeople.role, unitId: deepDivePeople.unitId })
      .from(deepDivePeople)
      .where(and(eq(deepDivePeople.companyId, round.companyId), eq(deepDivePeople.side, "client"), inArray(deepDivePeople.id, boardIds)));
    const boardById = new Map(board.map((person) => [person.id, person]));
    const setByUnit = new Map(sets.flatMap((set) => (set.unitId ? [[set.unitId, set] as const] : [])));
    const setByPerson = new Map(sets.flatMap((set) => (set.personId ? [[set.personId, set] as const] : [])));

    const outgoing: { person: GsInterviewInvitePerson; set: SetRow }[] = input.people.map((invitee, index) => {
      const fromBoard = invitee.boardPersonId ? boardById.get(invitee.boardPersonId) : undefined;
      if (invitee.boardPersonId && !fromBoard) throw unprocessable(`Person ${index + 1} is not one of this client's people on the organisation board`);
      const name = invitee.name ?? fromBoard!.name;
      let set: SetRow | undefined;
      let unitId: string | null;
      if (round.mode === "per_team") {
        unitId = invitee.unitId ?? fromBoard?.unitId ?? null;
        set = unitId ? setByUnit.get(unitId) : undefined;
        if (!set) throw unprocessable(`${name}: choose a team that has a question set`);
      } else {
        if (!fromBoard) throw unprocessable(`${name}: in a per-person round, invite a person from the board who has a question set`);
        set = setByPerson.get(fromBoard.id);
        if (!set) throw unprocessable(`${name} has no question set`);
        unitId = invitee.unitId ?? fromBoard.unitId ?? null;
      }
      return {
        set,
        person: {
          ...(invitee.email ? { email: invitee.email } : { userId: invitee.websiteUserId! }),
          name,
          roleTitle: invitee.roleTitle ?? fromBoard?.role ?? "",
          unitId,
          portalRole: "employee",
        },
      };
    });

    const answer = await bridge.invite(scopeOf(round), outgoing.map((o) => o.person), bridgeActor);
    if (answer.invited.length !== outgoing.length) {
      throw new WebsiteBridgeError("bad_response", 200, `invited ${answer.invited.length} of ${outgoing.length}`);
    }
    if (answer.invited.some((row) => row.organisationId !== undefined && row.organisationId !== round.websiteOrganisationId)) {
      throw new WebsiteBridgeError("bad_response", 200, "invites answered for another organisation");
    }
    // Only website ids are kept. A person already on the round keeps their row and counts;
    // the user id is null until someone invited by email makes their account.
    await db.insert(deepDiveInterviewInvites).values(answer.invited.map((row, index) => ({
      companyId: round.companyId,
      roundId: round.id,
      websiteOrganisationId: round.websiteOrganisationId,
      websiteEmployeeId: row.employeeId,
      websiteUserId: row.userId,
      setId: outgoing[index]!.set.id,
      createdByAgentId: null,
      createdByUserId: actor.type === "user" ? actor.userId : null,
    }))).onConflictDoUpdate({
      target: [deepDiveInterviewInvites.roundId, deepDiveInterviewInvites.websiteEmployeeId],
      set: {
        setId: sql`excluded.set_id`,
        websiteUserId: sql`coalesce(excluded.website_user_id, ${deepDiveInterviewInvites.websiteUserId})`,
        updatedAt: new Date(),
      },
    });

    if (round.mode === "per_person") {
      // Each person's own questions reach the website under their employee id. Inviting again sends them again.
      await bridge.pushRound(scopeOf(round), await payloadOf(round, sets, await personPack(round, sets, bridgeActor)), bridgeActor);
    }
    return {
      invited: answer.invited.length,
      created: answer.invited.filter((row) => row.outcome === "created").length,
      emailed: answer.emailed,
      progress: await progress(round.companyId, bridgeActor),
    };
  }

  /** Email the join link again (not started) or a reminder (not finished). */
  async function send(roundId: string, input: SendDeepDiveInterviewInvites, actor: DeepDiveInterviewActor, bridgeActor: WebsiteBridgeActor) {
    onlyPeople(actor, "sends invites and reminders");
    const round = await loadRound(roundId);
    if (round.status !== "open") throw conflict(`The round is ${DEEP_DIVE_INTERVIEW_LABELS[round.status]}, so nothing can be sent`);
    const employeeIds = [...new Set(input.websiteEmployeeIds)];
    const known = await db
      .select({ id: deepDiveInterviewInvites.id, websiteEmployeeId: deepDiveInterviewInvites.websiteEmployeeId, websiteUserId: deepDiveInterviewInvites.websiteUserId })
      .from(deepDiveInterviewInvites)
      .where(and(eq(deepDiveInterviewInvites.roundId, round.id), inArray(deepDiveInterviewInvites.websiteEmployeeId, employeeIds)));
    if (known.length !== employeeIds.length) throw unprocessable("Send only to people this round invited");
    // By user id once the person has an account; by employee id while the invitation is held by email.
    const answer = await bridge.send(scopeOf(round), {
      kind: input.kind,
      userIds: known.flatMap((row) => (row.websiteUserId ? [row.websiteUserId] : [])),
      employeeIds: known.flatMap((row) => (row.websiteUserId ? [] : [row.websiteEmployeeId])),
    }, bridgeActor);
    const at = new Date();
    await db.update(deepDiveInterviewInvites).set(input.kind === "resend"
      ? { sentCount: sql`${deepDiveInterviewInvites.sentCount} + 1`, lastSentAt: at, updatedAt: at }
      : { remindedCount: sql`${deepDiveInterviewInvites.remindedCount} + 1`, lastRemindedAt: at, updatedAt: at })
      .where(inArray(deepDiveInterviewInvites.id, known.map((row) => row.id)));
    return { emailed: answer.emailed, skipped: answer.skipped, progress: await progress(round.companyId, bridgeActor) };
  }

  return { progress, open, invite, send };
}
