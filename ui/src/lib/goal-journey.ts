import type { Agent, GoalBlocker, GoalBlockerActor, GoalMilestone, GoalWithProgress } from "@greatstone/shared";

/**
 * Goals page helpers (GRE-191): one health word per goal, scoreboard order, and
 * the stops on the journey map. Colour on the page comes only from the health,
 * so every rule for "done / on track / at risk / blocked" lives here.
 */

export type GoalHealth = "done" | "on_track" | "at_risk" | "blocked" | "not_started";

export const GOAL_HEALTH_LABEL: Record<GoalHealth, string> = {
  done: "Done",
  on_track: "On track",
  at_risk: "At risk",
  blocked: "Blocked",
  not_started: "Not started",
};

/** CSS custom property (index.css) that seeds `--sc` for each health. */
export const GOAL_HEALTH_COLOR: Record<GoalHealth, string> = {
  done: "var(--goal-done)",
  on_track: "var(--goal-on-track)",
  at_risk: "var(--goal-at-risk)",
  blocked: "var(--goal-blocked)",
  not_started: "var(--goal-ahead)",
};

/** Points a goal may lag behind a straight line to its target date before it is "at risk". */
const SCHEDULE_SLACK_PERCENT = 25;

const DAY_MS = 24 * 60 * 60 * 1000;

/** "YYYY-MM-DD" as a local calendar date (no UTC shift). */
export function parseCalendarDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Whole days from today to the target date; negative once it has passed. */
export function daysToTarget(targetDate: string | null, now: Date = new Date()): number | null {
  const target = parseCalendarDate(targetDate);
  if (!target) return null;
  return Math.round((target.getTime() - startOfDay(now).getTime()) / DAY_MS);
}

export function formatTargetDate(targetDate: string | null): string | null {
  const target = parseCalendarDate(targetDate);
  if (!target) return null;
  return target.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

type HealthInput = Pick<GoalWithProgress, "status" | "progress" | "blockers" | "targetDate" | "createdAt">;

export function goalHealth(goal: HealthInput, now: Date = new Date()): GoalHealth {
  const { progress } = goal;
  if (goal.status === "achieved" || progress.percent === 100) return "done";
  // Everything that is left is stuck: nothing can move until a blocker clears.
  if (progress.blocked > 0 && progress.open === 0) return "blocked";

  const days = daysToTarget(goal.targetDate, now);
  if (days != null && days < 0) return "at_risk";
  if (goal.blockers.length > 0) return "at_risk";

  const target = parseCalendarDate(goal.targetDate);
  if (target && progress.percent != null) {
    const start = new Date(goal.createdAt).getTime();
    const span = target.getTime() - start;
    if (span > 0) {
      const expected = Math.min(100, Math.max(0, ((now.getTime() - start) / span) * 100));
      if (expected - progress.percent > SCHEDULE_SLACK_PERCENT) return "at_risk";
    }
  }

  if (goal.status === "planned" && !progress.percent) return "not_started";
  return "on_track";
}

// ── Main blocker sentence (GRE-226) ────────────────────────────────────────

const FILE_EXTENSIONS = "sh|bash|zsh|ts|tsx|js|jsx|mjs|cjs|json|md|mdx|ya?ml|py|rb|go|rs|sql|toml|env|txt|css|html|lock|log|ps1";
const FILE_NAME = new RegExp(
  String.raw`(?:~|\.{1,2})\/[\w.@/-]+|\/?(?:[\w.@-]+\/){2,}[\w.@-]*|[\w.@/-]*\.(?:${FILE_EXTENSIONS})\b`,
  "gi",
);
const TICKET_ID = /\(?\b[A-Z][A-Z0-9]{1,9}-\d+\b\)?/g;
const HTML_TAG =
  /<\/?(?:a|b|i|u|s|p|br|hr|em|strong|code|pre|kbd|div|span|img|ul|ol|li|h[1-6]|table|thead|tbody|tr|td|th|details|summary|sub|sup|blockquote)(?:\s*\/?|\s+[^<>]*=[^<>]*)>/gi;
const SHORT_TITLE_CHARS = 60;
const NOTE_CHARS = 140;

/**
 * Plain words for a card sentence: no code formatting, file names, `<tags>`,
 * links or ticket numbers. Placeholders like `<stable tag>` keep their words.
 */
export function plainText(text: string): string {
  let out = text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(HTML_TAG, " ")
    .replace(/<([^<>]*)>/g, "$1")
    .replace(FILE_NAME, " ")
    .replace(TICKET_ID, " ")
    .replace(/(^|\s)[#>]+\s/g, "$1")
    .replace(/(\*\*|__|\*|~~)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/[`<>*]/g, "");
  out = out
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?)])/g, "$1")
    .replace(/([(])\s+/g, "$1")
    .replace(/^[\s:;,.·—–-]+/, "")
    .replace(/[\s:;,·—–-]+$/, "")
    .trim();
  return out ? out[0].toUpperCase() + out.slice(1) : "";
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.—–-]+$/, "")}…`;
}

/** A task title short enough to sit inside a sentence. */
export function shortTitle(title: string): string {
  return clip(plainText(title) || "A task", SHORT_TITLE_CHARS);
}

function firstSentence(text: string): string {
  const plain = plainText(text.replace(/^\s*blocked\b\s*[:.,-]?\s*/i, ""));
  const end = plain.search(/[.!?](\s|$)/);
  return clip(end > 0 ? plain.slice(0, end) : plain, NOTE_CHARS);
}

function endSentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

function actorLabel(actor: GoalBlockerActor | null, fallback: string): string {
  if (!actor) return fallback;
  if (actor.name) return actor.name;
  return actor.type === "agent" ? "its agent" : "the board";
}

/**
 * One plain sentence: what is stuck, why, and who must act next.
 * Ticket numbers stay out of the sentence; the card shows them as links.
 */
export function blockerSentence(blocker: GoalBlocker): string {
  if (blocker.kind === "check_in") return endSentence(plainText(blocker.text) || "A blocker was named in the last check-in");
  const stuck = shortTitle(blocker.title);
  switch (blocker.reason) {
    case "waiting_on_issue": {
      const waitingOn = blocker.waitingOn ? `"${shortTitle(blocker.waitingOn.title)}"` : "another task";
      if (blocker.waitingOn?.status === "cancelled") {
        return `${stuck} waits on ${waitingOn}, which was cancelled; someone must remove that link.`;
      }
      // Who must act comes early so the two-line card still shows it.
      if (!blocker.actor) return `${stuck} waits for ${waitingOn}, which nobody owns yet.`;
      return `${stuck} waits for ${actorLabel(blocker.actor, "")} to finish ${waitingOn}.`;
    }
    case "waiting_on_person":
      return `${stuck} waits for ${actorLabel(blocker.actor, "the board")} to answer or approve.`;
    case "no_owner":
      return `${stuck} is blocked and nobody owns it; it needs an owner.`;
    case "failed_run":
      return `${stuck} stopped after a failed run; ${actorLabel(blocker.actor, "its owner")} must retry or fix it.`;
    default: {
      const note = blocker.note ? firstSentence(blocker.note) : "";
      const actor = actorLabel(blocker.actor, "its owner");
      if (note) return `${stuck} is blocked: ${endSentence(note)} ${actor} must act next.`;
      return `${stuck} is blocked; ${actor} must say why and clear it.`;
    }
  }
}

export type MainBlockerSummary =
  | { kind: "blocker"; blocker: GoalBlocker; sentence: string; moreCount: number }
  | { kind: "open"; sentence: string };

/**
 * What the goal card says under "Main blocker". The server ranks blockers,
 * so the first one is the main one. A goal at risk with no blocked task says
 * so instead of naming a task.
 */
export function mainBlockerSummary(
  goal: Pick<GoalWithProgress, "blockers" | "progress">,
  health: GoalHealth,
): MainBlockerSummary | null {
  const [first, ...rest] = goal.blockers;
  if (first) return { kind: "blocker", blocker: first, sentence: blockerSentence(first), moreCount: rest.length };
  if ((health === "at_risk" || health === "blocked") && goal.progress.total > 0) {
    const open = goal.progress.open;
    if (open === 0) return null;
    const noun = goal.progress.total === 1 ? "task" : "tasks";
    return { kind: "open", sentence: `No blocker. ${open} of ${goal.progress.total} ${noun} still open.` };
  }
  return null;
}

/** Anchor on the goal page that lists every blocker. */
export const GOAL_BLOCKERS_ANCHOR = "goal-blockers";

/** "6 of 16 tasks left", "11 days left", or null when there is nothing to count. */
export function remainingLabel(goal: Pick<GoalWithProgress, "progress" | "targetValue" | "currentValue" | "unit">): string | null {
  const { progress } = goal;
  if (progress.source === "number" && goal.targetValue != null) {
    const left = Math.max(0, goal.targetValue - (goal.currentValue ?? 0));
    const unit = goal.unit?.trim();
    return unit ? `${formatNumber(left)} ${unit} left` : `${formatNumber(left)} left`;
  }
  if (progress.source === "issues" && progress.total > 0) {
    const left = progress.open + progress.blocked;
    if (left === 0) return "All tasks done";
    return `${left} of ${progress.total} ${progress.total === 1 ? "task" : "tasks"} left`;
  }
  return null;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export interface ScoreboardEntry<G extends GoalWithProgress = GoalWithProgress> {
  goal: G;
  health: GoalHealth;
  /** Every live descendant, parents before their children. */
  subGoals: Array<{ goal: G; health: GoalHealth }>;
}

const HEALTH_RANK: Record<GoalHealth, number> = {
  blocked: 0,
  at_risk: 1,
  on_track: 2,
  not_started: 3,
  done: 4,
};

/**
 * Top-level goals first (worst health first, then oldest), each with its
 * sub-goals. Cancelled goals are never shown; achieved goals only on request.
 * A goal whose parent is hidden becomes top-level so nothing disappears.
 */
export function buildScoreboard<G extends GoalWithProgress>(
  goals: readonly G[],
  { includeAchieved = false, now = new Date() }: { includeAchieved?: boolean; now?: Date } = {},
): ScoreboardEntry<G>[] {
  const visible = goals.filter(
    (goal) => goal.status !== "cancelled" && (includeAchieved || goal.status !== "achieved"),
  );
  const ids = new Set(visible.map((goal) => goal.id));
  const children = new Map<string, G[]>();
  const roots: G[] = [];
  for (const goal of visible) {
    if (goal.parentId && ids.has(goal.parentId) && goal.parentId !== goal.id) {
      const list = children.get(goal.parentId) ?? [];
      list.push(goal);
      children.set(goal.parentId, list);
    } else {
      roots.push(goal);
    }
  }

  const byAge = (a: G, b: G) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id);

  const descendants = (rootId: string): G[] => {
    const out: G[] = [];
    const seen = new Set<string>([rootId]);
    const walk = (id: string) => {
      for (const child of [...(children.get(id) ?? [])].sort(byAge)) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        out.push(child);
        walk(child.id);
      }
    };
    walk(rootId);
    return out;
  };

  return roots
    .map((goal) => ({
      goal,
      health: goalHealth(goal, now),
      subGoals: descendants(goal.id).map((sub) => ({ goal: sub, health: goalHealth(sub, now) })),
    }))
    .sort((a, b) => HEALTH_RANK[a.health] - HEALTH_RANK[b.health] || byAge(a.goal, b.goal));
}

/** Mirrors the server: the oldest live agent that reports to no one. */
export function leadAgentId(agents: readonly Agent[] | undefined): string | null {
  const live = (agents ?? []).filter((agent) => agent.status !== "terminated" && !agent.reportsTo);
  live.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id),
  );
  return live[0]?.id ?? null;
}

// ── Journey map ────────────────────────────────────────────────────────────

export type JourneyStopKind = "done" | "here" | "active" | "blocked" | "ahead";

export interface JourneyStop {
  key: string;
  kind: JourneyStopKind;
  label: string;
  /** Set when the stop is one task; grouped stops link nowhere. */
  milestone: GoalMilestone | null;
  /** Tasks folded into this stop (1 for a single task). */
  count: number;
  /** Titles of the folded tasks, for the hover card. */
  titles: string[];
}

export interface Journey {
  stops: JourneyStop[];
  /** Index of the stop the filled route reaches; -1 when nothing is done yet. */
  reachedIndex: number;
}

export const JOURNEY_MAX_STOPS = 9;

function milestoneKind(status: GoalMilestone["status"]): Exclude<JourneyStopKind, "here"> {
  if (status === "done") return "done";
  if (status === "blocked") return "blocked";
  if (status === "in_progress" || status === "in_review") return "active";
  return "ahead";
}

function singleStop(milestone: GoalMilestone): JourneyStop {
  return {
    key: milestone.id,
    kind: milestoneKind(milestone.status),
    label: milestone.title,
    milestone,
    count: 1,
    titles: [milestone.title],
  };
}

function groupStop(key: string, kind: JourneyStopKind, label: string, rows: GoalMilestone[]): JourneyStop {
  return { key, kind, label, milestone: null, count: rows.length, titles: rows.map((row) => row.title) };
}

/**
 * Turns the server's milestone order (done, in flight, blocked, not started)
 * into map stops. Long journeys fold older done tasks into one stop and the
 * far end into "+N more" so the map stays readable. The first task in flight
 * is "we are here"; with none in flight the marker sits on the last done stop.
 */
export function buildJourney(milestones: readonly GoalMilestone[], maxStops = JOURNEY_MAX_STOPS): Journey {
  const rows = milestones.filter((row) => row.status !== "cancelled");
  const done = rows.filter((row) => row.status === "done");
  const rest = rows.filter((row) => row.status !== "done");

  let stops: JourneyStop[] = [];
  if (rows.length <= maxStops) {
    stops = rows.map(singleStop);
  } else {
    const keepDone = Math.min(done.length, 2);
    const foldedDone = done.slice(0, done.length - keepDone);
    if (foldedDone.length > 0) {
      stops.push(groupStop("done-group", "done", `${foldedDone.length} done`, foldedDone));
    }
    stops.push(...done.slice(done.length - keepDone).map(singleStop));
    const room = Math.max(1, maxStops - stops.length);
    if (rest.length <= room) {
      stops.push(...rest.map(singleStop));
    } else {
      stops.push(...rest.slice(0, room - 1).map(singleStop));
      const folded = rest.slice(room - 1);
      stops.push(groupStop("ahead-group", "ahead", `+${folded.length} more`, folded));
    }
  }

  const firstActive = stops.findIndex((stop) => stop.kind === "active");
  if (firstActive >= 0) {
    stops[firstActive] = { ...stops[firstActive], kind: "here" };
    return { stops, reachedIndex: firstActive };
  }
  let lastDone = -1;
  stops.forEach((stop, index) => {
    if (stop.kind === "done") lastDone = index;
  });
  return { stops, reachedIndex: lastDone };
}

export const JOURNEY_STOP_LABEL: Record<JourneyStopKind, string> = {
  done: "Done",
  here: "We are here",
  active: "In progress",
  blocked: "Blocked",
  ahead: "Ahead",
};
