/**
 * Ask Everest: turn a plain-English question into an answer built from
 * GSAM's own data (Needs you, stuck tasks, the team scorecard and task
 * history). This is the instant answer; the panel can also pass the
 * question to Everest itself, whose reply arrives in its chat.
 */
import type { AgentWorkDigest, CompanyClientBrief, CompanyClosingDealsResponse, CompanyPipelineSummaryResponse, CompanyWonLostResponse, CompanyQuietClientsResponse, CompanyRecentClientActivityResponse, CompanySearchResult, Issue, NeedsMe, TeamScorecard } from "@greatstone/shared";
import { ORGANISATION_STATUS_LABELS, type OrganisationStatus } from "@greatstone/shared";
import { timeAgo } from "./timeAgo";
import { plainTaskStatus } from "./global-search";
import { formatNumber, formatShortDate } from "./utils";

export type AskWindow = "today" | "week";

export type AskIntent =
  | { kind: "away" }
  | { kind: "decide" }
  | { kind: "stuck"; subject: string | null }
  | { kind: "agent"; agentId: string; agentName: string; window: AskWindow }
  | { kind: "subject"; subject: string }
  /** "When did we last speak to Acme?": imported notes, calls and meetings. */
  | { kind: "history"; subject: string | null }
  /** "Who is our contact at Acme?": the people we hold for a client. */
  | { kind: "people"; subject: string | null }
  /** "Which clients have gone quiet?": open deals with no contact for `days` days. */
  | { kind: "quiet"; days: number }
  /** "Which deals are closing this month?": open deals by expected close date within `days` (0 means only those past their date). */
  | { kind: "closing"; days: number }
  /** "How is the pipeline looking?": open deals per stage, value and the largest deals. */
  | { kind: "pipeline"; view: "stages" | "owners" | "missing" | "owner"; owner?: string }
  /** "What did we win this month?": deals won and lost in the last `days` days. */
  | { kind: "results"; days: number }
  /** "Tell me about Acme": a one-glance brief on an organisation. */
  | { kind: "brief"; subject: string | null }
  /** "What calls did we have this week?": recent notes, calls and meetings across clients. */
  | { kind: "activity"; days: number }
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
  "Which clients have gone quiet?",
  "How is the team doing this week?",
] as const;

/** Client and deal questions, offered as a second row of chips. */
export const SALES_QUESTIONS = [
  "Which deals are closing this month?",
  "How is the pipeline looking?",
  "What did we win this month?",
  "Who has the most deals?",
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
const HISTORY_WORDS = [
  "discuss", "discussed", "discussing", "talk", "talked", "talking", "spoke", "speak", "spoken", "call", "called",
  "calls", "meeting", "meetings", "met", "note", "notes", "contact", "contacted", "email", "emailed", "emails",
  "heard", "hear", "conversation", "conversations", "history", "said", "say", "agree", "agreed", "with",
];
const HISTORY_RE = /\b(discuss(ed|ing)?|talk(ed|ing)?|spoke|spoken|speak|call(ed|s)?|meetings?|met|notes?|contacted|emailed|emails?|heard from|hear from|conversations?|history|what did (we|they) (say|agree))\b/i;
const PEOPLE_WORDS = ["who", "whom", "contact", "contacts", "people", "person", "know", "speak", "talk", "call", "email", "address", "phone", "number", "main", "key", "decision", "maker", "makers", "should", "best"];
const PEOPLE_RE = /\b(who do we know|who should (i|we) (speak|talk) to|who (do|should) (i|we) (call|email|contact)|contacts? (at|for)|people at|our contact|main contact|decision makers?|email (address )?for|phone (number )?for)\b/i;
const BRIEF_WORDS = ["tell", "brief", "catch", "know", "background", "summary", "summarise", "summarize", "overview", "profile"];
const BRIEF_RE = /\b(tell me about|brief me (on|about)|catch me up on|what do we know (about|on)|background on|(give me )?(a |an )?(summary|overview|profile) of|summari[sz]e)\b/i;
const QUIET_RE = /\b(gone (quiet|cold|silent)|went (quiet|cold)|going (quiet|cold)|(have not|haven't|not) (we |i )?(heard from|spoken to|spoken with|talked to|contacted)|no contact|neglected|cold (clients|deals|leads)|(who|which (clients|deals|leads)) (should|do|must) (i|we) (chase|follow up)|need(s)? chasing|chase up|to chase|follow[- ]ups? due)\b/i;
const CLOSING_RE = /\b(closing|close (this|next|by|in|soon|before|within)|due to close|expected to close|expected close|close dates?|past (their |the )?close|slipp(ed|ing)|forecast)\b/i;
const RESULTS_RE = /\b(what (did|have) we (win|won|lose|lost)|(deals?|leads?) (did )?we (won|lost|win|lose)|(won|lost|win|lose) (this|last) (week|month|quarter|year)|(our|any|recent) (wins|losses)|lost (deals|leads|reasons?)|won (deals|leads)|why (are|did|have) we (losing|lose|lost)|win rate|what (have we|did we) close[d]?)\b/i;
const MISSING_RE = /\b(missing (a |an )?(close dates?|values?|owners?|organisations?)|(no|without (a |an )?) (close date|value|owner|organisation)|(pipeline|crm|deal|data) (hygiene|clean ?up|gaps|quality)|what('s| is) missing (from|in) (the |our )?(pipeline|crm|deals))\b/i;
const OWNERS_RE = /\b((deals|leads|pipeline) (by|per) (owner|rep|salesperson|person)|by owner|per owner|who (owns|has) the most (deals|leads)|whose deals|who owns (which|what) deals)\b/i;
const NOT_A_NAME = new Set(["our", "my", "your", "their", "his", "her", "its", "the", "a", "an", "all", "open", "which", "what", "whose", "who", "each", "every", "this", "that", "today", "week", "month", "quarter", "year", "everyone", "anyone", "someone", "me", "us", "them", "i", "we", "you", "they", "team", "company", "client", "clients", "customer", "customers", "now", "currently", "at", "in", "on", "for", "and", "or", "deals", "leads"]);
const OWNED_BY_RE = /\b(?:deals|leads|opportunities|pipeline)(?: that| which)?(?: are| is)? (?:owned by|belonging to|assigned to|run by|looked after by) ([a-z][a-z'-]*)(?: ([a-z][a-z'-]*))?/i;
const DOES_OWN_RE = /\bwhat (?:deals |leads )?(?:does|is) ([a-z][a-z'-]*)(?: ([a-z][a-z'-]*))? (?:own|owning|working on|handling)\b/i;
const POSSESSIVE_RE = /(?:\b([a-z][a-z-]*) )?\b([a-z][a-z-]*)(?:'s|') (?:deals|leads|pipeline|opportunities)\b/i;

function titleCase(name: string): string {
  return name.replace(/(^|[ '-])([a-z])/g, (_, lead: string, char: string) => lead + char.toUpperCase());
}

function isName(word: string | undefined): word is string {
  return Boolean(word) && !NOT_A_NAME.has(word!.toLowerCase());
}

/** The owner named in "Sarah's deals", "deals owned by Sarah Jones" or "what does Sarah own". */
export function ownerInQuestion(question: string): string | null {
  const named = OWNED_BY_RE.exec(question) ?? DOES_OWN_RE.exec(question);
  if (named) {
    if (!isName(named[1])) return null;
    return titleCase(isName(named[2]) ? `${named[1]} ${named[2]}` : named[1]);
  }
  const possessive = POSSESSIVE_RE.exec(question);
  if (!possessive || !isName(possessive[2])) return null;
  // "Sarah Jones's deals": keep a capitalised first name, but not the question's opening word ("List Sarah's deals").
  const first = possessive[1];
  const keepFirst = isName(first) && /^[A-Z]/.test(first) && possessive.index > 0;
  return titleCase(keepFirst ? `${first} ${possessive[2]}` : possessive[2]!);
}

const PIPELINE_RE = /\b(how('s| is| does) (the |our |my )?pipeline|pipeline (looking|look|summary|overview|health|value|worth|total)|how much is in (the |our |my )?pipeline|what('s| is) in (the |our |my )?pipeline|(biggest|largest|top|most valuable) (deals|leads|opportunities)|deals by stage|how many (open )?deals)\b/i;
const PAST_CLOSE_RE = /\b(past (their |the )?close( date)?|slipp(ed|ing)|missed (their |the )?close)\b/i;
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

/** "for 2 weeks", "in 60 days", "this month": how long counts as quiet. Defaults to 30 days. */
export function quietDays(question: string): number {
  return windowDays(question, 30);
}

/** "this week" 7, "this quarter" 90, "slipped" 0 (only those past their date); 30 otherwise. */
export function closingDays(question: string): number {
  if (PAST_CLOSE_RE.test(question)) return 0;
  if (/\b(this|next|the) quarter\b/i.test(question)) return 90;
  if (/\b(this|next|the) year\b/i.test(question)) return 365;
  return windowDays(question, 30);
}

/** "this week" 7, "this quarter" 90, "this year" 365; 30 otherwise. */
export function resultsDays(question: string): number {
  if (/\b(this|last|the) quarter\b/i.test(question)) return 90;
  if (/\b(this|last|the) year\b/i.test(question)) return 365;
  return windowDays(question, 30);
}

/** How far back a question looks: "today" 1, "this week" 7, "3 months" 90, otherwise `fallback`. */
export function windowDays(question: string, fallback: number): number {
  const match = /\b(\d{1,3})\s*(day|days|week|weeks|month|months)\b/i.exec(question);
  if (match) {
    const count = Number(match[1]);
    const unit = match[2]!.toLowerCase();
    const days = unit.startsWith("week") ? count * 7 : unit.startsWith("month") ? count * 30 : count;
    return Math.min(Math.max(days, 1), 365);
  }
  if (/\bfortnight\b/i.test(question)) return 14;
  if (/\b(a|one|last|this|the) week\b/i.test(question)) return 7;
  if (/\b(a|one|last|this|the) month\b/i.test(question)) return 30;
  if (/\byesterday\b/i.test(question)) return 2;
  if (/\btoday\b/i.test(question)) return 1;
  return fallback;
}

export function classifyQuestion(question: string, agents: readonly AskAgentRef[]): AskIntent {
  const trimmed = question.trim();
  if (AWAY_RE.test(trimmed)) return { kind: "away" };
  if (QUIET_RE.test(trimmed)) return { kind: "quiet", days: quietDays(trimmed) };
  if (MISSING_RE.test(trimmed) && !mentionedAgent(trimmed, agents)) return { kind: "pipeline", view: "missing" };
  if (RESULTS_RE.test(trimmed) && !mentionedAgent(trimmed, agents)) return { kind: "results", days: resultsDays(trimmed) };
  if (CLOSING_RE.test(trimmed) && !mentionedAgent(trimmed, agents)) return { kind: "closing", days: closingDays(trimmed) };
  if (OWNERS_RE.test(trimmed) && !mentionedAgent(trimmed, agents)) return { kind: "pipeline", view: "owners" };
  const owner = mentionedAgent(trimmed, agents) ? null : ownerInQuestion(trimmed);
  if (owner) return { kind: "pipeline", view: "owner", owner };
  if (PIPELINE_RE.test(trimmed) && !mentionedAgent(trimmed, agents)) {
    const timed = windowDays(trimmed, 0) > 0 || /\b(this|next|the) (quarter|year)\b/i.test(trimmed);
    return timed ? { kind: "closing", days: closingDays(trimmed) } : { kind: "pipeline", view: "stages" };
  }
  if (BRIEF_RE.test(trimmed) && !STUCK_RE.test(trimmed) && !mentionedAgent(trimmed, agents)) {
    return { kind: "brief", subject: questionSubject(trimmed, BRIEF_WORDS) };
  }
  if (PEOPLE_RE.test(trimmed) && !STUCK_RE.test(trimmed) && !mentionedAgent(trimmed, agents)) {
    return { kind: "people", subject: questionSubject(trimmed, PEOPLE_WORDS) };
  }
  if (DECIDE_RE.test(trimmed)) return { kind: "decide" };
  if (HISTORY_RE.test(trimmed) && !STUCK_RE.test(trimmed)) {
    const subject = questionSubject(trimmed, HISTORY_WORDS);
    if (!subject && windowDays(trimmed, 0) > 0) return { kind: "activity", days: windowDays(trimmed, 7) };
    return { kind: "history", subject };
  }
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
  // The one "needs you" number (decisionCount); assigned tasks are said apart.
  const needs = needsMe.decisionCount;
  const assigned = needsMe.assignedTaskCount > 0
    ? `${plural(needsMe.assignedTaskCount, "task")} ${needsMe.assignedTaskCount === 1 ? "is" : "are"} assigned to you.`
    : "";
  const waiting = needsMe.overdueWaits.length > 0 ? `, ${needsMe.overdueWaits.length} waiting more than a day` : "";
  const headline = needs === 0
    ? `No decisions need you. ${assigned}`
    : `${plural(needs, "thing")} need${needs === 1 ? "s" : ""} you${waiting}.${assigned ? ` ${assigned}` : ""}`;
  return {
    headline: headline.trim(),
    lines,
    more: { label: "Open Decisions", href: "/decisions" },
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
  activity: "Note or activity",
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

/** The latest imported notes, calls and meetings about a client, newest first. */
export function answerHistory(subject: string, records: readonly CompanySearchResult[]): AskAnswer {
  const activity = records
    .filter((result) => result.type === "record" && result.record?.kind === "activity")
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, 5);
  const more = {
    label: `All notes and calls about ${subject}`,
    href: `/search?q=${encodeURIComponent(subject)}&scope=records&kind=activity`,
  };
  if (activity.length === 0) {
    return { headline: `I could not find any notes, calls or meetings about ${subject}.`, lines: [], more };
  }
  const latest = activity[0]!;
  const lines = activity.map((result) => ({ text: result.title, detail: result.record!.subtitle ?? undefined, href: result.href }));
  return {
    headline: `The latest with ${subject}: ${latest.title}${latest.record!.subtitle ? ` (${latest.record!.subtitle})` : ""}.`,
    lines,
    more,
  };
}

/** The people we hold for a client: name, role and where they work. */
export function answerPeople(subject: string, records: readonly CompanySearchResult[]): AskAnswer {
  const people = records.filter((result) => result.type === "record" && result.record?.kind === "person").slice(0, 6);
  const more = {
    label: `All people for ${subject}`,
    href: `/search?q=${encodeURIComponent(subject)}&scope=records&kind=person`,
  };
  if (people.length === 0) return { headline: `I could not find anyone for ${subject}.`, lines: [], more };
  const first = people[0]!;
  return {
    headline: people.length === 1
      ? `Your contact for ${subject} is ${first.title}${first.record!.subtitle ? ` (${first.record!.subtitle})` : ""}.`
      : `${plural(people.length, "person", "people")} for ${subject}, starting with ${first.title}.`,
    lines: people.map((result) => ({ text: result.title, detail: result.record!.subtitle ?? undefined, href: result.href })),
    more,
  };
}

/** Open deals and leads with no note, call or meeting for a while, quietest first. */
export function answerQuiet(result: CompanyQuietClientsResponse): AskAnswer {
  const { clients, total, days } = result;
  if (clients.length === 0) {
    return { headline: `Every open deal and lead has had a note, call or meeting in the last ${plural(days, "day")}.`, lines: [] };
  }
  const first = clients[0]!;
  const lines = clients.map((client) => ({
    text: client.title,
    detail: [
      `${client.stageName} in ${client.pipelineName}`,
      client.lastTouchAt
        ? `last ${client.lastTouchLabel ?? "contact"}, ${plural(client.quietDays, "day")} ago`
        : `no notes or calls yet, added ${plural(client.quietDays, "day")} ago`,
    ].join(", "),
    href: client.href,
  }));
  return {
    headline: `${plural(total, "open deal or lead", "open deals and leads")} had no note, call or meeting in ${plural(days, "day")}. The quietest is ${first.title} (${plural(first.quietDays, "day")}).`,
    lines,
    more: { label: "Open the pipelines", href: "/pipelines" },
  };
}

function money(value: number, currency: string | null): string {
  const amount = formatNumber(value, { maximumFractionDigits: 0 });
  return currency ? `${currency} ${amount}` : amount;
}

/** Open deals by expected close date, overdue first, with the window's value per currency. */
export function answerClosing(result: CompanyClosingDealsResponse): AskAnswer {
  const { deals, total, overdueCount, valueByCurrency, days } = result;
  const period = days === 0 ? "past their close date" : days <= 7 ? "closing this week" : days <= 31 ? "closing this month" : `closing in the next ${plural(days, "day")}`;
  if (total === 0) {
    return {
      headline: days === 0
        ? "No open deals or leads are past their expected close date."
        : `No open deals or leads have an expected close date in the next ${plural(days, "day")}.`,
      lines: [],
      more: { label: "Open the pipelines", href: "/pipelines" },
    };
  }
  const worth = valueByCurrency.filter((entry) => entry.value > 0).slice(0, 3).map((entry) => money(entry.value, entry.currency)).join(" and ");
  const late = days > 0 && overdueCount > 0 ? ` ${plural(overdueCount, "is", "are")} already past the date.` : "";
  return {
    headline: `${plural(total, "open deal or lead", "open deals and leads")} ${period}${worth ? `, worth ${worth}` : ""}.${late}`,
    lines: deals.map((deal) => ({
      text: deal.title,
      detail: [
        deal.overdue ? `Was due ${formatShortDate(`${deal.expectedCloseDate}T12:00:00Z`)}` : `Due ${formatShortDate(`${deal.expectedCloseDate}T12:00:00Z`)}`,
        deal.value !== null ? money(deal.value, deal.currency) : null,
        `${deal.stageName} in ${deal.pipelineName}`,
      ].filter(Boolean).join(", "),
      href: deal.href,
    })),
    more: { label: "Open the pipelines", href: "/pipelines" },
  };
}

/** Open deals per stage with value, then the largest deals. */
const MISSING_LABELS = { closeDate: "close date", value: "value", owner: "owner", organisation: "organisation" } as const;

export function answerPipeline(result: CompanyPipelineSummaryResponse, view: "stages" | "owners" | "missing" | "owner" = "stages"): AskAnswer {
  const { total, valueByCurrency, stages, topDeals } = result;
  const more = { label: "Open the pipelines", href: "/pipelines" };
  if (view === "owner") {
    const asked = result.ownerFilter ?? "that person";
    if (total === 0) return { headline: `No open deals or leads are owned by ${asked}.`, lines: [], more };
    const names = (result.owners ?? []).map((entry) => entry.owner).filter((name): name is string => name !== null);
    const who = names.length === 1 ? names[0]! : asked;
    const ownerWorth = valueByCurrency.filter((entry) => entry.value > 0).slice(0, 3).map((entry) => money(entry.value, entry.currency)).join(" and ");
    const soonest = topDeals.filter((deal) => deal.expectedCloseDate).sort((a, b) => a.expectedCloseDate!.localeCompare(b.expectedCloseDate!))[0];
    return {
      headline: `${who} owns ${plural(total, "open deal or lead", "open deals and leads")}${ownerWorth ? ` worth ${ownerWorth}` : ""}.${names.length > 1 ? ` That covers ${names.join(", ")}.` : ""}${soonest ? ` Next due to close: ${soonest.title} on ${formatShortDate(`${soonest.expectedCloseDate}T12:00:00Z`)}.` : ""}`,
      lines: topDeals.map((deal) => ({
        text: deal.title,
        detail: [deal.value !== null ? money(deal.value, deal.currency) : "No value", `${deal.stageName} in ${deal.pipelineName}`, deal.expectedCloseDate ? `due ${formatShortDate(`${deal.expectedCloseDate}T12:00:00Z`)}` : null].filter(Boolean).join(", "),
        href: deal.href,
      })),
      more,
    };
  }
  if (total === 0) return { headline: "There are no open deals or leads in any pipeline.", lines: [], more };
  const worth = valueByCurrency.filter((entry) => entry.value > 0).slice(0, 3).map((entry) => money(entry.value, entry.currency)).join(" and ");
  if (view === "missing") {
    const missing = result.missing;
    const gaps = missing
      ? (Object.keys(MISSING_LABELS) as Array<keyof typeof MISSING_LABELS>)
        .filter((key) => missing[key] > 0)
        .map((key) => `${missing[key]} no ${MISSING_LABELS[key]}`)
      : [];
    if (!missing || gaps.length === 0) {
      return { headline: `All ${plural(total, "open deal or lead", "open deals and leads")} have a close date, value, owner and organisation.`, lines: [], more };
    }
    return {
      headline: `Of ${plural(total, "open deal or lead", "open deals and leads")}: ${gaps.join(", ")}.`,
      lines: missing.deals.map((deal) => ({
        text: deal.title,
        detail: `Missing ${deal.missing.map((key) => MISSING_LABELS[key]).join(", ")}; ${deal.stageName} in ${deal.pipelineName}`,
        href: deal.href,
      })),
      more,
    };
  }
  if (view === "owners") {
    const owners = result.owners ?? [];
    const named = owners.filter((entry) => entry.owner !== null);
    if (named.length === 0) {
      return { headline: `None of the ${plural(total, "open deal or lead", "open deals and leads")} has an owner recorded.`, lines: [], more };
    }
    const top = named[0]!;
    return {
      headline: `${plural(total, "open deal or lead", "open deals and leads")} across ${plural(named.length, "owner")}. ${top.owner} has the most (${top.count}${top.valueByCurrency[0] ? `, ${money(top.valueByCurrency[0].value, top.valueByCurrency[0].currency)}` : ""}).`,
      lines: owners.slice(0, 8).map((entry) => ({
        text: entry.owner ?? "No owner",
        detail: [plural(entry.count, "open deal"), ...entry.valueByCurrency.map((value) => money(value.value, value.currency))].join(", "),
        href: "/pipelines",
      })),
      more,
    };
  }
  const busiest = [...stages].sort((a, b) => b.count - a.count)[0]!;
  const largest = topDeals.find((deal) => deal.value !== null);
  const lines: AnswerLine[] = [
    ...stages.slice(0, 6).map((stage) => ({
      text: stages.some((other) => other.pipelineId !== stage.pipelineId) ? `${stage.stageName} in ${stage.pipelineName}` : stage.stageName,
      detail: [plural(stage.count, "open deal"), ...stage.valueByCurrency.map((entry) => money(entry.value, entry.currency))].join(", "),
      href: "/pipelines",
    })),
    ...topDeals.map((deal) => ({
      text: deal.title,
      detail: [deal.value !== null ? money(deal.value, deal.currency) : null, `${deal.stageName} in ${deal.pipelineName}`, deal.expectedCloseDate ? `due ${formatShortDate(`${deal.expectedCloseDate}T12:00:00Z`)}` : null].filter(Boolean).join(", "),
      href: deal.href,
    })),
  ];
  return {
    headline: `${plural(total, "open deal or lead", "open deals and leads")}${worth ? ` worth ${worth}` : ""}. Most are in ${busiest.stageName} (${busiest.count})${largest ? `; the largest is ${largest.title} at ${money(largest.value ?? 0, largest.currency)}` : ""}.`,
    lines,
    more,
  };
}

/** Deals won and lost lately, with value and the main lost reason. */
export function answerResults(result: CompanyWonLostResponse): AskAnswer {
  const { won, lost, days } = result;
  const period = days === 7 ? "this week" : days === 30 ? "this month" : days === 90 ? "this quarter" : days === 365 ? "this year" : `in the last ${plural(days, "day")}`;
  const more = { label: "Open the pipelines", href: "/pipelines" };
  if (won.count === 0 && lost.count === 0) return { headline: `No deals or leads were won or lost ${period}.`, lines: [], more };
  const worth = won.valueByCurrency.slice(0, 3).map((entry) => money(entry.value, entry.currency)).join(" and ");
  const reason = lost.reasons[0];
  const day = (closedOn: string) => formatShortDate(`${closedOn}T12:00:00Z`);
  return {
    headline: `Won ${plural(won.count, "deal")}${worth ? ` worth ${worth}` : ""} and lost ${lost.count} ${period}.${reason ? ` The most common lost reason is ${reason.reason} (${reason.count}).` : ""}`,
    lines: [
      ...won.deals.map((deal) => ({
        text: deal.title,
        detail: [`Won ${day(deal.closedOn)}`, deal.value !== null ? money(deal.value, deal.currency) : null, deal.organisationName].filter(Boolean).join(", "),
        href: deal.href,
      })),
      ...lost.deals.map((deal) => ({
        text: deal.title,
        detail: [`Lost ${day(deal.closedOn)}`, deal.lostReason, deal.value !== null ? money(deal.value, deal.currency) : null].filter(Boolean).join(", "),
        href: deal.href,
      })),
    ],
    more,
  };
}

/** Recent notes, calls and meetings across clients, newest first. */
export function answerActivity(result: CompanyRecentClientActivityResponse): AskAnswer {
  const { activity, total, clientCount, byKind, days } = result;
  const period = days === 1 ? "today" : days === 2 ? "since yesterday" : days === 7 ? "this week" : `in the last ${plural(days, "day")}`;
  if (total === 0) {
    return { headline: `No notes, calls or meetings with clients ${period}.`, lines: [] };
  }
  const kinds = byKind.slice(0, 3).map(([kind, count]) => `${count} ${kind.toLowerCase()}${count === 1 ? "" : "s"}`).join(", ");
  return {
    headline: `${plural(total, "note, call or meeting", "notes, calls and meetings")} with ${plural(clientCount, "client")} ${period}: ${kinds}.`,
    lines: activity.map((entry) => ({
      text: entry.title,
      detail: [entry.kindLabel, entry.clientName, entry.ownerName, timeAgo(entry.occurredAt)].filter(Boolean).join(", "),
      href: entry.href,
    })),
    more: { label: "Open the pipelines", href: "/pipelines" },
  };
}

/** A one-glance brief: who they are, open deals, people and when we last spoke. */
export function answerBrief(subject: string, brief: CompanyClientBrief | null): AskAnswer {
  if (!brief) {
    return {
      headline: `I could not find an organisation called ${subject}.`,
      lines: [],
      more: { label: `Search for ${subject}`, href: `/search?q=${encodeURIComponent(subject)}&scope=records` },
    };
  }
  const org = brief.organisation;
  const status = ORGANISATION_STATUS_LABELS[org.status as OrganisationStatus] ?? org.status;
  const about = [status.toLowerCase(), org.industry, org.country].filter(Boolean).join(", ");
  const contact = brief.lastTouch
    ? `last contact ${plural(brief.quietDays ?? 0, "day")} ago (${brief.lastTouch.label})`
    : "no notes or calls yet";
  const lines: AnswerLine[] = [
    ...brief.openDeals.map((deal) => ({
      text: deal.title,
      detail: [
        `Open deal: ${deal.stageName} in ${deal.pipelineName}`,
        deal.value != null ? money(deal.value, deal.currency) : null,
        deal.expectedCloseDate ? `due ${formatShortDate(`${deal.expectedCloseDate}T12:00:00Z`)}` : null,
      ].filter(Boolean).join(", "),
      href: deal.href,
    })),
    ...brief.people.map((person) => ({ text: person.name, detail: [person.role, person.email].filter(Boolean).join(", ") || "Person", href: org.href })),
  ];
  return {
    headline: `${org.name}: ${about}. ${plural(brief.openDeals.length, "open deal")}, ${plural(brief.peopleCount, "person", "people")}, ${contact}.`,
    lines,
    more: { label: `Open ${org.name}`, href: org.href },
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
  if (needsMe && needsMe.decisionCount > 0) {
    lines.unshift({ text: `${plural(needsMe.decisionCount, "thing")} need${needsMe.decisionCount === 1 ? "s" : ""} you`, href: "/decisions" });
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
export function answerAway(
  digest: AgentWorkDigest,
  blocked: readonly Issue[],
  needsMe: NeedsMe | null,
  clientActivity: CompanyRecentClientActivityResponse | null = null,
): AskAnswer {
  const stuck = newlyStuck(blocked, digest.since);
  const finished = digest.agents
    .flatMap((agent) => agent.items.filter((item) => item.kind === "task_finished").map((item) => ({ item, agent: agent.agentName })))
    .sort((a, b) => new Date(b.item.at).getTime() - new Date(a.item.at).getTime());
  const needs = needsMe?.decisionCount ?? 0;
  const parts = [
    `${plural(digest.counts.tasksFinished, "task")} finished`,
    `${stuck.length} got stuck`,
    `${plural(needs, "thing")} need${needs === 1 ? "s" : ""} you`,
  ];
  if (digest.counts.failures > 0) parts.push(`${plural(digest.counts.failures, "run")} failed`);
  const contact = clientActivity?.total ?? 0;
  if (contact > 0) parts.push(`${plural(contact, "client note or call", "client notes and calls")}`);
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
  for (const entry of clientActivity?.activity.slice(0, 2) ?? []) {
    lines.push({ text: entry.title, detail: [entry.kindLabel, entry.clientName].filter(Boolean).join(", "), href: entry.href });
  }
  const quiet = digest.counts.tasksFinished === 0 && stuck.length === 0 && needs === 0 && digest.counts.failures === 0 && contact === 0;
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
  if (intent.kind === "brief" && !intent.subject) return subject ? { kind: "brief", subject } : { kind: "overview" };
  if ((intent.kind === "history" || intent.kind === "people") && !intent.subject) {
    if (subject) return { kind: intent.kind, subject };
    return intent.kind === "history" ? { kind: "activity", days: 7 } : { kind: "overview" };
  }
  if (intent.kind === "activity" && subject) return { kind: "history", subject };
  if (!subject) return intent.kind === "brief" && !intent.subject ? { kind: "overview" } : intent;
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
  /** Imported CRM history (Pipedrive notes, calls, meetings, emails), newest first. */
  history?: ReadonlyArray<{ kind: string; activityType: string | null; subject: string | null; body: string | null; occurredAt: string | null }>;
}): AskContext {
  const about = [org.industry, org.country].filter(Boolean).join(", ");
  const history = (org.history ?? [])
    .filter((entry) => entry.kind !== "stage_change")
    .slice(0, 5)
    .map(historyLine)
    .filter(Boolean);
  const people = org.contacts.slice(0, 6).map((contact) => (contact.role ? `${contact.name} (${contact.role})` : contact.name));
  const deals = org.deals.slice(0, 6).map((deal) => `${deal.title}: ${deal.stageName} in ${deal.pipelineName}`);
  return {
    label: org.name,
    subject: org.name,
    summary: [
      `The organisation "${org.name}"${about ? ` (${about})` : ""}. Status: ${org.statusLabel}.`,
      people.length > 0 ? `People: ${people.join("; ")}.` : null,
      deals.length > 0 ? `Deals: ${deals.join("; ")}.` : null,
      history.length > 0 ? `Latest history: ${history.join("; ")}.` : null,
    ].filter(Boolean).join("\n"),
    suggestions: [
      `What is happening with ${org.name}?`,
      ...(history.length > 0 ? [`What did we last discuss with ${org.name}?`] : []),
      `What is stuck on ${org.name}?`,
      `What should we do next with ${org.name}?`,
    ],
  };
}

/** One imported CRM entry as a short line: "2026-10-12, call: Pricing call (Talked through the tiers)". */
function historyLine(entry: { kind: string; activityType: string | null; subject: string | null; body: string | null; occurredAt: string | null }): string {
  const text = (entry.body ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const short = text.length > 120 ? `${text.slice(0, 119)}…` : text;
  const what = entry.subject?.trim() || short;
  if (!what) return "";
  const when = entry.occurredAt ? `${entry.occurredAt.slice(0, 10)}, ` : "";
  const kind = (entry.activityType ?? entry.kind).replace(/_/g, " ");
  const extra = entry.subject?.trim() && short ? ` (${short})` : "";
  return `${when}${kind}: ${what}${extra}`;
}
