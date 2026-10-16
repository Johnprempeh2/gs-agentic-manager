/**
 * Plain-English commands typed into the search box, such as
 * "create a task for Mason to draft the Indago pack by Friday",
 * "assign GRE-12 to Ridge" or "remind me on Monday to call Ben".
 * Parsing only: the palette shows a preview and acts on confirmation.
 */

export interface CommandAgent {
  id: string;
  name: string;
  status?: string | null;
}

export interface CommandWhen {
  /** Local calendar day the phrase points at. */
  date: Date;
  /** "Friday 17 October" */
  label: string;
}

export type PaletteCommand =
  | { kind: "create"; title: string; agent: CommandAgent | null; due: CommandWhen | null }
  | { kind: "assign"; taskRef: string; agent: CommandAgent | null; toMe: boolean }
  | { kind: "remind"; title: string; when: CommandWhen };

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DAY_RE = "(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?";
const MONTH_RE = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
/** Every phrase `parseWhen` understands, for finding one inside a sentence. */
const WHEN_RE = `(?:today|tonight|tomorrow|next week|end of (?:the )?week|in \\d+ (?:days?|weeks?)|(?:next |this )?${DAY_RE}|\\d{1,2}(?:st|nd|rd|th)? ${MONTH_RE}|${MONTH_RE} \\d{1,2}(?:st|nd|rd|th)?)`;

function startOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date: Date, days: number) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

export function whenLabel(date: Date): string {
  const day = DAYS[date.getDay()]!;
  const month = MONTHS[date.getMonth()]!;
  const cap = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
  return `${cap(day)} ${date.getDate()} ${cap(month)}`;
}

function dayIndex(word: string): number {
  const prefix = word.slice(0, 3);
  return DAYS.findIndex((day) => day.startsWith(prefix));
}

/** Turn "Friday", "tomorrow", "next week", "in 3 days" or "17 Oct" into a day. */
export function parseWhen(phrase: string, now: Date = new Date()): CommandWhen | null {
  const text = phrase.trim().toLowerCase().replace(/\s+/g, " ");
  const today = startOfDay(now);
  let date: Date | null = null;
  if (text === "today" || text === "tonight") date = today;
  else if (text === "tomorrow") date = addDays(today, 1);
  else if (text === "next week") date = addDays(today, ((8 - today.getDay()) % 7) || 7);
  else if (/^end of (the )?week$/.test(text)) date = addDays(today, (5 - today.getDay() + 7) % 7);
  else {
    const inMatch = /^in (\d+) (days?|weeks?)$/.exec(text);
    const dayMatch = new RegExp(`^(next |this )?(${DAY_RE})$`).exec(text);
    const dateMatch = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)? (${MONTH_RE})$`).exec(text)
      ?? (() => {
        const flipped = new RegExp(`^(${MONTH_RE}) (\\d{1,2})(?:st|nd|rd|th)?$`).exec(text);
        return flipped ? ([flipped[0], flipped[2], flipped[1]] as unknown as RegExpExecArray) : null;
      })();
    if (inMatch) {
      const count = Number(inMatch[1]);
      date = addDays(today, inMatch[2]!.startsWith("week") ? count * 7 : count);
    } else if (dayMatch) {
      const target = dayIndex(dayMatch[2]!);
      if (target < 0) return null;
      if (dayMatch[1] === "next ") {
        // "next Friday" is the Friday of next week (weeks start on Monday).
        const nextMonday = addDays(today, ((8 - today.getDay()) % 7) || 7);
        date = addDays(nextMonday, (target + 6) % 7);
      } else {
        const ahead = ((target - today.getDay() + 7) % 7) || 7;
        date = addDays(today, ahead);
      }
    } else if (dateMatch) {
      const month = MONTHS.findIndex((name) => name.startsWith(dateMatch[2]!.slice(0, 3)));
      const day = Number(dateMatch[1]);
      if (month < 0 || day < 1 || day > 31) return null;
      date = new Date(today.getFullYear(), month, day);
      if (date.getMonth() !== month) return null;
      if (date < today) date = new Date(today.getFullYear() + 1, month, day);
    }
  }
  return date ? { date, label: whenLabel(date) } : null;
}

function findAgent(name: string, agents: readonly CommandAgent[]): CommandAgent | null {
  const wanted = name.trim().toLowerCase();
  return agents.find((agent) => agent.status !== "terminated" && agent.name.toLowerCase() === wanted) ?? null;
}

function tidyTitle(text: string): string {
  const trimmed = text.trim().replace(/[.!?]+$/, "").trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Split a trailing "by Friday" / "on 17 Oct" / "tomorrow" off a sentence. */
function splitTrailingWhen(text: string, now: Date): { rest: string; when: CommandWhen | null } {
  const match = new RegExp(`^(.*?)\\s+(?:(?:by|before|on|due|for)\\s+)?(${WHEN_RE})\\s*[.!?]?$`, "i").exec(text);
  if (match) {
    const when = parseWhen(match[2]!, now);
    if (when && match[1]!.trim()) return { rest: match[1]!, when };
  }
  return { rest: text, when: null };
}

export function parseCommand(input: string, agents: readonly CommandAgent[], now: Date = new Date()): PaletteCommand | null {
  const text = input.trim().replace(/\s+/g, " ");
  if (text.length < 8) return null;

  const remind = /^remind me\s+(.+)$/i.exec(text);
  if (remind) {
    const body = remind[1]!;
    const leading = new RegExp(`^(?:on |at )?(${WHEN_RE})\\s+(?:to\\s+)?(.+)$`, "i").exec(body);
    if (leading) {
      const when = parseWhen(leading[1]!, now);
      if (when) return { kind: "remind", title: tidyTitle(leading[2]!), when };
    }
    const stripped = body.replace(/^to\s+/i, "");
    const { rest, when } = splitTrailingWhen(stripped, now);
    if (when) return { kind: "remind", title: tidyTitle(rest), when };
    return null;
  }

  const assign = /^(?:assign|give|hand|pass)\s+(this|this task|[a-z]+-\d+)\s+(?:over\s+)?to\s+(.+?)[.!]?$/i.exec(text);
  if (assign) {
    const who = assign[2]!.trim();
    const toMe = /^(me|myself)$/i.test(who);
    const agent = toMe ? null : findAgent(who, agents);
    if (!toMe && !agent) return null;
    const ref = assign[1]!.toLowerCase().startsWith("this") ? "this" : assign[1]!.toUpperCase();
    return { kind: "assign", taskRef: ref, agent, toMe };
  }

  const create = /^(?:create|add|make|new|open)\s+(?:a\s+|an\s+)?(?:new\s+)?task\s*(?:for\s+(\S+)\s*)?(?::|to\s+|-\s*)?\s*(.+)$/i.exec(text);
  const askAgent = /^(?:ask|tell|get)\s+(\S+)\s+to\s+(.+)$/i.exec(text);
  let agentName: string | null = null;
  let body: string | null = null;
  if (create) {
    agentName = create[1] ?? null;
    body = create[2]!;
  } else if (askAgent && findAgent(askAgent[1]!, agents)) {
    agentName = askAgent[1]!;
    body = askAgent[2]!;
  }
  if (body !== null) {
    let agent = agentName ? findAgent(agentName, agents) : null;
    if (agentName && !agent) {
      // "create a task for the Indago pack": "for" was not an agent.
      body = `for ${agentName} ${body}`;
      agent = null;
    }
    const { rest, when } = splitTrailingWhen(body, now);
    const title = tidyTitle(rest.replace(/^to\s+/i, ""));
    if (!title) return null;
    return { kind: "create", title, agent, due: when };
  }
  return null;
}
