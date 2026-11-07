import { and, desc, eq, inArray, like } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { companies, companyMemberships, deepDiveInterviewRounds, issues } from "@greatstone/db";
import type { GsInterviewParticipantWithdrawnEvent } from "@greatstone/shared";
import { logger } from "../middleware/logger.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { issueService } from "./issues.js";
import { WebsiteBridgeError, type WebsiteBridgeActor } from "./website/data-bridge-client.js";
import type { InterviewBridge } from "./website/interview-bridge.js";

// A participant who deletes their interview data on the website (claim C8 of
// the interview privacy notice) leaves a round-only `participant_withdrawn`
// event in the round's outbox. GSAM reads it and gives the round's owner one
// task: re-run the synthesis and release an updated version (GRE-4304).
//
// One task per event, keyed by `<roundId>:<event cursor>` in originId, so a
// re-read never makes a second one. The read starts after the newest task's
// event: the site never deletes a participant_withdrawn row (only a person's
// session events, and the whole round at retention), so that cursor stays valid.
// The task holds the round and the date only: no name, answer or id of the person.

export const INTERVIEW_WITHDRAWAL_ORIGIN_KIND = "interview_participant_withdrawn";
const ACTOR: WebsiteBridgeActor = { type: "system", id: "interview-withdrawal-prompts" };

type RoundRow = typeof deepDiveInterviewRounds.$inferSelect;
export type InterviewWithdrawalPollResult =
  | { roundId: string; outcome: "read"; events: number; created: number }
  /** The website does not know the round (deleted at retention, or never pushed): nothing to read. */
  | { roundId: string; outcome: "unknown_round" };

export function interviewWithdrawalPromptService(db: Db, bridge: InterviewBridge, deps: { heartbeat?: IssueAssignmentWakeupDeps } = {}) {
  const issuesSvc = issueService(db);

  async function activeMember(companyId: string, userId: string | null | undefined) {
    if (!userId) return false;
    const [member] = await db.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
      eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"),
    )).limit(1);
    return Boolean(member);
  }

  /** Who made the round, else the company's responsible person. Release is a person's act, so a person comes first. */
  async function ownerOf(round: RoundRow): Promise<{ assigneeUserId: string | null; assigneeAgentId: string | null }> {
    if (await activeMember(round.companyId, round.createdByUserId)) return { assigneeUserId: round.createdByUserId, assigneeAgentId: null };
    if (round.createdByAgentId) {
      try {
        await assertAssignableAgent(db, round.companyId, round.createdByAgentId);
        return { assigneeUserId: null, assigneeAgentId: round.createdByAgentId };
      } catch { /* terminated or paused for good: fall through */ }
    }
    const [company] = await db.select({ userId: companies.defaultResponsibleUserId }).from(companies)
      .where(eq(companies.id, round.companyId)).limit(1);
    if (await activeMember(round.companyId, company?.userId)) return { assigneeUserId: company!.userId, assigneeAgentId: null };
    return { assigneeUserId: null, assigneeAgentId: null };
  }

  const originIdOf = (round: RoundRow, cursor: string) => `${round.id}:${cursor}`;

  async function lastCursor(round: RoundRow) {
    const [row] = await db.select({ originId: issues.originId }).from(issues).where(and(
      eq(issues.companyId, round.companyId), eq(issues.originKind, INTERVIEW_WITHDRAWAL_ORIGIN_KIND),
      like(issues.originId, `${round.id}:%`),
    )).orderBy(desc(issues.createdAt), desc(issues.id)).limit(1);
    return row?.originId ? row.originId.slice(round.id.length + 1) : null;
  }

  async function prompted(round: RoundRow, cursor: string) {
    const [row] = await db.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, round.companyId), eq(issues.originKind, INTERVIEW_WITHDRAWAL_ORIGIN_KIND),
      eq(issues.originId, originIdOf(round, cursor)),
    )).limit(1);
    return Boolean(row);
  }

  async function prompt(round: RoundRow, event: GsInterviewParticipantWithdrawnEvent) {
    const date = (event.withdrawnAt ?? new Date().toISOString()).slice(0, 10);
    const owner = await ownerOf(round);
    const issue = await issuesSvc.create(round.companyId, {
      title: `Interview round: a participant withdrew on ${date}. Re-run the synthesis`,
      description: [
        `A participant in the [interview round](/deep-dive/interviews) for website organisation \`${round.websiteOrganisationId}\` deleted their interview data on ${date}.`,
        "",
        "The website has already taken them out of the round's synthesis and marked it stale."
          + (event.releasedAffected ? " A synthesis that held their content existed, so the client may have seen it." : ""),
        "",
        "1. Re-run the synthesis for this round (it applies the website's withdrawals first).",
        "2. Review it, and have a person release the updated version to the client.",
        "",
        "The client is not told who withdrew, and this task holds no participant data. Do not try to find out who it was.",
      ].join("\n"),
      status: "todo",
      priority: event.releasedAffected ? "high" : "medium",
      assigneeUserId: owner.assigneeUserId,
      assigneeAgentId: owner.assigneeAgentId,
      originKind: INTERVIEW_WITHDRAWAL_ORIGIN_KIND,
      originId: originIdOf(round, event.cursor),
      idempotencyKey: `${INTERVIEW_WITHDRAWAL_ORIGIN_KIND}:${originIdOf(round, event.cursor)}`,
    });
    if (!owner.assigneeUserId && !owner.assigneeAgentId) {
      logger.warn({ roundId: round.id, issueId: issue.id }, "interview withdrawal task has no owner: the round's creator and the company's responsible person are gone");
    }
    if (deps.heartbeat) {
      await queueIssueAssignmentWakeup({
        heartbeat: deps.heartbeat, issue, reason: "issue_assigned", mutation: "create",
        contextSource: "interview.participant_withdrawn", requestedByActorType: "system",
      });
    }
    return issue;
  }

  async function pollRound(round: RoundRow): Promise<InterviewWithdrawalPollResult> {
    const scope = { companyId: round.companyId, organisationId: round.websiteOrganisationId, roundId: round.id };
    let read;
    try {
      read = await bridge.withdrawnEvents(scope, await lastCursor(round), ACTOR);
    } catch (error) {
      if (error instanceof WebsiteBridgeError && error.code === "not_found") return { roundId: round.id, outcome: "unknown_round" };
      throw error;
    }
    if (read.truncated) logger.warn({ roundId: round.id }, "interview outbox read stopped at its page limit; the rest is read next time");
    let created = 0;
    // Oldest first, one at a time: a failure leaves the newest task's cursor before the event that failed.
    for (const event of read.events) {
      if (await prompted(round, event.cursor)) continue;
      await prompt(round, event);
      created += 1;
    }
    return { roundId: round.id, outcome: "read", events: read.events.length, created };
  }

  /** Every round the website has (open or closed). A round that fails does not stop the others. */
  async function pollAll(onError: (error: unknown, roundId: string) => void = () => {}) {
    const rounds = await db.select().from(deepDiveInterviewRounds).where(inArray(deepDiveInterviewRounds.status, ["open", "closed"]));
    const results: InterviewWithdrawalPollResult[] = [];
    for (const round of rounds) {
      try {
        results.push(await pollRound(round));
      } catch (error) {
        // A company with no website site cannot have had a withdrawal.
        if (error instanceof WebsiteBridgeError && error.code === "not_configured") continue;
        onError(error, round.id);
      }
    }
    return results;
  }

  return { pollRound, pollAll };
}

export function startInterviewWithdrawalPromptScheduler(
  db: Db, bridge: InterviewBridge, deps: { heartbeat?: IssueAssignmentWakeupDeps }, onError: (error: unknown, roundId: string) => void,
) {
  const service = interviewWithdrawalPromptService(db, bridge, deps);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await service.pollAll(onError); } catch (error) { onError(error, ""); }
    finally { running = false; }
  };
  void tick();
  // Hourly, as the website activity pull: each website database sleeps when idle.
  const timer = setInterval(() => { void tick(); }, 60 * 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
