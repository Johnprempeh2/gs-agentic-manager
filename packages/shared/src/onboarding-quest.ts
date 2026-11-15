import type { HumanCompanyMembershipRole, PermissionKey } from "./constants.js";

/**
 * Getting started (14 Nov 2026): the quest every new person in GSAM plays on
 * their first days. Chapters of steps; a step completes when the person does
 * the real thing, never by pressing Next:
 * - "event" steps are seen by the server in the records the action leaves
 *   (a message, a read receipt, a comment, a status), counted from the quest start;
 * - "visit" steps are seen by the app when the page opens (`match` on the
 *   company relative path plus query), because opening a page leaves no record.
 * Server and app read this one list, so the owner's view and the person's agree.
 */

/** Features from the member access work (PR B). A step that needs one stays hidden until the server reports it. */
export const QUEST_FEATURES = ["escalateToOwner", "routedApprovals"] as const;
export type QuestFeature = (typeof QUEST_FEATURES)[number];

export interface QuestStep {
  key: string;
  title: string;
  /** What to do, in plain words. */
  body: string;
  how: "visit" | "event";
  /** Who sees the step; all roles when absent. */
  roles?: HumanCompanyMembershipRole[];
  /** Hidden until the server reports the feature. */
  requires?: QuestFeature;
  /** Hidden unless the person holds this right. */
  permission?: PermissionKey;
  /** Where "Show me" goes; `{practice}` is the person's practice task. */
  path: string;
  /** The spotlight's anchor on that page (a data-tour, data-testid or aria-label). */
  target?: string | string[];
  /** Visit steps: the page that completes it (company relative path plus query). */
  match?: RegExp;
}

export interface QuestChapter {
  key: string;
  title: string;
  /** One line under the title. */
  summary: string;
  roles?: HumanCompanyMembershipRole[];
  steps: QuestStep[];
}

const PEOPLE_WHO_ACT: HumanCompanyMembershipRole[] = ["owner", "admin", "operator"];

export const QUEST_CHAPTERS: QuestChapter[] = [
  {
    key: "find-your-way",
    title: "Find your way",
    summary: "Where things are, and how to talk to the agents.",
    steps: [
      {
        key: "welcome-tour",
        title: "Take the welcome tour",
        body: "A two minute walk round the sidebar: tasks, decisions, the website and your account menu.",
        how: "event",
        path: "/dashboard?tour=welcome",
      },
      {
        key: "open-messages",
        title: "Open Messages",
        body: "Messages holds every chat with an agent or a colleague. Everest, the lead agent, is always first.",
        how: "visit",
        path: "/dashboard",
        target: ["team-chats", "global-ask"],
        match: /^\/messages(\/|$|\?)/,
      },
      {
        key: "message-everest",
        title: "Send Everest a message",
        body: "Open Everest's chat and ask something real, such as \"What is on my plate today?\". Everest replies in the same thread.",
        how: "event",
        roles: PEOPLE_WHO_ACT,
        path: "/messages",
      },
      {
        key: "open-desk",
        title: "Open your Desk",
        body: "Your Desk shows what needs you: decisions, questions and tasks waiting on your answer. Start each day here.",
        how: "visit",
        path: "/dashboard",
        target: "nav-decisions",
        match: /^\/(desk|my-tasks)(\/|$|\?|#)/,
      },
    ],
  },
  {
    key: "your-work",
    title: "Your work",
    summary: "Open your tasks, reply, finish one, and find what has been delivered.",
    steps: [
      {
        key: "open-assigned-task",
        title: "Open a task assigned to you",
        body: "We made you a practice task. Open it to read it. It is yours alone: nobody else sees it and no agent works on it.",
        how: "event",
        roles: PEOPLE_WHO_ACT,
        path: "/issues/{practice}",
      },
      {
        key: "reply-practice",
        title: "Reply on your practice task",
        body: "Write a comment on the practice task, as you would to tell the team where something stands.",
        how: "event",
        roles: PEOPLE_WHO_ACT,
        path: "/issues/{practice}",
      },
      {
        key: "finish-practice",
        title: "Mark your practice task done",
        body: "Set the practice task's status to Done. Real tasks finish the same way.",
        how: "event",
        roles: PEOPLE_WHO_ACT,
        path: "/issues/{practice}",
      },
      {
        key: "open-deliverables",
        title: "Open a project's Deliverables",
        body: "Every project has a Deliverables tab: the documents and releases made for it. Open any project, then Deliverables.",
        how: "visit",
        path: "/projects",
        match: /^\/projects\/[^/?]+(\/deliverables|\?(.*&)?tab=deliverables)/,
      },
      {
        key: "open-releases",
        title: "Look at Website releases",
        body: "Website, then Releases, lists every version of the site: what is on staging, what is live, and who sent it.",
        how: "visit",
        permission: "website:view",
        path: "/website?tab=releases",
        match: /^\/website\?(.*&)?tab=releases/,
      },
    ],
  },
  {
    key: "what-you-control",
    title: "What you control",
    summary: "What you can do, what you cannot, and who to ask.",
    steps: [
      {
        key: "read-control",
        title: "Read what you control",
        body: "Open \"What you control\" below. It is worked out from your real access, so it changes when your access does.",
        how: "visit",
        path: "/getting-started?section=control",
        match: /^\/getting-started\?(.*&)?section=control/,
      },
    ],
  },
  {
    key: "approvals",
    title: "Approvals and escalation",
    summary: "Decide what is routed to you, and hand up what is not yours to decide.",
    steps: [
      {
        key: "escalate-practice",
        title: "Escalate a practice item to the owner",
        body: "On your practice task, use \"Escalate to owner\". This is how you hand up anything that is not yours to decide.",
        how: "event",
        roles: ["admin", "operator"],
        requires: "escalateToOwner",
        path: "/issues/{practice}",
      },
      {
        key: "approve-routed",
        title: "Approve a practice approval routed to you",
        body: "A practice approval is waiting on your Desk with your name on it. Read it and approve it.",
        how: "event",
        roles: PEOPLE_WHO_ACT,
        requires: "routedApprovals",
        path: "/desk",
      },
      {
        key: "self-approval-blocked",
        title: "See that you cannot approve your own request",
        body: "Try to approve the practice request you raised yourself. GSAM refuses: someone else must approve what you asked for.",
        how: "visit",
        roles: ["admin", "operator"],
        requires: "routedApprovals",
        path: "/desk",
      },
    ],
  },
  {
    key: "running-the-team",
    title: "Running the team",
    summary: "People, their access, and how each new person is getting on.",
    roles: ["owner", "admin"],
    steps: [
      {
        key: "open-members",
        title: "Open People and access",
        body: "Company settings, then Members, lists everyone, their role and their access.",
        how: "visit",
        path: "/company/settings/members",
        match: /^\/company\/settings\/members(\/|$|\?)/,
      },
      {
        key: "see-member-progress",
        title: "See how a new person is getting on",
        body: "Edit any member to see their Getting started progress, chapter by chapter.",
        how: "visit",
        path: "/company/settings/members",
      },
    ],
  },
];

export type QuestFeatures = Record<QuestFeature, boolean>;

export interface QuestViewer {
  role: HumanCompanyMembershipRole;
  features: QuestFeatures;
  /** The rights the person holds, for steps that need one. */
  permissions: ReadonlySet<string>;
}

const allowed = (roles: HumanCompanyMembershipRole[] | undefined, role: HumanCompanyMembershipRole) =>
  !roles || roles.includes(role);

/** The chapters and steps this person sees: their role, their rights, and the features that are on. */
export function questChaptersFor(viewer: QuestViewer): QuestChapter[] {
  return QUEST_CHAPTERS.filter((chapter) => allowed(chapter.roles, viewer.role))
    .map((chapter) => ({
      ...chapter,
      steps: chapter.steps.filter((step) =>
        allowed(step.roles, viewer.role) &&
        (!step.requires || viewer.features[step.requires]) &&
        (!step.permission || viewer.permissions.has(step.permission))),
    }))
    .filter((chapter) => chapter.steps.length > 0);
}

export function findQuestStep(key: string): QuestStep | undefined {
  for (const chapter of QUEST_CHAPTERS) {
    const step = chapter.steps.find((entry) => entry.key === key);
    if (step) return step;
  }
  return undefined;
}

/** The visit step a page completes, if any. `path` is company relative, with its query. */
export function questVisitFor(path: string, visible: QuestChapter[]): QuestStep | undefined {
  for (const chapter of visible) {
    const step = chapter.steps.find((entry) => entry.how === "visit" && entry.match?.test(path));
    if (step) return step;
  }
  return undefined;
}

export interface QuestChapterProgress {
  key: string;
  title: string;
  summary: string;
  skipped: boolean;
  /** Every step done and the chapter not skipped. */
  badge: boolean;
  steps: Array<{ key: string; title: string; body: string; path: string; target?: string | string[]; how: QuestStep["how"]; doneAt: string | null }>;
}

export interface QuestProgress {
  startedAt: string | null;
  finishedAt: string | null;
  done: number;
  total: number;
  chapters: QuestChapterProgress[];
}

/** Progress from the visible chapters, the completion times and the skipped chapters. Skipped chapters leave the total. */
export function questProgress(
  visible: QuestChapter[],
  doneAt: ReadonlyMap<string, Date>,
  skipped: ReadonlySet<string>,
  startedAt: Date | null,
  finishedAt: Date | null,
): QuestProgress {
  let done = 0;
  let total = 0;
  const chapters = visible.map((chapter): QuestChapterProgress => {
    const steps = chapter.steps.map((step) => ({
      key: step.key,
      title: step.title,
      body: step.body,
      path: step.path,
      target: step.target,
      how: step.how,
      doneAt: doneAt.get(step.key)?.toISOString() ?? null,
    }));
    const isSkipped = skipped.has(chapter.key);
    const stepsDone = steps.filter((step) => step.doneAt).length;
    if (!isSkipped) {
      total += steps.length;
      done += stepsDone;
    }
    return {
      key: chapter.key,
      title: chapter.title,
      summary: chapter.summary,
      skipped: isSkipped,
      badge: !isSkipped && stepsDone === steps.length,
      steps,
    };
  });
  return {
    startedAt: startedAt?.toISOString() ?? null,
    finishedAt: finishedAt?.toISOString() ?? null,
    done,
    total,
    chapters,
  };
}
