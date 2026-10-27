import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { deepDiveInterviewRounds, deepDiveOrgUnits } from "@greatstone/db";
import {
  DEEP_DIVE_SYNTHESIS_RULES_VERSION,
  buildGsInterviewReleasedSynthesis,
  deepDiveReleaseReadiness,
  type DeepDiveInterviewReleaseView,
  type ReleaseDeepDiveInterviewSynthesis,
} from "@greatstone/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import type { deepDiveInterviewSynthesisService } from "./deep-dive-interview-synthesis.js";
import type { DeepDiveInterviewActor } from "./deep-dive-interviews.js";
import type { WebsiteBridgeActor } from "./website/data-bridge-client.js";
import type { InterviewBridge, InterviewBridgeScope } from "./website/interview-bridge.js";

// Parallel Interview release (GRE-2667), slice 4 of GRE-2611. Only a person
// releases: GSAM builds the synthesis from the accepted themes and quotes and
// pushes it to the website under the round's organisation id. Nothing goes to
// the website before that, and withdraw takes it away at once. GSAM keeps no
// copy of the release: what the client sees is read live from the website, and
// the activity log records who released or withdrew it.

type RoundRow = typeof deepDiveInterviewRounds.$inferSelect;

export function deepDiveInterviewReleaseService(db: Db, bridge: InterviewBridge, synthesis: ReturnType<typeof deepDiveInterviewSynthesisService>) {
  async function loadRound(roundId: string): Promise<RoundRow> {
    const row = await db.select().from(deepDiveInterviewRounds).where(eq(deepDiveInterviewRounds.id, roundId)).then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Interview round not found");
    if (row.status === "setup") throw conflict("The round has not opened on the website, so there is nothing to release");
    return row;
  }

  const scopeOf = (round: RoundRow): InterviewBridgeScope => ({
    companyId: round.companyId,
    organisationId: round.websiteOrganisationId,
    roundId: round.id,
  });

  function personOnly(actor: DeepDiveInterviewActor, action: string) {
    if (actor.type !== "user") throw forbidden(`Only a person ${action} the synthesis the client sees`);
  }

  async function view(round: RoundRow, bridgeActor: WebsiteBridgeActor): Promise<DeepDiveInterviewReleaseView> {
    const [{ proposals }, item] = await Promise.all([synthesis.list(round.id), bridge.round(scopeOf(round), bridgeActor)]);
    return {
      roundId: round.id,
      websiteOrganisationId: round.websiteOrganisationId,
      released: item.released,
      readiness: deepDiveReleaseReadiness(proposals),
    };
  }

  async function get(roundId: string, bridgeActor: WebsiteBridgeActor) {
    return view(await loadRound(roundId), bridgeActor);
  }

  /** A person's release: the website's withdrawals first, then the accepted themes and quotes only. */
  async function release(roundId: string, input: ReleaseDeepDiveInterviewSynthesis, actor: DeepDiveInterviewActor, bridgeActor: WebsiteBridgeActor) {
    personOnly(actor, "releases");
    const round = await loadRound(roundId);
    await synthesis.applyWithdrawals(round.id, bridgeActor);
    const { proposals } = await synthesis.list(round.id);
    const readiness = deepDiveReleaseReadiness(proposals);
    if (!readiness.ready) {
      throw unprocessable(`The synthesis is not reviewed yet: ${readiness.blockers.map((b) => b.message).join("; ")}`, { blockers: readiness.blockers });
    }
    const units = await db.select({ id: deepDiveOrgUnits.id, name: deepDiveOrgUnits.name }).from(deepDiveOrgUnits)
      .where(eq(deepDiveOrgUnits.companyId, round.companyId));
    const body = buildGsInterviewReleasedSynthesis({
      synthesisId: randomUUID(),
      headline: input.headline,
      proposals,
      unitNames: new Map(units.map((u) => [u.id, u.name])),
      rulesVersion: DEEP_DIVE_SYNTHESIS_RULES_VERSION,
    });
    await bridge.releaseSynthesis(scopeOf(round), body, bridgeActor);
    return { view: await view(round, bridgeActor), synthesisId: body.synthesisId, themes: body.themes.length, quotes: body.inputInsightIds.length };
  }

  async function withdraw(roundId: string, actor: DeepDiveInterviewActor, bridgeActor: WebsiteBridgeActor) {
    personOnly(actor, "withdraws");
    const round = await loadRound(roundId);
    await bridge.withdrawSynthesis(scopeOf(round), bridgeActor);
    return view(round, bridgeActor);
  }

  return { get, release, withdraw };
}
