/**
 * Ask Everest: turn a plain-English question into an answer built from
 * GSAM's own data (Needs you, stuck tasks, the team scorecard and task
 * history). This is the instant answer; the panel can also pass the
 * question to Everest itself, whose reply arrives in its chat.
 */
import type { Issue, NeedsMe, TeamScorecard } from "@greatstone/shared";
import { plainTaskStatus } from "./global-search";

export type AskWindow = "today" | "week";

export type AskIntent =
  | { kind: "decide" }
  | { kind: "stuck"; subject: string | null }
  | { kind: "agent"; agentId: string; agentName: string; window: AskWindow }
  | { kind: "subject"; subject: string }
  | { kind: "overview" };

export interface AskAgentRef {
  id: string;
  name: string;
  status?: string | null;
}

export interface AnswerLine {
  text: string;
  detail?: string;
  href?: string;
}

export interface AskAnswer {
  headline: string;
  lines: AnswerLine[];
  /** Where to see the whole picture. */
  more?: { label: string; href: string };
}

/** Questions offered as one-tap chips before anything is typed. */
export const SUGGESTED_QUESTIONS = [
  "What do I need to decide?",
  "What is stuck?",
  "How is the team doing this week?",
] as const;

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "am", "what", "whats", "what's", "which", "who",
  "how", "why", "when", "where", "do", "does", "did", "done", "doing", "i", "me", "my", "we", "us", "our", "you",
  "your", "it", "its", "it's", "on", "in", "at", "for", "with", "of", "to", "from", "about", "and", "or", "any",
  "anything", "there", "this", "that", "these", "those", "today", "yesterday", "week", "this", "so", "far", "up",
  "work", "working", "job", "jobs", "task", "tasks", "project", "projects", "client", "clients", "going", "status",
  "update", "updates", "latest", "news", "please", "can", "could", "tell", "show", "give", "list", "all", "now",
  "right", "currently", "has", "have", "had", "happening", "happened", "progress", "team", "everest", "ask",
  "stuck", "blocked", "blocking", "blocker", "blockers", "held", "waiting", "wait", "need", "needs", "decide",
  "decision", "decisions", "approve", "approval", "approvals", "required", "require", "requires", "get", "got",
  "much", "many", "far", "doing", "lately", "recently", "last", "past", "days", "day",
]);

const DECIDE_RE = /\b(decide|decision|decisions|approve|approval|approvals|sign[- ]?off|required from (me|us)|need(s)? (from )?(me|us)|waiting (on|for) (me|us)|needs me|my attention|what do i (need|have) to)\b/i;
const STUCK_RE = /\b(stuck|blocked|blocking|blockers?|held up|on hold|behind|late|overdue)\b/i;
const WEEK_RE = /\b(week|7 days|seven days|lately|recently)\b/i;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** What the question is about once question words are removed, or null. */
export function questionSubject(question: string, ignore: readonly string[] = []): string | null {
  const skip = new Set(ignore.map((word) => word.toLowerCase()));
  // Keep the person's own capitals ("Indago"), compare in lower case.
  const kept = question
    .replace(/[^A-Za-z0-9'\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => {
      const lower = word.toLowerCase();
      return word.length > 1 && !STOP_WORDS.has(lower) && !skip.has(lower);
    });
  return kept.length > 0 ? kept.join(" ") : null;
}

function mentionedAgent(question: string, agents: readonly AskAgentRef[]): AskAgentRef | null {
  const text = ` ${words(question).join(" ")} `;
  const sorted = [...agents].sort((a, b) => b.name.length - a.name.length);
  for (const agent of sorted) {
    const name = agent.name.trim().toLowerCase();
    if (name.length >= 2 && text.includes(` ${name} `)) return agent;
    if (name.length >= 2 && text.includes(` ${name}'s `)) return agent;
  }
  return null;
}

export function classifyQuestion(question: string, agents: readonly AskAgentRef[]): AskIntent {
  const trimmed = question.trim();
  if (DECIDE_RE.test(trimmed)) return { kind: "decide" };
  const agent = mentionedAgent(trimmed, agents.filter((candidate) => candidate.status !== "terminated"));
  if (agent && !STUCK_RE.test(trimmed)) {
    return { kind: "agent", agentId: agent.id, agentName: agent.name, window: WEEK_RE.test(trimmed) ? "week" : "today" };
  }
  if (STUCK_RE.test(trimmed)) {
    return { kind: "stuck", subject: questionSubject(trimmed, agent ? [agent.name] : []) };
  }
  const subject = questionSubject(trimmed);
  if (subject) return { kind: "subject", subject };
  return { kind: "overview" };
}

function taskHref(issue: { id: string; identifier: string | null }) {
  return `/issues/${issue.identifier ?? issue.id}`;
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function startOf(window: AskWindow, now: Date): number {
  if (window === "week") return now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

export function answerDecide(needsMe: NeedsMe): AskAnswer {
  const lines: AnswerLine[] = [];
  for (const card of needsMe.decisions.slice(0, 5)) {
    lines.push({
      text: card.title,
      detail: card.reason,
      href: card.task ? taskHref({ id: card.task.id, identifier: card.task.identifier ?? null }) : "/decisions",
    });
  }
  for (const wait of needsMe.overdueWaits.slice(0, Math.max(0, 6 - lines.length))) {
    const days = Math.max(1, Math.round(wait.waitingForMs / (24 * 60 * 60 * 1000)));
    lines.push({ text: wait.title, detail: `Waiting on you for ${plural(days, "day")}: ${wait.action}`, href: taskHref(wait) });
  }
  for (const task of needsMe.assignedTasks.slice(0, Math.max(0, 8 - lines.length))) {
    lines.push({ text: task.title, detail: `Assigned to you, ${plainTaskStatus(task.status).toLowerCase()}`, href: taskHref(task) });
  }
  if (needsMe.count === 0) {
    return { headline: "Nothing needs you right now. The team is not waiting on any decision from you.", lines: [] };
  }
  const parts = [
    needsMe.decisionCount > 0 ? plural(needsMe.decisionCount, "decision") : null,
    needsMe.assignedTaskCount > 0 ? plural(needsMe.assignedTaskCount, "task") + " assigned to you" : null,
    needsMe.overdueWaits.length > 0 ? `${needsMe.overdueWaits.length} waiting more than a day` : null,
  ].filter(Boolean);
  return {
    headline: `${plural(needsMe.count, "thing")} need${needsMe.count === 1 ? "s" : ""} you: ${parts.join(", ")}.`,
    lines,
    more: { label: "Open Needs you", href: "/decisions" },
  };
}

export function answerStuck(issues: readonly Issue[], subject: string | null, agentName: (id: string | null) => string | null): AskAnswer {
  const about = subject ? ` on ${subject}` : "";
  if (issues.length === 0) {
    return { headline: `Nothing is stuck${about}. Every open task can move.`, lines: [] };
  }
  const lines = issues.slice(0, 8).map((issue) => {
    const owner = agentName(issue.assigneeAgentId);
    const blocker = issue.blockedBy?.find((entry) => entry.status !== "done" && entry.status !== "cancelled");
    const why = blocker ? `Waiting on ${blocker.identifier ?? "another task"}: ${blocker.title}` : "Stuck";
    return { text: issue.title, detail: owner ? `${why}. With ${owner}.` : `${why}.`, href: taskHref(issue) };
  });
  return {
    headline: `${plural(issues.length, "task")}${issues.length === 1 ? " is" : " are"} stuck${about}.`,
    lines,
    more: { label: "Open Blocked", href: "/inbox/blocked" },
  };
}

export function answerAgent(
  agent: { id: string; name: string },
  window: AskWindow,
  scorecard: TeamScorecard | null,
  recentIssues: readonly Issue[],
  now: Date = new Date(),
): AskAnswer {
  const since = startOf(window, now);
  const when = window === "week" ? "this week" : "today";
  const touched = recentIssues.filter((issue) => new Date(issue.updatedAt).getTime() >= since);
  const finished = touched.filter((issue) => issue.status === "done");
  const moving = touched.filter((issue) => issue.status !== "done" && issue.status !== "cancelled");
  const row = scorecard?.agents.find((candidate) => candidate.agentId === agent.id) ?? null;
  const lines: AnswerLine[] = [
    ...finished.slice(0, 5).map((issue) => ({ text: issue.title, detail: "Finished", href: taskHref(issue) })),
    ...moving.slice(0, 5).map((issue) => ({ text: issue.title, detail: plainTaskStatus(issue.status), href: taskHref(issue) })),
  ];
  let headline: string;
  if (touched.length === 0) {
    headline = `${agent.name} has not worked on any task ${when}.`;
  } else {
    headline = `${agent.name} worked on ${plural(touched.length, "task")} ${when} and finished ${finished.length}.`;
  }
  if (row) {
    const holding = [
      row.underWay > 0 ? `${row.underWay} under way` : null,
      row.inReview > 0 ? `${row.inReview} waiting for review` : null,
      row.stuck > 0 ? `${row.stuck} stuck` : null,
    ].filter(Boolean);
    if (holding.length > 0) headline += ` Right now: ${holding.join(", ")}.`;
    for (const stuck of row.stuckTasks) {
      if (!lines.some((line) => line.href === taskHref(stuck))) {
        lines.push({ text: stuck.title, detail: "Stuck", href: taskHref(stuck) });
      }
    }
  }
  return { headline, lines: lines.slice(0, 8), more: { label: `Open ${agent.name}`, href: `/agents/${agent.id}` } };
}

export function answerSubject(subject: string, issues: readonly Issue[]): AskAnswer {
  if (issues.length === 0) {
    return { headline: `I could not find any task about ${subject}.`, lines: [], more: { label: `Search for ${subject}`, href: `/search?q=${encodeURIComponent(subject)}` } };
  }
  const open = issues.filter((issue) => issue.status !== "done" && issue.status !== "cancelled");
  const stuck = open.filter((issue) => issue.status === "blocked");
  const review = open.filter((issue) => issue.status === "in_review");
  const done = issues.filter((issue) => issue.status === "done");
  const parts = [
    `${open.length} open`,
    stuck.length > 0 ? `${stuck.length} stuck` : null,
    review.length > 0 ? `${review.length} waiting for review` : null,
    `${done.length} done`,
  ].filter(Boolean);
  const order: Record<string, number> = { blocked: 0, in_review: 1, in_progress: 2, todo: 3, backlog: 4, done: 5, cancelled: 6 };
  const lines = [...issues]
    .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9))
    .slice(0, 8)
    .map((issue) => ({ text: issue.title, detail: plainTaskStatus(issue.status), href: taskHref(issue) }));
  return {
    headline: `${plural(issues.length, "task")} about ${subject}: ${parts.join(", ")}.`,
    lines,
    more: { label: `Search for ${subject}`, href: `/search?q=${encodeURIComponent(subject)}` },
  };
}

export function answerOverview(scorecard: TeamScorecard | null, needsMe: NeedsMe | null): AskAnswer {
  const lines: AnswerLine[] = [];
  let headline = "Here is where things stand.";
  if (scorecard) {
    const t = scorecard.totals;
    headline = `In the last ${scorecard.days} days the team finished ${plural(t.finished, "task")}. ${t.underWay} under way, ${t.inReview} waiting for review, ${t.stuck} stuck.`;
    const busiest = [...scorecard.agents].sort((a, b) => b.finished - a.finished).slice(0, 4);
    for (const agent of busiest) {
      lines.push({
        text: agent.name,
        detail: `Finished ${agent.finished}${agent.stuck > 0 ? `, ${agent.stuck} stuck` : ""}`,
        href: `/agents/${agent.agentId}`,
      });
    }
  }
  if (needsMe && needsMe.count > 0) {
    lines.unshift({ text: `${plural(needsMe.count, "thing")} need${needsMe.count === 1 ? "s" : ""} you`, href: "/decisions" });
  }
  return { headline, lines, more: { label: "Open the scorecard", href: "/scorecard" } };
}
