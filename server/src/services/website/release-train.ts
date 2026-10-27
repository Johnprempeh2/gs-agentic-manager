import { and, desc, eq, inArray, like } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { issueComments, issueThreadInteractions, issues, routineTriggers } from "@greatstone/db";
import type {
  WebsiteHomeIssueLink,
  WebsiteHomeLaunch,
  WebsiteHomeTrain,
  WebsiteTrainState,
} from "@greatstone/shared";

/**
 * The weekly website release train and the new-site launch (John, GRE-2641,
 * 25 Oct 2026). The plan lives here, in one place: change the date or a gate
 * in this object and the Website Home follows.
 */
export const WEBSITE_LAUNCH_PLAN = {
  /** The routine "Weekly website release train". */
  trainRoutineId: "24c92294-f241-4ac4-bdb1-71a26040e79d",
  /** Proposed until John or Ben accepts the launch card on `cardIssue`. */
  targetDate: "2026-11-03" as string | null,
  cardIssue: "GRE-2641",
  gates: [
    { label: "Database cut-over", identifier: "GRE-2567" },
    { label: "Sign-in", identifier: "GRE-1991" },
    { label: "25 Oct page changes", identifier: "GRE-2565" },
    { label: "Client hub", identifier: "GRE-2613" },
    { label: "Domain and DNS", identifier: "GRE-2663" },
  ],
};

const TAG_PATTERN = /web-rc-\d{4}-\d{2}-\d{2}/g;

/** The last `web-rc-YYYY-MM-DD` tag in these texts, oldest text first. */
export function trainTag(texts: (string | null | undefined)[]): string | null {
  let tag: string | null = null;
  for (const text of texts) {
    const found = text?.match(TAG_PATTERN);
    if (found?.length) tag = found[found.length - 1]!;
  }
  return tag;
}

/**
 * Where the train is, from its issue status and its weekly-release card.
 * A done issue with no accepted card is a week with nothing to ship.
 */
export function trainState(issueStatus: string | null, cardStatus: string | null): WebsiteTrainState {
  if (!issueStatus || issueStatus === "cancelled") return "none";
  if (cardStatus === "accepted") return issueStatus === "done" ? "live" : "approved";
  if (issueStatus === "done") return "none";
  if (cardStatus === "pending") return "waiting_for_approval";
  if (cardStatus === "rejected") return "rejected";
  if (issueStatus === "blocked" || issueStatus === "in_review") return "checking";
  return "cut";
}

/** `YYYY-MM-DD` of `now` on the London calendar. */
function londonDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Whole calendar days from today in London to `target` (`YYYY-MM-DD`); 0 on the day, negative after. */
export function launchDaysLeft(target: string | null, now: Date = new Date()): number | null {
  if (!target) return null;
  const toUtc = (day: string) => {
    const [y, m, d] = day.split("-").map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  return Math.round((toUtc(target) - toUtc(londonDay(now))) / 86_400_000);
}

type IssueRow = Pick<typeof issues.$inferSelect, "id" | "identifier" | "title" | "status">;

const link = (row: IssueRow | undefined): WebsiteHomeIssueLink | null =>
  row ? { id: row.id, identifier: row.identifier, title: row.title, status: row.status } : null;

export function websiteReleaseTrain(db: Db, userNames: (ids: string[]) => Promise<Map<string, string>>) {
  async function train(companyId: string): Promise<WebsiteHomeTrain> {
    const plan = WEBSITE_LAUNCH_PLAN;
    const [trigger] = await db
      .select({ nextRunAt: routineTriggers.nextRunAt })
      .from(routineTriggers)
      .where(and(
        eq(routineTriggers.companyId, companyId),
        eq(routineTriggers.routineId, plan.trainRoutineId),
        eq(routineTriggers.enabled, true),
        eq(routineTriggers.archived, false),
      ))
      .orderBy(routineTriggers.nextRunAt)
      .limit(1);
    const nextRunAt = trigger?.nextRunAt?.toISOString() ?? null;

    const [issue] = await db
      .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status, description: issues.description })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "routine_execution"), eq(issues.originId, plan.trainRoutineId)))
      .orderBy(desc(issues.createdAt))
      .limit(1);
    if (!issue) return { issue: null, tag: null, state: "none", card: null, nextRunAt };

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, issue.id)))
      .orderBy(issueComments.createdAt);
    const [card] = await db
      .select()
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, companyId),
        eq(issueThreadInteractions.issueId, issue.id),
        eq(issueThreadInteractions.kind, "request_confirmation"),
        like(issueThreadInteractions.idempotencyKey, "%:weekly-release:%"),
      ))
      .orderBy(desc(issueThreadInteractions.createdAt))
      .limit(1);
    const names = card?.resolvedByUserId ? await userNames([card.resolvedByUserId]) : new Map<string, string>();

    return {
      issue: link(issue),
      tag: trainTag([issue.title, issue.description, ...comments.map((comment) => comment.body)]),
      state: trainState(issue.status, card?.status ?? null),
      card: card
        ? {
          id: card.id,
          status: card.status,
          resolvedByName: card.resolvedByUserId ? names.get(card.resolvedByUserId) ?? null : null,
          resolvedAt: card.resolvedAt?.toISOString() ?? null,
        }
        : null,
      nextRunAt,
    };
  }

  async function launch(companyId: string, now: Date = new Date()): Promise<WebsiteHomeLaunch> {
    const plan = WEBSITE_LAUNCH_PLAN;
    const identifiers = [plan.cardIssue, ...plan.gates.map((gate) => gate.identifier)];
    const rows = await db
      .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.identifier, identifiers)));
    const byIdentifier = new Map(rows.map((row) => [row.identifier, row]));
    const cardIssue = byIdentifier.get(plan.cardIssue);

    // The launch card targets the plan document on the card issue; the newest one counts.
    let agreement: WebsiteHomeLaunch["agreement"] = "proposed";
    if (cardIssue) {
      const cards = await db
        .select({ status: issueThreadInteractions.status, title: issueThreadInteractions.title, payload: issueThreadInteractions.payload })
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.issueId, cardIssue.id),
          eq(issueThreadInteractions.kind, "request_confirmation"),
        ))
        .orderBy(desc(issueThreadInteractions.createdAt));
      const latest = cards.find((card) => {
        const target = (card.payload as { target?: { key?: string } } | null)?.target;
        return target?.key === "plan" || /launch/i.test(card.title ?? "");
      });
      if (latest?.status === "accepted") agreement = "agreed";
    }

    return {
      targetDate: plan.targetDate,
      agreement,
      daysLeft: launchDaysLeft(plan.targetDate, now),
      cardIssue: link(cardIssue),
      gates: plan.gates.map((gate) => ({ ...gate, issue: link(byIdentifier.get(gate.identifier)) })),
    };
  }

  return { train, launch };
}
