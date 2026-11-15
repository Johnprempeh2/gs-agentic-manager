import { and, asc, desc, eq, gte, inArray, isNull, like, min, ne } from "drizzle-orm";
import {
  authUsers,
  companyMemberships,
  issueComments,
  issueReadStates,
  issues,
  userTourDismissals,
  type Db,
} from "@greatstone/db";
import {
  HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS,
  QUEST_CHAPTERS,
  findQuestStep,
  questChaptersFor,
  questProgress,
  type HumanCompanyMembershipRole,
  type PermissionKey,
  type QuestFeatures,
  type QuestProgress,
} from "@greatstone/shared";
import { notFound, unprocessable } from "../errors.js";
import { accessService } from "./access.js";
import { isCompanyOwnerOrAdminRole, normalizeHumanRole } from "./company-member-roles.js";
import { getCompanyLeadAgentId } from "./goals.js";
import { issueService } from "./issues.js";

/**
 * Getting started (14 Nov 2026), the quest in packages/shared/src/onboarding-quest.ts.
 *
 * Progress lives in user_tour_dismissals, the table that already keeps each
 * person's tutorials, under `quest-*` keys (seen_at is the time), so the quest
 * needs no new table and "Show all tutorials again" replays it too:
 * quest-start, quest-done, quest-skip-<chapter>, quest-v-<visit step>.
 * Event steps are never stored: they are read from the records the action
 * leaves, counted from quest-start.
 *
 * The practice task is an issue with harness_kind onboarding_practice,
 * assigned to the person: every task surface omits harness issues, and the
 * wake gate in heartbeat.ts drops any agent wake that names one.
 */

/** Members who joined from this day get the quest opened for them; earlier members open it from the account menu. */
export const QUEST_LAUNCH = new Date("2026-11-14T00:00:00.000Z");

export const PRACTICE_HARNESS_KIND = "onboarding_practice";

const START = "quest-start";
const DONE = "quest-done";
const skipKey = (chapter: string) => `quest-skip-${chapter}`;
const visitKey = (step: string) => `quest-v-${step}`;

/**
 * Features from the member access work (PR B). Off until that work is on
 * main; switch each one on where it lands, with the event that completes its
 * step in `eventSteps` below.
 */
export function detectQuestFeatures(): QuestFeatures {
  return { escalateToOwner: false, routedApprovals: false };
}

/** The rights the quest and "What you control" read, worked out by the same check every route uses. */
const RIGHTS: PermissionKey[] = [
  "tasks:assign",
  "users:invite",
  "users:manage_permissions",
  "agents:create",
  "agents:configure",
  "website:view",
  "website:edit",
  "website:publish",
  "website:deploy",
];

interface ControlContext {
  role: HumanCompanyMembershipRole;
  rights: ReadonlySet<string>;
  features: QuestFeatures;
}

/** "What you control", line by line. Each line is true or false for this person; nothing is assumed from the role name alone. */
const CONTROL_LINES: Array<{ key: string; text: string; can: (ctx: ControlContext) => boolean; when?: (ctx: ControlContext) => boolean }> = [
  { key: "read", text: "Read tasks, projects, Messages and your Desk", can: () => true },
  { key: "act", text: "Message agents, reply on tasks and give agents work", can: (ctx) => ctx.role !== "viewer" },
  { key: "assign", text: "Assign tasks to people and agents", can: (ctx) => ctx.rights.has("tasks:assign") },
  { key: "invite", text: "Invite new people", can: (ctx) => ctx.rights.has("users:invite") },
  { key: "access", text: "Change people's roles and access", can: (ctx) => ctx.rights.has("users:manage_permissions") },
  { key: "agents", text: "Hire agents and change how they are set up", can: (ctx) => ctx.rights.has("agents:create") || ctx.rights.has("agents:configure") },
  { key: "website-edit", text: "Edit website pages", can: (ctx) => ctx.rights.has("website:edit") },
  { key: "website-publish", text: "Approve and publish the website to staging", can: (ctx) => ctx.rights.has("website:publish") },
  { key: "website-deploy", text: "Deploy the website live", can: (ctx) => ctx.rights.has("website:deploy") },
  { key: "company", text: "Change company settings, and release or roll back GSAM", can: (ctx) => isCompanyOwnerOrAdminRole(ctx.role) },
  {
    key: "self-approve",
    text: "Approve your own requests",
    can: (ctx) => ctx.role === "owner",
    when: (ctx) => ctx.features.routedApprovals,
  },
];

export interface QuestControl {
  can: Array<{ key: string; text: string }>;
  cannot: Array<{ key: string; text: string }>;
  /** Who to ask for anything in `cannot`: the company's owners, then its admins. Never the person themselves. */
  askFirst: Array<{ name: string; role: string }>;
}

export interface QuestState extends QuestProgress {
  role: HumanCompanyMembershipRole;
  roleLabel: string;
  features: QuestFeatures;
  /** Open the quest for this person now: they joined after launch and have not started. */
  autoOpen: boolean;
  practiceIssueId: string | null;
  practiceArchived: boolean;
  control: QuestControl;
}

export function onboardingQuestService(db: Db, opts: { features?: () => QuestFeatures } = {}) {
  const access = accessService(db);
  const features = opts.features ?? detectQuestFeatures;

  async function membershipOf(companyId: string, userId: string) {
    const row = await access.getMembership(companyId, "user", userId);
    return row && row.status === "active" ? row : null;
  }

  async function rightsOf(companyId: string, userId: string) {
    const held = await Promise.all(RIGHTS.map((key) => access.canUser(companyId, userId, key)));
    return new Set(RIGHTS.filter((_, index) => held[index]));
  }

  async function marks(userId: string) {
    const rows = await db
      .select({ key: userTourDismissals.tourKey, at: userTourDismissals.seenAt })
      .from(userTourDismissals)
      .where(and(eq(userTourDismissals.userId, userId), like(userTourDismissals.tourKey, "quest-%")));
    return new Map(rows.map((row) => [row.key, row.at]));
  }

  async function addMark(userId: string, key: string) {
    await db.insert(userTourDismissals).values({ userId, tourKey: key, tourVersion: 1 }).onConflictDoNothing();
  }

  /** The practice task of this run of the quest (made at or after its start), archived or not. */
  async function practiceOf(companyId: string, userId: string, startedAt: Date | null) {
    if (!startedAt) return null;
    return db
      .select({ id: issues.id, status: issues.status, hiddenAt: issues.hiddenAt, completedAt: issues.completedAt, updatedAt: issues.updatedAt })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.harnessKind, PRACTICE_HARNESS_KIND),
        eq(issues.assigneeUserId, userId),
        gte(issues.createdAt, startedAt),
      ))
      .orderBy(desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  /** Event steps, from the records the actions leave, counted from the quest start. */
  async function eventSteps(
    companyId: string,
    userId: string,
    startedAt: Date,
    practice: Awaited<ReturnType<typeof practiceOf>>,
  ) {
    const done = new Map<string, Date>();
    const welcome = await db
      .select({ at: min(userTourDismissals.seenAt) })
      .from(userTourDismissals)
      .where(and(eq(userTourDismissals.userId, userId), eq(userTourDismissals.tourKey, "welcome")))
      .then((rows) => rows[0]?.at ?? null);
    if (welcome) done.set("welcome-tour", welcome);

    const leadId = await getCompanyLeadAgentId(db, companyId);
    if (leadId) {
      const sent = await db
        .select({ at: min(issueComments.createdAt) })
        .from(issueComments)
        .innerJoin(issues, eq(issues.id, issueComments.issueId))
        .where(and(
          eq(issueComments.companyId, companyId),
          eq(issueComments.authorUserId, userId),
          isNull(issueComments.deletedAt),
          gte(issueComments.createdAt, startedAt),
          eq(issues.conversationAgentId, leadId),
        ))
        .then((rows) => rows[0]?.at ?? null);
      if (sent) done.set("message-everest", sent);
    }

    const opened = await db
      .select({ at: min(issueReadStates.lastReadAt) })
      .from(issueReadStates)
      .innerJoin(issues, eq(issues.id, issueReadStates.issueId))
      .where(and(
        eq(issueReadStates.companyId, companyId),
        eq(issueReadStates.userId, userId),
        gte(issueReadStates.lastReadAt, startedAt),
        eq(issues.assigneeUserId, userId),
      ))
      .then((rows) => rows[0]?.at ?? null);
    if (opened) done.set("open-assigned-task", opened);

    if (practice) {
      const replied = await db
        .select({ at: min(issueComments.createdAt) })
        .from(issueComments)
        .where(and(eq(issueComments.issueId, practice.id), eq(issueComments.authorUserId, userId), isNull(issueComments.deletedAt)))
        .then((rows) => rows[0]?.at ?? null);
      if (replied) done.set("reply-practice", replied);
      if (practice.status === "done") done.set("finish-practice", practice.completedAt ?? practice.updatedAt);
    }
    return done;
  }

  async function control(companyId: string, userId: string, ctx: ControlContext): Promise<QuestControl> {
    const lines = CONTROL_LINES.filter((line) => !line.when || line.when(ctx));
    const people = await db
      .select({ userId: companyMemberships.principalId, role: companyMemberships.membershipRole, name: authUsers.name })
      .from(companyMemberships)
      .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
      .where(and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
        inArray(companyMemberships.membershipRole, ["owner", "admin"]),
        ne(companyMemberships.principalId, userId),
      ))
      .orderBy(asc(companyMemberships.createdAt));
    const askFirst = [...people.filter((p) => p.role === "owner"), ...people.filter((p) => p.role === "admin")]
      .map((p) => ({ name: p.name, role: HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS[normalizeHumanRole(p.role)] }));
    return {
      can: lines.filter((line) => line.can(ctx)).map(({ key, text }) => ({ key, text })),
      cannot: lines.filter((line) => !line.can(ctx)).map(({ key, text }) => ({ key, text })),
      askFirst,
    };
  }

  async function viewerOf(companyId: string, userId: string) {
    const membership = await membershipOf(companyId, userId);
    if (!membership) throw notFound("Not an active member of this company");
    const role = normalizeHumanRole(membership.membershipRole);
    const rights = await rightsOf(companyId, userId);
    return { membership, role, rights, features: features() };
  }

  async function archivePractice(companyId: string, userId: string) {
    const now = new Date();
    const open = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.harnessKind, PRACTICE_HARNESS_KIND),
        eq(issues.assigneeUserId, userId),
        isNull(issues.hiddenAt),
      ));
    for (const row of open) {
      await db
        .update(issues)
        .set(row.status === "done"
          ? { hiddenAt: now, updatedAt: now }
          : { hiddenAt: now, status: "cancelled", cancelledAt: now, updatedAt: now })
        .where(eq(issues.id, row.id));
    }
    return open.length;
  }

  /** The person's quest as they or an owner sees it. Finishing archives the practice items, once. */
  async function state(companyId: string, userId: string): Promise<QuestState> {
    const viewer = await viewerOf(companyId, userId);
    const visible = questChaptersFor({ role: viewer.role, features: viewer.features, permissions: viewer.rights });
    let stored = await marks(userId);
    const startedAt = stored.get(START) ?? null;
    let practice = await practiceOf(companyId, userId, startedAt);
    const doneAt = new Map<string, Date>();
    if (startedAt) {
      for (const [key, at] of stored) {
        if (key.startsWith("quest-v-")) doneAt.set(key.slice("quest-v-".length), at);
      }
      for (const [key, at] of await eventSteps(companyId, userId, startedAt, practice)) doneAt.set(key, at);
    }
    const skipped = new Set([...stored.keys()].filter((key) => key.startsWith("quest-skip-")).map((key) => key.slice("quest-skip-".length)));
    let progress = questProgress(visible, doneAt, skipped, startedAt, stored.get(DONE) ?? null);
    if (startedAt && !progress.finishedAt && progress.done === progress.total) {
      await addMark(userId, DONE);
      await archivePractice(companyId, userId);
      practice = await practiceOf(companyId, userId, startedAt);
      stored = await marks(userId);
      progress = questProgress(visible, doneAt, skipped, startedAt, stored.get(DONE) ?? null);
    }
    const ctx = { role: viewer.role, rights: viewer.rights, features: viewer.features };
    return {
      ...progress,
      role: viewer.role,
      roleLabel: HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS[viewer.role],
      features: viewer.features,
      autoOpen: !startedAt && viewer.membership.createdAt >= QUEST_LAUNCH,
      practiceIssueId: practice?.id ?? null,
      practiceArchived: Boolean(practice?.hiddenAt),
      control: await control(companyId, userId, ctx),
    };
  }

  /** Start (or carry on): the start mark and, for people who act, one practice task. Idempotent. */
  async function start(companyId: string, userId: string) {
    const viewer = await viewerOf(companyId, userId);
    await addMark(userId, START);
    const startedAt = (await marks(userId)).get(START)!;
    if (viewer.role !== "viewer" && !(await practiceOf(companyId, userId, startedAt))) {
      await issueService(db).create(companyId, {
        title: "Practice: reply here, then mark this task done",
        description: [
          "This is your practice task for Getting started. Only you can see it, and no agent works on it.",
          "",
          "1. Write a comment below, as you would to tell the team where something stands.",
          "2. Set the status to Done.",
          "",
          "It is archived when you finish Getting started, or when you clear your practice items.",
        ].join("\n"),
        status: "todo",
        priority: "low",
        assigneeUserId: userId,
        createdByUserId: userId,
        harnessKind: PRACTICE_HARNESS_KIND,
        originKind: "manual",
        originId: userId,
        originFingerprint: `${PRACTICE_HARNESS_KIND}:${userId}:${startedAt.getTime()}`,
      });
    }
    return state(companyId, userId);
  }

  /** A visit step the app saw. Only visit steps this person can see are accepted; event steps come from records alone. */
  async function markVisit(companyId: string, userId: string, stepKey: string) {
    const step = findQuestStep(stepKey);
    if (!step || step.how !== "visit") throw unprocessable("Not a step the app can mark");
    const viewer = await viewerOf(companyId, userId);
    const visible = questChaptersFor({ role: viewer.role, features: viewer.features, permissions: viewer.rights });
    if (!visible.some((chapter) => chapter.steps.some((entry) => entry.key === stepKey))) {
      throw unprocessable("That step is not part of your Getting started");
    }
    if (!(await marks(userId)).has(START)) throw unprocessable("Start Getting started first");
    await addMark(userId, visitKey(stepKey));
    return state(companyId, userId);
  }

  async function setChapterSkipped(companyId: string, userId: string, chapterKey: string, skipped: boolean) {
    if (!QUEST_CHAPTERS.some((chapter) => chapter.key === chapterKey)) throw unprocessable("No such chapter");
    await viewerOf(companyId, userId);
    if (skipped) await addMark(userId, skipKey(chapterKey));
    else {
      await db.delete(userTourDismissals).where(and(eq(userTourDismissals.userId, userId), eq(userTourDismissals.tourKey, skipKey(chapterKey))));
    }
    return state(companyId, userId);
  }

  async function clearPractice(companyId: string, userId: string) {
    await viewerOf(companyId, userId);
    await archivePractice(companyId, userId);
    return state(companyId, userId);
  }

  /** Replay: clear every quest mark, archive the old practice items, start again. */
  async function replay(companyId: string, userId: string) {
    await viewerOf(companyId, userId);
    await archivePractice(companyId, userId);
    await db.delete(userTourDismissals).where(and(eq(userTourDismissals.userId, userId), like(userTourDismissals.tourKey, "quest-%")));
    return start(companyId, userId);
  }

  return { state, start, markVisit, setChapterSkipped, clearPractice, replay, archivePractice };
}
