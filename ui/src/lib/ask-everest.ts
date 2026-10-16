/**
 * Ask Everest: turn a plain-English question into an answer built from
 * GSAM's own data (Needs you, stuck tasks, the team scorecard and task
 * history). This is the instant answer; the panel can also pass the
 * question to Everest itself, whose reply arrives in its chat.
 */
import type { AgentWorkDigest, CompanySearchResult, Issue, NeedsMe, TeamScorecard } from "@greatstone/shared";
import { timeAgo } from "./timeAgo";
import { plainTaskStatus } from "./global-search";

export type AskWindow = "today" | "week";

export type AskIntent =
  | { kind: "away" }
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
export const AWAY_QUESTION = "What happened since I was last here?";

export const SUGGESTED_QUESTIONS = [
  AWAY_QUESTION,
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

const AWAY_RE = /\b(since (i|we) (was|were|last) ?(last )?(here|away|gone|in|on)|since my last (visit|login|look)|while i was (away|out|gone|asleep|sleeping|off)|what did i miss|catch me up|overnight|what happened since)\b/i;
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
  if (AWAY_RE.test(trimmed)) return { kind: "away" };
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

const RECORD_KIND_WORDS: Record<string, string> = {
  organisation: "Organisation",
  person: "Person",
  client: "Client",
  product: "Product",
  image: "Image",
};

/** Clients, organisations, people and products that match, as answer lines. */
export function recordLines(records: readonly CompanySearchResult[]): AnswerLine[] {
  return records
    .filter((result) => result.type === "record" && result.record)
    .slice(0, 4)
    .map((result) => ({
      text: result.title,
      detail: [RECORD_KIND_WORDS[result.record!.kind] ?? "Record", result.record!.subtitle].filter(Boolean).join(": "),
      href: result.href,
    }));
}

export function answerSubject(subject: string, issues: readonly Issue[], records: readonly CompanySearchResult[] = []): AskAnswer {
  const found = recordLines(records);
  if (issues.length === 0) {
    const headline = found.length > 0
      ? `I found ${found[0]!.text}${found.length > 1 ? ` and ${plural(found.length - 1, "more record")}` : ""}, but no tasks about ${subject} yet.`
      : `I could not find any task about ${subject}.`;
    return { headline, lines: found, more: { label: `Search for ${subject}`, href: `/search?q=${encodeURIComponent(subject)}` } };
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
    lines: [...found, ...lines],
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

/** "Since your last visit, 9h ago" or "In the last 24 hours". */
export function awaySinceLabel(digest: Pick<AgentWorkDigest, "since" | "sinceSource">): string {
  if (digest.sinceSource === "last_visit") return `Since your last visit, ${timeAgo(digest.since)}`;
  if (digest.sinceSource === "default_window") return "In the last 24 hours";
  return `Since ${timeAgo(digest.since)}`;
}

/** Stuck tasks that became stuck (or changed while stuck) inside the window. */
export function newlyStuck(blocked: readonly Issue[], since: string): Issue[] {
  const from = new Date(since).getTime();
  return blocked.filter((issue) => issue.status === "blocked" && new Date(issue.updatedAt).getTime() >= from);
}

/**
 * "Since you were away": what finished, what got stuck and what now needs
 * you, from the agent work digest, stuck tasks and Needs you.
 */
export function answerAway(digest: AgentWorkDigest, blocked: readonly Issue[], needsMe: NeedsMe | null): AskAnswer {
  const stuck = newlyStuck(blocked, digest.since);
  const finished = digest.agents
    .flatMap((agent) => agent.items.filter((item) => item.kind === "task_finished").map((item) => ({ item, agent: agent.agentName })))
    .sort((a, b) => new Date(b.item.at).getTime() - new Date(a.item.at).getTime());
  const needs = needsMe?.count ?? 0;
  const parts = [
    `${plural(digest.counts.tasksFinished, "task")} finished`,
    `${stuck.length} got stuck`,
    `${plural(needs, "thing")} need${needs === 1 ? "s" : ""} you`,
  ];
  if (digest.counts.failures > 0) parts.push(`${plural(digest.counts.failures, "run")} failed`);
  const lines: AnswerLine[] = [];
  for (const decision of needsMe?.decisions.slice(0, 3) ?? []) {
    lines.push({
      text: decision.title,
      detail: `Needs you: ${decision.reason}`,
      href: decision.task ? taskHref({ id: decision.task.id, identifier: decision.task.identifier ?? null }) : "/decisions",
    });
  }
  for (const issue of stuck.slice(0, 3)) {
    lines.push({ text: issue.title, detail: "Got stuck", href: taskHref(issue) });
  }
  for (const { item, agent } of finished.slice(0, 3)) {
    lines.push({
      text: item.label,
      detail: `Finished by ${agent}`,
      href: item.issueId ? taskHref({ id: item.issueId, identifier: item.issueIdentifier }) : undefined,
    });
  }
  const quiet = digest.counts.tasksFinished === 0 && stuck.length === 0 && needs === 0 && digest.counts.failures === 0;
  return {
    headline: quiet
      ? `${awaySinceLabel(digest)}: nothing new. Nothing finished, nothing got stuck and nothing needs you.`
      : `${awaySinceLabel(digest)}: ${parts.join(", ")}.`,
    lines,
    more: { label: "See everything that happened", href: "/since-last-visit" },
  };
}

/* Follow-up questions: "and which of those are overdue?" narrows the last answer. */

export type AskRefinement =
  | { kind: "overdue" }
  | { kind: "stuck" }
  | { kind: "review" }
  | { kind: "done" }
  | { kind: "open" }
  | { kind: "urgent" }
  | { kind: "agent"; agentId: string; agentName: string };

/** The tasks behind an answer, kept so the next question can narrow them. */
export interface AskTaskSet {
  /** How the set reads in a sentence: "stuck tasks", "tasks about Indago". */
  about: string;
  issues: Issue[];
}

const FOLLOW_UP_RE = /^\s*(and|but|also|so|ok|okay|then|what about|how about)\b|\b(those|these|them|which ones|that list|the ones|of them)\b/i;
const OVERDUE_RE = /\b(overdue|late|past (their |the )?due|missed (the |their )?deadlines?|behind schedule)\b/i;
const STUCK_ONLY_RE = /\b(stuck|blocked)\b/i;
const REVIEW_RE = /\b(review|reviewed|checking)\b/i;
const DONE_RE = /\b(done|finished|complete|completed)\b/i;
const OPEN_RE = /\b(open|still going|not done|in progress|under way|underway)\b/i;
const URGENT_RE = /\b(urgent|high priority|critical|important)\b/i;

/** How a task set from an intent reads, or null when the answer has no task list to narrow. */
export function taskSetLabel(intent: AskIntent): string | null {
  switch (intent.kind) {
    case "stuck":
      return intent.subject ? `stuck tasks on ${intent.subject}` : "stuck tasks";
    case "away":
      return "stuck tasks";
    case "agent":
      return `tasks ${intent.agentName} worked on`;
    case "subject":
      return `tasks about ${intent.subject}`;
    default:
      return null;
  }
}

/** A follow-up that narrows the last answer, or null when the question stands on its own. */
export function followUpRefinement(question: string, agents: readonly AskAgentRef[]): AskRefinement | null {
  const trimmed = question.trim();
  if (!FOLLOW_UP_RE.test(trimmed)) return null;
  if (OVERDUE_RE.test(trimmed)) return { kind: "overdue" };
  if (URGENT_RE.test(trimmed)) return { kind: "urgent" };
  if (REVIEW_RE.test(trimmed)) return { kind: "review" };
  if (STUCK_ONLY_RE.test(trimmed)) return { kind: "stuck" };
  if (DONE_RE.test(trimmed) && !/\bnot done\b/i.test(trimmed)) return { kind: "done" };
  if (OPEN_RE.test(trimmed)) return { kind: "open" };
  const agent = mentionedAgent(trimmed, agents.filter((candidate) => candidate.status !== "terminated"));
  if (agent) return { kind: "agent", agentId: agent.id, agentName: agent.name };
  return null;
}

function localDay(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function isOpen(issue: Issue) {
  return issue.status !== "done" && issue.status !== "cancelled";
}

/** True when an open task's due date has passed. */
export function isOverdue(issue: Issue, now: Date = new Date()): boolean {
  return Boolean(issue.dueDate) && isOpen(issue) && issue.dueDate! < localDay(now);
}

function daysLate(dueDate: string, now: Date): number {
  const due = new Date(`${dueDate}T00:00:00`).getTime();
  const today = new Date(`${localDay(now)}T00:00:00`).getTime();
  return Math.max(1, Math.round((today - due) / (24 * 60 * 60 * 1000)));
}

function refinementMatches(refinement: AskRefinement, issue: Issue, now: Date): boolean {
  switch (refinement.kind) {
    case "overdue":
      return isOverdue(issue, now);
    case "stuck":
      return issue.status === "blocked";
    case "review":
      return issue.status === "in_review";
    case "done":
      return issue.status === "done";
    case "open":
      return isOpen(issue);
    case "urgent":
      return isOpen(issue) && (issue.priority === "critical" || issue.priority === "high");
    case "agent":
      return issue.assigneeAgentId === refinement.agentId;
  }
}

function refinementPhrase(refinement: AskRefinement, one: boolean): string {
  const be = one ? "is" : "are";
  switch (refinement.kind) {
    case "overdue":
      return `${be} overdue`;
    case "stuck":
      return `${be} stuck`;
    case "review":
      return `${be} waiting for review`;
    case "done":
      return `${be} done`;
    case "open":
      return `${be} still open`;
    case "urgent":
      return `${be} urgent`;
    case "agent":
      return `${be} with ${refinement.agentName}`;
  }
}

/** The tasks a follow-up keeps. */
export function narrowTasks(refinement: AskRefinement, issues: readonly Issue[], now: Date = new Date()): Issue[] {
  return issues.filter((issue) => refinementMatches(refinement, issue, now));
}

/** The last answer's tasks, narrowed by a follow-up. */
export function answerFollowUp(
  refinement: AskRefinement,
  set: AskTaskSet,
  agentName: (id: string | null) => string | null,
  now: Date = new Date(),
): AskAnswer {
  const matched = narrowTasks(refinement, set.issues, now);
  const total = set.issues.length;
  if (total === 0) {
    return { headline: `There were no ${set.about} to narrow down.`, lines: [] };
  }
  if (matched.length === 0) {
    const none = total === 1
      ? `That task ${refinementPhrase(refinement, true).replace(/^is /, "is not ")}.`
      : `None of those ${total} ${set.about} ${refinementPhrase(refinement, false)}.`;
    const noDates = refinement.kind === "overdue" && set.issues.every((issue) => !issue.dueDate)
      ? " None of them has a due date yet."
      : "";
    return { headline: `${none}${noDates}`, lines: [] };
  }
  const lines = matched.slice(0, 8).map((issue) => {
    const owner = agentName(issue.assigneeAgentId);
    const status = refinement.kind === "overdue" && issue.dueDate
      ? `Due ${issue.dueDate}, ${plural(daysLate(issue.dueDate, now), "day")} late`
      : plainTaskStatus(issue.status);
    return { text: issue.title, detail: owner && refinement.kind !== "agent" ? `${status}. With ${owner}.` : `${status}.`, href: taskHref(issue) };
  });
  return {
    headline: total === 1
      ? `That task ${refinementPhrase(refinement, true)}.`
      : matched.length === total
        ? `All ${total} of those ${set.about} ${refinementPhrase(refinement, false)}.`
        : `${matched.length} of those ${total} ${set.about} ${refinementPhrase(refinement, matched.length === 1)}.`,
    lines,
  };
}

/* "Ask Everest about this": a page hands the panel what it is about. */

export interface AskContext {
  /** Shown on the chip: "This week at Greatstone", "Acme Ltd". */
  label: string;
  /** What Everest is told the question is about. */
  summary: string;
  /** A name the instant answer can search tasks for, such as a client. */
  subject?: string;
  /** One-tap questions for this page. */
  suggestions?: string[];
}

/** Point an instant answer at the page's subject when the question does not name one. */
export function intentWithContext(intent: AskIntent, context: AskContext | null): AskIntent {
  const subject = context?.subject?.trim();
  if (!subject) return intent;
  if (intent.kind === "stuck" && !intent.subject) return { kind: "stuck", subject };
  if (intent.kind === "subject" || intent.kind === "overview") return { kind: "subject", subject };
  return intent;
}

/** The question as Everest receives it: with the page it came from, or the question it follows up. */
export function liveQuestionText(question: string, options: { context?: AskContext | null; followsUp?: string | null } = {}): string {
  const parts = [question];
  if (options.followsUp) parts.push(`(Following up on: "${options.followsUp}")`);
  if (options.context) parts.push(`\n\nAsked from ${options.context.label}:\n${options.context.summary}`);
  return parts.join(" ").replace(/ \n/g, "\n");
}

/** What Everest is told when asked about a pipeline item, such as a client. */
export function pipelineItemAskContext(item: {
  title: string;
  pipelineName: string;
  stageName: string;
  statusLabel: string;
  isClient: boolean;
}): AskContext {
  const what = item.isClient ? "client" : "item";
  return {
    label: item.title,
    subject: item.title,
    summary: `The ${what} "${item.title}" in the ${item.pipelineName} pipeline. Stage: ${item.stageName}. Status: ${item.statusLabel}.`,
    suggestions: [
      `What is next for ${item.title}?`,
      `What is ${item.title} waiting on?`,
      `What is stuck on ${item.title}?`,
    ],
  };
}

/** What Ask Everest gets when opened from an organisation page: who they are, the people and the deals. */
export function organisationAskContext(org: {
  name: string;
  industry: string | null;
  country: string | null;
  statusLabel: string;
  contacts: ReadonlyArray<{ name: string; role: string | null }>;
  deals: ReadonlyArray<{ title: string; pipelineName: string; stageName: string }>;
}): AskContext {
  const about = [org.industry, org.country].filter(Boolean).join(", ");
  const people = org.contacts.slice(0, 6).map((contact) => (contact.role ? `${contact.name} (${contact.role})` : contact.name));
  const deals = org.deals.slice(0, 6).map((deal) => `${deal.title}: ${deal.stageName} in ${deal.pipelineName}`);
  return {
    label: org.name,
    subject: org.name,
    summary: [
      `The organisation "${org.name}"${about ? ` (${about})` : ""}. Status: ${org.statusLabel}.`,
      people.length > 0 ? `People: ${people.join("; ")}.` : null,
      deals.length > 0 ? `Deals: ${deals.join("; ")}.` : null,
    ].filter(Boolean).join("\n"),
    suggestions: [
      `What is happening with ${org.name}?`,
      `What is stuck on ${org.name}?`,
      `What should we do next with ${org.name}?`,
    ],
  };
}
