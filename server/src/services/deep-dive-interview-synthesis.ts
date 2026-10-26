import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { deepDiveInterviewProposals, deepDiveInterviewRounds, deepDiveOrgUnits } from "@greatstone/db";
import {
  DEEP_DIVE_SYNTHESIS_RULES_VERSION,
  buildDeepDiveSynthesisEvidence,
  checkDeepDiveSynthesis,
  type DecideDeepDiveInterviewProposal,
  type DeepDiveInterviewProposal,
  type DeepDiveProposalSource,
  type DeepDiveSynthesisEvidence,
  type GsInterviewDetail,
  type SubmitDeepDiveSynthesis,
} from "@greatstone/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import type { DeepDiveInterviewActor } from "./deep-dive-interviews.js";
import type { WebsiteBridgeActor } from "./website/data-bridge-client.js";
import type { InterviewBridge, InterviewBridgeScope } from "./website/interview-bridge.js";

// Parallel Interview synthesis (GRE-2666), slice 3 of GRE-2611. The tool a
// GSAM agent calls once a round has interviews: it pulls them through
// gs-interview-v1 by organisation id, applies the rules in
// @greatstone/shared (two voices, quote gate, label merge, roll-up) and hands
// the agent the evidence. The agent writes the statements and submits them;
// the tool checks them against fresh evidence and writes only Proposed,
// Internal rows. A person accepts or rejects each one.
//
// Raw answers never reach the database: the bridge drops the turns while
// parsing, and a row keeps only a statement, a quote the gate allowed and
// website ids. Each call first applies the website's withdrawals.

type RoundRow = typeof deepDiveInterviewRounds.$inferSelect;
type ProposalRow = typeof deepDiveInterviewProposals.$inferSelect;

/** Interviews read from the website at once. */
const READ_AT_ONCE = 5;
const NO_ROLE = "Role not recorded";

export function deepDiveInterviewSynthesisService(db: Db, bridge: InterviewBridge) {
  async function loadRound(roundId: string): Promise<RoundRow> {
    const row = await db.select().from(deepDiveInterviewRounds).where(eq(deepDiveInterviewRounds.id, roundId)).then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Interview round not found");
    if (row.status === "setup") throw conflict("The round has not opened on the website, so there are no interviews yet");
    return row;
  }

  const scopeOf = (round: RoundRow): InterviewBridgeScope => ({
    companyId: round.companyId,
    organisationId: round.websiteOrganisationId,
    roundId: round.id,
  });

  function proposalsOf(round: RoundRow) {
    return db
      .select()
      .from(deepDiveInterviewProposals)
      .where(and(eq(deepDiveInterviewProposals.companyId, round.companyId), eq(deepDiveInterviewProposals.roundId, round.id)))
      .orderBy(asc(deepDiveInterviewProposals.createdAt));
  }

  /**
   * The website hard-deleted these interviews or people: their quotes and
   * board proposals go, and so does any theme still waiting for a person. A
   * theme a person already decided keeps its words but loses the source.
   */
  async function applyWithdrawals(round: RoundRow, actor: WebsiteBridgeActor) {
    const withdrawals = await bridge.withdrawals(scopeOf(round), actor);
    if (withdrawals.length === 0) return { removed: 0, trimmed: 0 };
    const gone = (source: DeepDiveProposalSource) =>
      withdrawals.some((w) => (w.interviewId ? source.interviewId === w.interviewId : w.userId !== null && source.userId === w.userId));
    const remove: string[] = [];
    let trimmed = 0;
    for (const row of await proposalsOf(round)) {
      const sources = row.sources as DeepDiveProposalSource[];
      if (!sources.some(gone)) continue;
      if (row.kind === "quote" || row.kind === "person" || row.status === "proposed") {
        remove.push(row.id);
        continue;
      }
      await db.update(deepDiveInterviewProposals)
        .set({ sources: sources.filter((s) => !gone(s)), updatedAt: new Date() })
        .where(eq(deepDiveInterviewProposals.id, row.id));
      trimmed += 1;
    }
    if (remove.length > 0) await db.delete(deepDiveInterviewProposals).where(inArray(deepDiveInterviewProposals.id, remove));
    return { removed: remove.length, trimmed };
  }

  async function pull(round: RoundRow, actor: WebsiteBridgeActor) {
    const scope = scopeOf(round);
    const list = await bridge.interviews(scope, actor);
    const details: GsInterviewDetail[] = [];
    for (let i = 0; i < list.length; i += READ_AT_ONCE) {
      details.push(...await Promise.all(list.slice(i, i + READ_AT_ONCE).map((item) => bridge.interview(scope, item.interviewId, actor))));
    }
    const units = await db
      .select({ id: deepDiveOrgUnits.id, parentId: deepDiveOrgUnits.parentId, name: deepDiveOrgUnits.name })
      .from(deepDiveOrgUnits)
      .where(eq(deepDiveOrgUnits.companyId, round.companyId))
      .orderBy(asc(deepDiveOrgUnits.position), asc(deepDiveOrgUnits.name));
    return { details, evidence: buildDeepDiveSynthesisEvidence(round.id, details, units) };
  }

  /** What the agent reads before it writes: every rule applied, no raw answer. */
  async function evidence(roundId: string, actor: WebsiteBridgeActor): Promise<DeepDiveSynthesisEvidence & { withdrawals: { removed: number; trimmed: number } }> {
    const round = await loadRound(roundId);
    const withdrawals = await applyWithdrawals(round, actor);
    return { ...(await pull(round, actor)).evidence, withdrawals };
  }

  function toView(row: ProposalRow): DeepDiveInterviewProposal {
    // An anonymous quote names nobody, not even by website id.
    const sources = (row.sources as DeepDiveProposalSource[]).map((s) => (row.anonymous && row.kind === "quote" ? { interviewId: s.interviewId, userId: null, employeeId: null } : s));
    return {
      id: row.id,
      roundId: row.roundId,
      kind: row.kind,
      themeKey: row.themeKey,
      parentId: row.parentId,
      label: row.label,
      statement: row.statement,
      unitId: row.unitId,
      voices: row.voices,
      firstHandVoices: row.firstHandVoices,
      websiteInsightId: row.websiteInsightId,
      websiteEmployeeId: row.websiteEmployeeId,
      anonymous: row.anonymous,
      sources,
      status: row.status,
      visibility: "internal",
      rulesVersion: row.rulesVersion,
      decidedByUserId: row.decidedByUserId,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async function list(roundId: string) {
    const round = await loadRound(roundId);
    return { roundId: round.id, proposals: (await proposalsOf(round)).map(toView) };
  }

  /**
   * The agent's synthesis. Checked against the evidence as it is now; any
   * refusal writes nothing. Replaces this round's earlier proposals that no
   * person has decided yet, and leaves decided ones alone.
   */
  async function propose(roundId: string, input: SubmitDeepDiveSynthesis, actor: DeepDiveInterviewActor, bridgeActor: WebsiteBridgeActor) {
    const round = await loadRound(roundId);
    const withdrawals = await applyWithdrawals(round, bridgeActor);
    const { details, evidence: fresh } = await pull(round, bridgeActor);
    const checked = checkDeepDiveSynthesis(fresh, details, input);
    if (!checked.ok) {
      throw unprocessable(`The synthesis breaks ${checked.refusals.length} rule${checked.refusals.length === 1 ? "" : "s"}, so nothing was written`, { refusals: checked.refusals });
    }

    const detailById = new Map(details.map((d) => [d.interview.interviewId, d]));
    const sourceOf = (interviewId: string): DeepDiveProposalSource => {
      const detail = detailById.get(interviewId)!;
      return { interviewId, userId: detail.interview.userId, employeeId: detail.interview.employeeId };
    };
    const by = {
      proposedByAgentId: actor.type === "agent" ? actor.agentId : null,
      proposedByUserId: actor.type === "user" ? actor.userId : null,
    };
    const base = { companyId: round.companyId, roundId: round.id, websiteOrganisationId: round.websiteOrganisationId, rulesVersion: DEEP_DIVE_SYNTHESIS_RULES_VERSION, ...by };

    return db.transaction(async (tx) => {
      // Undecided themes and people go (their quotes with them), unless a person already decided one of the quotes.
      const existing = await tx.select().from(deepDiveInterviewProposals).where(eq(deepDiveInterviewProposals.roundId, round.id));
      const keptParents = new Set(existing.flatMap((row) => (row.kind === "quote" && row.status !== "proposed" && row.parentId ? [row.parentId] : [])));
      const replaced = existing.filter((row) => row.kind !== "quote" && row.status === "proposed" && !keptParents.has(row.id)).map((row) => row.id);
      if (replaced.length > 0) await tx.delete(deepDiveInterviewProposals).where(inArray(deepDiveInterviewProposals.id, replaced));
      const kept = existing.filter((row) => row.kind !== "quote" && !replaced.includes(row.id));
      const decidedThemes = new Set(kept.flatMap((row) => (row.kind !== "person" && row.themeKey ? [row.themeKey] : [])));
      const decidedPeople = new Set(kept.flatMap((row) => (row.kind === "person" && row.websiteEmployeeId ? [row.websiteEmployeeId] : [])));

      let themes = 0;
      let quotes = 0;
      for (const item of checked.items) {
        if (decidedThemes.has(item.theme.key)) continue;
        const [theme] = await tx.insert(deepDiveInterviewProposals).values({
          ...base,
          kind: item.theme.kind,
          themeKey: item.theme.key,
          label: item.theme.label,
          statement: item.statement,
          unitId: item.theme.unitIds.length === 1 ? item.theme.unitIds[0]! : null,
          voices: item.theme.voices,
          firstHandVoices: item.theme.firstHand,
          sources: [...new Set(item.theme.insights.map((i) => i.interviewId))].map(sourceOf),
        }).returning({ id: deepDiveInterviewProposals.id });
        themes += 1;
        if (item.quotes.length === 0) continue;
        await tx.insert(deepDiveInterviewProposals).values(item.quotes.map((quote) => ({
          ...base,
          kind: "quote" as const,
          themeKey: item.theme.key,
          parentId: theme!.id,
          label: item.theme.label,
          statement: quote.quote,
          websiteInsightId: quote.insight.insightId,
          websiteEmployeeId: quote.anonymous ? null : detailById.get(quote.insight.interviewId)!.interview.employeeId,
          anonymous: quote.anonymous,
          sources: [sourceOf(quote.insight.interviewId)],
        })));
        quotes += item.quotes.length;
      }

      const people = input.people
        ? fresh.people.filter((p) => p.attribution && p.websiteEmployeeId && !decidedPeople.has(p.websiteEmployeeId))
        : [];
      if (people.length > 0) {
        await tx.insert(deepDiveInterviewProposals).values(people.map((person) => ({
          ...base,
          kind: "person" as const,
          label: person.roleTitle,
          statement: person.roleTitle.trim() || NO_ROLE,
          unitId: person.unitId,
          websiteEmployeeId: person.websiteEmployeeId,
          anonymous: false,
          sources: [sourceOf(person.interviewId)],
        })));
      }

      const rows = await tx
        .select()
        .from(deepDiveInterviewProposals)
        .where(eq(deepDiveInterviewProposals.roundId, round.id))
        .orderBy(asc(deepDiveInterviewProposals.createdAt));
      return { written: { themes, quotes, people: people.length }, withdrawals, roundId: round.id, proposals: rows.map(toView) };
    });
  }

  /** Only a person accepts or rejects a proposal, once. */
  async function decide(proposalId: string, input: DecideDeepDiveInterviewProposal, actor: DeepDiveInterviewActor) {
    if (actor.type !== "user") throw forbidden("Only a person accepts or rejects a synthesis proposal");
    const row = await db.select().from(deepDiveInterviewProposals).where(eq(deepDiveInterviewProposals.id, proposalId)).then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Proposal not found");
    if (row.status !== "proposed") throw conflict(`This proposal is ${row.status} already`);
    const at = new Date();
    const [updated] = await db.update(deepDiveInterviewProposals)
      .set({ status: input.decision, decidedByUserId: actor.userId, decidedAt: at, updatedAt: at })
      .where(and(eq(deepDiveInterviewProposals.id, proposalId), eq(deepDiveInterviewProposals.status, "proposed")))
      .returning();
    if (!updated) throw conflict("This proposal was decided already");
    return toView(updated);
  }

  async function companyOfProposal(proposalId: string) {
    const row = await db.select({ companyId: deepDiveInterviewProposals.companyId }).from(deepDiveInterviewProposals)
      .where(eq(deepDiveInterviewProposals.id, proposalId)).then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Proposal not found");
    return row.companyId;
  }

  return { evidence, list, propose, decide, applyWithdrawals: async (roundId: string, actor: WebsiteBridgeActor) => applyWithdrawals(await loadRound(roundId), actor), companyOfProposal };
}
