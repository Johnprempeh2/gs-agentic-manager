import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  authUsers,
  chatConversations,
  chatEndpoints,
  chatPublications,
  companies,
  emailMessages,
  goalKpiAlerts,
  goalKpiReadings,
  goalWhyRequests,
  strategyBoardEmails,
  strategyBoardSettings,
  type Db,
} from "@greatstone/db";
import type {
  EmailPublicationSummary,
  EmailSendInput,
  GoalWithProgress,
  StrategyBoardEmail,
  StrategyBoardEmailKind,
  StrategyBoardEmailSettings,
  StrategyBoardSettings,
  UpdateStrategyBoardSettings,
} from "@greatstone/shared";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { isEntitled } from "./entitlements.js";
import { goalService } from "./goals.js";
import { instanceSettingsService } from "./instance-settings.js";
import { issueService } from "./issues.js";
import { strategyBoardService } from "./strategy-board.js";

/**
 * Board email (GRE-1187). Owners rarely log in, so the board secretary's
 * AgentMail inbox sends them the plan: reminders before each board meeting,
 * slippage alerts to the chair and "Why?" requests to the KPI owner.
 *
 * A sweep builds what is due and logs one `strategy_board_emails` row per
 * email. The row's unique dedupe key is the guard: a reminder once per owner
 * per meeting, an alert once per red spell, a "Why?" request once. Nothing is
 * sent while `enableStrategyBoard` is off, the instance setting turns that
 * kind off, or the company has no secretary inbox.
 */

export const BOARD_MEETING_ORIGIN_KIND = "strategy_board_meeting";
/** A failed email is tried again on later sweeps, this many times in all. */
export const BOARD_EMAIL_MAX_ATTEMPTS = 3;

/** Queues a board email; `emailChannelService(...).queueBoardSend` in the app. */
export interface BoardEmailSender {
  queueBoardSend(companyId: string, input: EmailSendInput): Promise<EmailPublicationSummary>;
}

type EmailRow = typeof strategyBoardEmails.$inferSelect;

/** One email the sweep wants to send. */
interface BoardEmailDraft {
  kind: StrategyBoardEmailKind;
  dedupeKey: string;
  recipientUserId: string;
  parentIssueId: string;
  subject: string;
  text: string;
  alertId?: string;
  whyRequestId?: string;
  meetingDate?: string;
  kpiCodes?: Record<string, string>;
}

export interface BoardEmailSweepResult {
  queued: number;
  failed: number;
  /** Why nothing was sent, when the company was skipped. */
  skipped?: "switch_off" | "email_off" | "no_secretary" | "secretary_inactive";
}

function toEmail(row: EmailRow): StrategyBoardEmail {
  const { dedupeKey: _dedupeKey, endpointId: _endpointId, ...rest } = row;
  return { ...rest, kind: row.kind as StrategyBoardEmailKind, status: row.status as StrategyBoardEmail["status"] };
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function round(value: number | null | undefined): string {
  return value == null ? "-" : String(Math.round(value * 100) / 100);
}

function quote(text: string) {
  return `> ${text.replace(/\r?\n/g, "\n> ")}`;
}

/** True on the days an owner's reminder for `meetingDate` is due: from the lead day to the meeting. */
export function meetingReminderDue(today: string, meetingDate: string | null, leadDays: number): boolean {
  if (!meetingDate) return false;
  return today >= addDays(meetingDate, -leadDays) && today <= meetingDate;
}

function kpiLine(code: string, kpi: GoalWithProgress): string {
  const unit = kpi.unit ? ` ${kpi.unit}` : "";
  const s = kpi.kpiStatus;
  const latest = kpi.latestReading
    ? `latest ${round(kpi.latestReading.value)}${unit} on ${kpi.latestReading.readingDate}`
    : "no reading yet";
  const status = s?.status ? `, ${s.status}${s.status !== "green" && s.gapPercent ? ` (${s.gapPercent}% behind plan)` : ""}` : "";
  const target = kpi.targetValue != null ? ` Target ${round(kpi.targetValue)}${unit}${kpi.targetDate ? ` by ${kpi.targetDate}` : ""}.` : "";
  return `- ${code} ${kpi.title}: ${latest}${status}.${target}`;
}

/** The reminder an owner gets before a board meeting. `kpiCodes` maps "K1" to the KPI id. */
export function renderMeetingReminder(input: {
  ownerName: string | null;
  meetingDate: string;
  kpis: GoalWithProgress[];
  actions: GoalWithProgress[];
  openWhy: Array<{ question: string; kpiTitle: string }>;
  boardUrl: string | null;
}): { subject: string; text: string; kpiCodes: Record<string, string> } {
  const kpiCodes: Record<string, string> = {};
  const lines = [`Hello ${input.ownerName ?? "there"},`, "", `The board meets on ${input.meetingDate}. Please send your latest readings before then.`];
  if (input.kpis.length) {
    lines.push("", "KPIs you own. Reply to this email with one line per KPI, for example \"K1: 12500\":");
    input.kpis.forEach((kpi, index) => {
      const code = `K${index + 1}`;
      kpiCodes[code] = kpi.id;
      lines.push(kpiLine(code, kpi));
    });
  }
  if (input.actions.length || input.openWhy.length) {
    lines.push("", "Due by the meeting:");
    for (const action of input.actions) lines.push(`- ${action.title}${action.targetDate ? ` (due ${action.targetDate})` : ""}`);
    for (const why of input.openWhy) lines.push(`- Answer the board's "Why?" on ${why.kpiTitle}: ${why.question.replace(/\s+/g, " ").slice(0, 300)}`);
  }
  if (input.boardUrl) lines.push("", `You can also update the plan here: ${input.boardUrl}`);
  lines.push("", "Board secretary");
  return { subject: `Board meeting on ${input.meetingDate}: your readings and actions`, text: lines.join("\n"), kpiCodes };
}

export function renderSlippageAlert(input: { kpi: GoalWithProgress; gapPercent: number | null; latestValue: number | null; goalUrl: string | null }) {
  const { kpi } = input;
  const unit = kpi.unit ? ` ${kpi.unit}` : "";
  const s = kpi.kpiStatus;
  const detail = s?.reason === "deadline_missed"
    ? `The deadline has passed and the target is not met: ${round(input.latestValue ?? s?.latestValue)}${unit} against a target of ${round(kpi.targetValue)}${unit}.`
    : `${round(input.gapPercent ?? s?.gapPercent)}% behind plan: ${round(input.latestValue ?? s?.latestValue)}${unit} against a plan of ${round(s?.plannedValue)}${unit}${s?.latestDate ? ` on ${s.latestDate}` : ""}.`;
  const lines = [`${kpi.title} is off track.`, "", detail];
  if (input.goalUrl) lines.push("", `See the readings and ask the owner "Why?": ${input.goalUrl}`);
  lines.push("", "You get this email once each time the KPI turns red.", "", "Board secretary");
  return { subject: `KPI turned red: ${kpi.title}`, text: lines.join("\n") };
}

export function renderWhyRequest(input: { ownerName: string | null; kpiTitle: string; question: string; goalUrl: string | null }) {
  const lines = [
    `Hello ${input.ownerName ?? "there"},`,
    "",
    `A board member asks you to explain the slippage on ${input.kpiTitle}:`,
    "",
    quote(input.question),
    "",
    "Reply to this email with your answer. It is logged on the KPI and goes into the next board pack.",
  ];
  if (input.goalUrl) lines.push("", `You can also answer on the KPI page: ${input.goalUrl}`);
  lines.push("", "Board secretary");
  return { subject: `The board asks why: ${input.kpiTitle}`, text: lines.join("\n") };
}

/** `sender` is needed only to send; routes read and change the settings without it. */
export function strategyBoardEmailService(db: Db, opts: { sender?: BoardEmailSender; publicBaseUrl?: string | null } = {}) {
  const goalsSvc = goalService(db);
  const issuesSvc = issueService(db);
  const baseUrl = opts.publicBaseUrl ? opts.publicBaseUrl.replace(/\/+$/, "") : null;

  async function getSettings(companyId: string): Promise<StrategyBoardSettings> {
    const row = await db
      .select()
      .from(strategyBoardSettings)
      .where(eq(strategyBoardSettings.companyId, companyId))
      .then((rows) => rows[0] ?? null);
    return {
      companyId,
      secretaryEndpointId: row?.secretaryEndpointId ?? null,
      nextMeetingDate: row?.nextMeetingDate ?? null,
      reminderLeadDays: row?.reminderLeadDays ?? 7,
    };
  }

  /** The secretary inbox must be this company's AgentMail inbox, not archived. */
  async function updateSettings(companyId: string, patch: UpdateStrategyBoardSettings): Promise<StrategyBoardSettings> {
    if (patch.secretaryEndpointId) {
      const endpoint = await db
        .select({ companyId: chatEndpoints.companyId, provider: chatEndpoints.provider, status: chatEndpoints.status })
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, patch.secretaryEndpointId))
        .then((rows) => rows[0] ?? null);
      if (!endpoint || endpoint.companyId !== companyId || endpoint.provider !== "agentmail" || endpoint.status === "archived") {
        throw unprocessable("Choose one of this company's email inboxes for the board secretary", { code: "board_secretary_inbox_invalid" });
      }
    }
    const current = await getSettings(companyId);
    const next = {
      secretaryEndpointId: patch.secretaryEndpointId !== undefined ? patch.secretaryEndpointId : current.secretaryEndpointId,
      nextMeetingDate: patch.nextMeetingDate !== undefined ? patch.nextMeetingDate : current.nextMeetingDate,
      reminderLeadDays: patch.reminderLeadDays ?? current.reminderLeadDays,
      updatedAt: new Date(),
    };
    await db
      .insert(strategyBoardSettings)
      .values({ companyId, ...next })
      .onConflictDoUpdate({ target: strategyBoardSettings.companyId, set: next });
    return getSettings(companyId);
  }

  async function listEmails(companyId: string): Promise<StrategyBoardEmail[]> {
    return db
      .select()
      .from(strategyBoardEmails)
      .where(eq(strategyBoardEmails.companyId, companyId))
      .orderBy(desc(strategyBoardEmails.createdAt))
      .limit(200)
      .then((rows) => rows.map(toEmail));
  }

  function goalUrl(prefix: string | null, goalId: string) {
    if (!baseUrl) return null;
    return prefix ? `${baseUrl}/${prefix}/goals/${goalId}` : `${baseUrl}/goals/${goalId}`;
  }

  function boardUrl(prefix: string | null) {
    if (!baseUrl) return null;
    return prefix ? `${baseUrl}/${prefix}/strategy-board` : `${baseUrl}/strategy-board`;
  }

  async function slippageDrafts(companyId: string, byId: Map<string, GoalWithProgress>, prefix: string | null): Promise<BoardEmailDraft[]> {
    const open = await db
      .select()
      .from(goalKpiAlerts)
      .where(
        and(
          eq(goalKpiAlerts.companyId, companyId),
          isNull(goalKpiAlerts.clearedAt),
          isNotNull(goalKpiAlerts.recipientUserId),
          isNotNull(goalKpiAlerts.alertIssueId),
        ),
      )
      .orderBy(asc(goalKpiAlerts.openedAt));
    return open.flatMap((alert) => {
      const kpi = byId.get(alert.goalId);
      if (!kpi) return [];
      const message = renderSlippageAlert({ kpi, gapPercent: alert.gapPercent, latestValue: alert.latestValue, goalUrl: goalUrl(prefix, kpi.id) });
      return [{
        kind: "slippage_alert" as const,
        dedupeKey: `alert:${alert.id}`,
        recipientUserId: alert.recipientUserId!,
        parentIssueId: alert.alertIssueId!,
        alertId: alert.id,
        ...message,
      }];
    });
  }

  async function whyDrafts(
    companyId: string,
    byId: Map<string, GoalWithProgress>,
    names: Map<string, string | null>,
    prefix: string | null,
  ): Promise<BoardEmailDraft[]> {
    const open = await db
      .select()
      .from(goalWhyRequests)
      .where(
        and(
          eq(goalWhyRequests.companyId, companyId),
          eq(goalWhyRequests.status, "open"),
          isNotNull(goalWhyRequests.ownerUserId),
          isNotNull(goalWhyRequests.ownerIssueId),
        ),
      )
      .orderBy(asc(goalWhyRequests.createdAt));
    return open.map((why) => ({
      kind: "why_request" as const,
      dedupeKey: `why:${why.id}`,
      recipientUserId: why.ownerUserId!,
      parentIssueId: why.ownerIssueId!,
      whyRequestId: why.id,
      ...renderWhyRequest({
        ownerName: names.get(why.ownerUserId!) ?? null,
        kpiTitle: byId.get(why.goalId)?.title ?? "a KPI",
        question: why.question,
        goalUrl: goalUrl(prefix, why.goalId),
      }),
    }));
  }

  /** One reminder per owner (a person) who has live KPIs or actions due by the meeting. */
  async function reminderDrafts(
    companyId: string,
    companyGoals: GoalWithProgress[],
    names: Map<string, string | null>,
    meetingDate: string,
    prefix: string | null,
  ): Promise<BoardEmailDraft[]> {
    const live = (goal: GoalWithProgress) => goal.status === "active" || goal.status === "planned";
    const byOwner = new Map<string, { kpis: GoalWithProgress[]; actions: GoalWithProgress[] }>();
    const slot = (userId: string) => {
      const entry = byOwner.get(userId) ?? { kpis: [], actions: [] };
      byOwner.set(userId, entry);
      return entry;
    };
    for (const goal of companyGoals) {
      if (!goal.ownerUserId || !live(goal)) continue;
      if (goal.kind === "kpi") slot(goal.ownerUserId).kpis.push(goal);
      else if (goal.kind === "initiative" && goal.targetDate && goal.targetDate <= meetingDate) slot(goal.ownerUserId).actions.push(goal);
    }
    const openWhy = await db
      .select({ ownerUserId: goalWhyRequests.ownerUserId, goalId: goalWhyRequests.goalId, question: goalWhyRequests.question })
      .from(goalWhyRequests)
      .where(and(eq(goalWhyRequests.companyId, companyId), eq(goalWhyRequests.status, "open"), isNotNull(goalWhyRequests.ownerUserId)));
    const titles = new Map(companyGoals.map((goal) => [goal.id, goal.title]));
    const whyByOwner = new Map<string, Array<{ question: string; kpiTitle: string }>>();
    for (const why of openWhy) {
      const list = whyByOwner.get(why.ownerUserId!) ?? [];
      list.push({ question: why.question, kpiTitle: titles.get(why.goalId) ?? "a KPI" });
      whyByOwner.set(why.ownerUserId!, list);
      slot(why.ownerUserId!);
    }
    if (byOwner.size === 0) return [];
    // One record task per meeting holds the reminder emails.
    const meetingIssue = await issuesSvc.create(companyId, {
      title: `Board meeting on ${meetingDate}: reminders to owners`,
      description: `The board secretary emailed each KPI owner their readings and actions due before the board meeting on ${meetingDate}. Each email is a sub-task; a reply reopens it.`,
      status: "done",
      priority: "low",
      originKind: BOARD_MEETING_ORIGIN_KIND,
      originId: meetingDate,
      idempotencyKey: `strategy-board-meeting:${companyId}:${meetingDate}`,
    });
    const url = boardUrl(prefix);
    return [...byOwner.entries()].map(([userId, work]) => {
      const sortByTitle = (a: GoalWithProgress, b: GoalWithProgress) => a.title.localeCompare(b.title);
      const message = renderMeetingReminder({
        ownerName: names.get(userId) ?? null,
        meetingDate,
        kpis: [...work.kpis].sort(sortByTitle),
        actions: [...work.actions].sort(sortByTitle),
        openWhy: whyByOwner.get(userId) ?? [],
        boardUrl: url,
      });
      return {
        kind: "meeting_reminder" as const,
        dedupeKey: `reminder:${meetingDate}:${userId}`,
        recipientUserId: userId,
        parentIssueId: meetingIssue.id,
        meetingDate,
        ...message,
      };
    });
  }

  async function send(companyId: string, endpointId: string, draft: BoardEmailDraft, email: string) {
    // Claimed as "failed" until the queue accepts it: a crash in between is
    // retried with the same idempotency key, so it is still sent only once.
    const [claimed] = await db
      .insert(strategyBoardEmails)
      .values({
        companyId,
        kind: draft.kind,
        dedupeKey: draft.dedupeKey,
        recipientUserId: draft.recipientUserId,
        recipientEmail: email,
        endpointId,
        alertId: draft.alertId ?? null,
        whyRequestId: draft.whyRequestId ?? null,
        meetingDate: draft.meetingDate ?? null,
        kpiCodes: draft.kpiCodes ?? null,
        status: "failed",
      })
      .onConflictDoNothing()
      .returning();
    let row = claimed;
    if (!row) {
      // Sent already, or a failed try that may be retried with the same key.
      const [existing] = await db
        .select()
        .from(strategyBoardEmails)
        .where(and(eq(strategyBoardEmails.companyId, companyId), eq(strategyBoardEmails.dedupeKey, draft.dedupeKey)));
      if (!existing || existing.status !== "failed" || existing.attempts >= BOARD_EMAIL_MAX_ATTEMPTS) return null;
      row = existing;
    }
    try {
      if (!opts.sender) throw new Error("No email sender is set up for board email");
      const queued = await opts.sender.queueBoardSend(companyId, {
        endpointId: row.endpointId ?? endpointId,
        parentIssueId: draft.parentIssueId,
        to: [row.recipientEmail],
        subject: draft.subject.slice(0, 998),
        text: draft.text,
        attachmentIds: [],
        replyAll: false,
        idempotencyKey: row.id,
      });
      await db
        .update(strategyBoardEmails)
        .set({ status: "queued", publicationId: queued.id, attempts: row.attempts + 1, lastError: null })
        .where(eq(strategyBoardEmails.id, row.id));
      return "queued" as const;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(strategyBoardEmails)
        .set({ status: "failed", attempts: row.attempts + 1, lastError: message.slice(0, 1000) })
        .where(eq(strategyBoardEmails.id, row.id));
      logger.warn(
        { err, companyId, kind: draft.kind, emailId: row.id, attempt: row.attempts + 1 },
        "strategy board: a board email could not be queued; it is tried again on the next sweep. Check the board secretary inbox.",
      );
      return "failed" as const;
    }
  }

  /** Queues every board email that is due for one company. Safe to run often. */
  async function runForCompany(
    companyId: string,
    ctx: { today: string; kinds: StrategyBoardEmailSettings },
  ): Promise<BoardEmailSweepResult> {
    const settings = await getSettings(companyId);
    if (!settings.secretaryEndpointId) return { queued: 0, failed: 0, skipped: "no_secretary" };
    const endpoint = await db
      .select({ status: chatEndpoints.status, companyId: chatEndpoints.companyId })
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, settings.secretaryEndpointId))
      .then((rows) => rows[0] ?? null);
    if (!endpoint || endpoint.companyId !== companyId || endpoint.status !== "active") {
      logger.warn({ companyId }, "strategy board: the board secretary inbox is not active, so no board email is sent. Reconnect it or choose another inbox.");
      return { queued: 0, failed: 0, skipped: "secretary_inactive" };
    }
    const companyGoals = await goalsSvc.listWithProgress(companyId);
    const byId = new Map(companyGoals.map((goal) => [goal.id, goal]));
    const prefix = await db
      .select({ prefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0]?.prefix ?? null);
    const ownerIds = [...new Set(companyGoals.map((goal) => goal.ownerUserId).filter((id): id is string => !!id))];
    const people = await db
      .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
      .from(authUsers)
      .where(inArray(authUsers.id, ownerIds.length ? ownerIds : ["-"]));
    const names = new Map<string, string | null>(people.map((p) => [p.id, p.name]));
    const drafts: BoardEmailDraft[] = [];
    if (ctx.kinds.slippageAlerts) drafts.push(...(await slippageDrafts(companyId, byId, prefix)));
    if (ctx.kinds.whyRequests) drafts.push(...(await whyDrafts(companyId, byId, names, prefix)));
    if (ctx.kinds.meetingReminders && meetingReminderDue(ctx.today, settings.nextMeetingDate, settings.reminderLeadDays)) {
      drafts.push(...(await reminderDrafts(companyId, companyGoals, names, settings.nextMeetingDate!, prefix)));
    }
    if (drafts.length === 0) return { queued: 0, failed: 0 };
    const recipientIds = [...new Set(drafts.map((draft) => draft.recipientUserId))];
    const emails = new Map(
      (await db.select({ id: authUsers.id, email: authUsers.email }).from(authUsers).where(inArray(authUsers.id, recipientIds)))
        .map((row) => [row.id, row.email]),
    );
    const result: BoardEmailSweepResult = { queued: 0, failed: 0 };
    for (const draft of drafts) {
      const email = emails.get(draft.recipientUserId)?.trim();
      if (!email) {
        logger.warn({ companyId, kind: draft.kind, userId: draft.recipientUserId }, "strategy board: no email address for this person, so the board email stays in-app only");
        continue;
      }
      const outcome = await send(companyId, settings.secretaryEndpointId, draft, email);
      if (outcome) result[outcome] += 1;
    }
    return result;
  }

  return { getSettings, updateSettings, listEmails, runForCompany };
}

const EMAIL_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
let lastEmailSweepAt = 0;

/**
 * Every 15 minutes: queue the board emails that are due in every company
 * with a secretary inbox. The email service delivers them on its own tick.
 */
export async function runScheduledStrategyBoardEmails(
  db: Db,
  opts: { sender: BoardEmailSender; publicBaseUrl?: string | null; now?: Date; force?: boolean },
): Promise<Map<string, BoardEmailSweepResult>> {
  const now = opts.now ?? new Date();
  const results = new Map<string, BoardEmailSweepResult>();
  if (!opts.force && now.getTime() - lastEmailSweepAt < EMAIL_SWEEP_INTERVAL_MS) return results;
  lastEmailSweepAt = now.getTime();
  if (!(await isEntitled(db, "enableStrategyBoard"))) return results;
  const settings = instanceSettingsService(db);
  if (!(await settings.getExperimental()).enableChatConnectors) return results;
  const kinds = (await settings.getGeneral()).strategyBoardEmail;
  if (!kinds.meetingReminders && !kinds.slippageAlerts && !kinds.whyRequests) return results;
  const companies = await db
    .select({ companyId: strategyBoardSettings.companyId })
    .from(strategyBoardSettings)
    .where(isNotNull(strategyBoardSettings.secretaryEndpointId));
  const svc = strategyBoardEmailService(db, opts);
  const today = now.toISOString().slice(0, 10);
  for (const { companyId } of companies) {
    try {
      results.set(companyId, await svc.runForCompany(companyId, { today, kinds }));
    } catch (err) {
      logger.error({ err, companyId }, "strategy board: board email sweep failed for a company");
    }
  }
  return results;
}

/**
 * Lines like "K1: 12500" or "k2 = 1,250.5" in an owner's reply. Quoted lines
 * (the reminder itself starts each KPI with "- K1") never match. When a code
 * is given twice, the last line wins.
 */
export function parseReadingLines(text: string): Array<{ code: string; value: number }> {
  const byCode = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(K\d{1,3})\s*[:=]\s*(-?\d[\d,]*(?:\.\d+)?)(?:\s.*)?$/i);
    if (!match) continue;
    const value = Number(match[2].replace(/,/g, ""));
    if (Number.isFinite(value)) byCode.set(match[1].toUpperCase(), value);
  }
  return [...byCode.entries()].map(([code, value]) => ({ code, value }));
}

/** The reply without the quoted email below it, for when the provider sent no extracted text. */
export function replyBody(text: string): string {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*On .+wrote:\s*$/.test(line) || /^\s*-{2,}\s*Original Message/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    lines.push(line);
  }
  return lines.join("\n").trim();
}

function emailAddress(value: string): string {
  return (value.match(/<([^>]+)>/)?.[1] ?? value).trim().toLowerCase();
}

export interface BoardReplyResult {
  stored: "why_answer" | "readings" | "nothing";
  reason?: "not_board_thread" | "switch_off" | "unknown_sender" | "sender_not_authenticated" | "already_answered" | "no_answer" | "no_readings" | "not_stored_kind";
  readings?: number;
}

/**
 * GRE-1196: an email that came into a thread the board sent. A reply from the
 * person the board emailed is stored on the plan: the answer to a "Why?"
 * request, or owner-reported readings from a meeting reminder. Anything else
 * stays in the email thread only. Safe to call again for the same message.
 *
 * GRE-1215: a From header can be forged, so the address match alone is not
 * enough. `senderAuthenticated` is AgentMail's DMARC verdict (see
 * `isSenderAuthenticated`); without a pass nothing is written to the plan.
 */
export async function storeBoardEmailReply(
  db: Db,
  input: { companyId: string; conversationId: string; providerMessageId: string; senderAuthenticated: boolean },
): Promise<BoardReplyResult> {
  const [sent] = await db
    .select({ email: strategyBoardEmails, threadIssueId: chatConversations.issueId })
    .from(strategyBoardEmails)
    .innerJoin(chatPublications, eq(chatPublications.id, strategyBoardEmails.publicationId))
    .innerJoin(chatConversations, eq(chatConversations.id, chatPublications.conversationId))
    .where(and(eq(strategyBoardEmails.companyId, input.companyId), eq(chatPublications.conversationId, input.conversationId)))
    .limit(1);
  if (!sent) return { stored: "nothing", reason: "not_board_thread" };
  if (!(await isEntitled(db, "enableStrategyBoard"))) return { stored: "nothing", reason: "switch_off" };
  const [message] = await db
    .select()
    .from(emailMessages)
    .where(
      and(
        eq(emailMessages.companyId, input.companyId),
        eq(emailMessages.conversationId, input.conversationId),
        eq(emailMessages.providerMessageId, input.providerMessageId),
      ),
    );
  if (!message || message.direction !== "inbound") return { stored: "nothing", reason: "not_board_thread" };
  const { email } = sent;
  if (email.kind === "slippage_alert") return { stored: "nothing", reason: "not_stored_kind" };
  const note = (body: string) => issueService(db).addComment(sent.threadIssueId, body, {}, { authorType: "system" });
  if (emailAddress(message.envelope.from) !== emailAddress(email.recipientEmail)) {
    await note("Not stored on the plan: this reply did not come from the person the board emailed, so it stays in this email thread only.");
    return { stored: "nothing", reason: "unknown_sender" };
  }
  if (!input.senderAuthenticated) {
    await note(
      "Not stored on the plan: the email system could not confirm this reply was sent by the person the board emailed (their mail domain did not pass DMARC), so it stays in this email thread only. They can answer on the board or enter readings on the KPI page.",
    );
    return { stored: "nothing", reason: "sender_not_authenticated" };
  }
  const board = strategyBoardService(db);
  const text = replyBody(message.text);

  if (email.kind === "why_request") {
    const request = email.whyRequestId ? await board.getWhyRequest(email.whyRequestId) : null;
    if (!request || request.status !== "open") {
      await note("Not stored on the plan: this \"Why?\" request has been answered already.");
      return { stored: "nothing", reason: "already_answered" };
    }
    if (!text) return { stored: "nothing", reason: "no_answer" };
    const answered = await board.answerWhyRequest(request, text, { userId: email.recipientUserId, agentId: null });
    if (!answered) return { stored: "nothing", reason: "already_answered" };
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "strategy_board_email",
      action: "goal.why_answered",
      entityType: "goal",
      entityId: request.goalId,
      details: { whyRequestId: request.id, via: "email", answeredByUserId: email.recipientUserId },
    });
    await note("Stored on the plan: this reply is the answer to the board's \"Why?\" request.");
    return { stored: "why_answer" };
  }

  // A meeting reminder: "K1: 12500" lines become owner-reported readings.
  const codes = email.kpiCodes ?? {};
  const lines = parseReadingLines(text).filter((line) => codes[line.code]);
  if (lines.length === 0) return { stored: "nothing", reason: "no_readings" };
  const goalsSvc = goalService(db);
  const readingDate = message.timestamp.toISOString().slice(0, 10);
  const readingNote = `Email reply to the board meeting reminder${email.meetingDate ? ` for ${email.meetingDate}` : ""}`;
  const stored: string[] = [];
  for (const line of lines) {
    const goal = await goalsSvc.getById(codes[line.code]);
    if (!goal || goal.companyId !== input.companyId || goal.kind !== "kpi") continue;
    // A retried delivery finds the reading already there.
    const [existing] = await db
      .select({ id: goalKpiReadings.id })
      .from(goalKpiReadings)
      .where(
        and(
          eq(goalKpiReadings.goalId, goal.id),
          eq(goalKpiReadings.readingDate, readingDate),
          eq(goalKpiReadings.source, "owner_reported"),
          eq(goalKpiReadings.recordedByUserId, email.recipientUserId),
          eq(goalKpiReadings.value, line.value),
          eq(goalKpiReadings.note, readingNote),
        ),
      );
    if (existing) continue;
    const reading = await goalsSvc.createReading(
      goal,
      { value: line.value, readingDate, note: readingNote, source: "owner_reported" },
      { agentId: null, userId: email.recipientUserId },
    );
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "strategy_board_email",
      action: "goal.kpi_reading_recorded",
      entityType: "goal",
      entityId: goal.id,
      details: { readingId: reading.id, value: reading.value, readingDate, source: reading.source, via: "email", recordedByUserId: email.recipientUserId },
    });
    await board.evaluateAlerts(input.companyId, { goalIds: [goal.id], readingId: reading.id }).catch((err: unknown) =>
      logger.error({ err, companyId: input.companyId, goalId: goal.id }, "strategy board: KPI alert check failed; the hourly sweep will retry"),
    );
    stored.push(`- ${line.code} ${goal.title}: ${line.value}${goal.unit ? ` ${goal.unit}` : ""}`);
  }
  if (stored.length === 0) return { stored: "nothing", reason: "no_readings" };
  await note(`Stored on the plan as owner-reported readings for ${readingDate}:\n\n${stored.join("\n")}`);
  return { stored: "readings", readings: stored.length };
}
