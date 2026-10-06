/**
 * Text check for possible conflicts (GRE-934, John 5 Oct). Runs when the tags
 * on a new entry do not match an approved record, so a wrongly tagged or
 * untagged entry is still compared. Two records are a lead for a reviewer when
 * their text speaks about the same subject and states a different price,
 * amount, percentage, date, time or quantity of the same kind.
 *
 * Pattern-based and local: no engine model call and no outbound traffic. It
 * misses things and marks harmless pairs; callers get MEMORY_CONFLICT_NOTE.
 */

export type TextConflictInput = {
  title: string | null;
  content: string | null;
  entities: string[];
  topics: string[];
};

type StatedValue = { key: string; value: string; display: string };

const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?`;
const SCALE = String.raw`(?:\s?(k|m|bn)\b)?`;
const CURRENCY_WORD = String.raw`(GBP|USD|EUR|pounds?|dollars?|euros?)`;
const PERIOD = /^\s*(?:\/|per\s+|an?\s+|each\s+)(month|mo|year|yr|annum|week|day|hour|hr|user|seat|head)s?\b/i;

const MONEY_PATTERNS: RegExp[] = [
  new RegExp(String.raw`([£$€])\s?${NUMBER}${SCALE}`, "gi"),
  new RegExp(String.raw`\b(GBP|USD|EUR)\s?${NUMBER}${SCALE}`, "gi"),
  new RegExp(String.raw`\b${NUMBER}${SCALE}\s?${CURRENCY_WORD}\b`, "gi"),
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;

const QUANTITY_UNITS: Record<string, string> = {
  day: "day", days: "day", week: "week", weeks: "week", month: "month", months: "month",
  year: "year", years: "year", hour: "hour", hours: "hour", hr: "hour", hrs: "hour",
  minute: "minute", minutes: "minute", min: "minute", mins: "minute",
  user: "user", users: "user", seat: "seat", seats: "seat", licence: "licence", licences: "licence",
  license: "licence", licenses: "licence", people: "person", staff: "person", employees: "person",
  gb: "gb", tb: "tb", call: "call", calls: "call", session: "session", sessions: "session",
  visit: "visit", visits: "visit",
};

const STOPWORDS = new Set(
  (
    "the and for are was were has have had but not you your our its it's this that these those with from into onto " +
    "will would should could can may must shall per each any all now new old then than there their they them what when " +
    "where which who why how also just only very more most less much many some such about after before over under " +
    "between again once here out off own same both few other does did doing being been is be at by in of on or to as a an " +
    "price prices cost costs rate rates amount fee fees total charge charged pay paid month monthly year yearly annual " +
    "annually week weekly day daily from until since"
  ).split(" "),
);

function currencyCode(raw: string) {
  const value = raw.toLowerCase();
  if (value === "£" || value === "gbp" || value.startsWith("pound")) return "GBP";
  if (value === "$" || value === "usd" || value.startsWith("dollar")) return "USD";
  return "EUR";
}

function amount(whole: string, fraction: string | undefined, scale: string | undefined) {
  const base = Number(`${whole.replace(/,/g, "")}${fraction ? `.${fraction}` : ""}`);
  const multiplier = { k: 1e3, m: 1e6, bn: 1e9 }[scale?.toLowerCase() ?? ""] ?? 1;
  return String(Math.round(base * multiplier * 100) / 100);
}

function normalisePeriod(raw: string) {
  const value = raw.toLowerCase();
  if (value === "mo") return "month";
  if (value === "yr" || value === "annum") return "year";
  if (value === "hr") return "hour";
  if (value === "head") return "user";
  return value;
}

function isoDate(year: string, month: number, day: string) {
  if (month < 1 || month > 12 || Number(day) < 1 || Number(day) > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/** Prices, amounts, percentages, dates, times and quantities stated in the text. Matched text is blanked out. */
function extractValues(text: string): { values: StatedValue[]; rest: string } {
  const values: StatedValue[] = [];
  let rest = text;
  // Each match is blanked out, so a later pattern never reads it again.
  const take = (pattern: RegExp, read: (match: RegExpMatchArray, after: string) => { key: string; value: string; extra?: number } | null) => {
    const spans: Array<[number, number]> = [];
    for (const match of rest.matchAll(pattern)) {
      const start = match.index!;
      const end = start + match[0].length;
      const found = read(match, rest.slice(end));
      if (!found) continue;
      const stop = end + (found.extra ?? 0);
      values.push({ key: found.key, value: found.value, display: rest.slice(start, stop).trim() });
      spans.push([start, stop]);
    }
    for (const [start, stop] of spans) rest = rest.slice(0, start) + " ".repeat(stop - start) + rest.slice(stop);
  };

  MONEY_PATTERNS.forEach((pattern, index) => {
    take(pattern, (match, after) => {
      const [currency, whole, fraction, scale] = index < 2 ? [match[1], match[2], match[3], match[4]] : [match[4], match[1], match[2], match[3]];
      const period = PERIOD.exec(after);
      return {
        key: `money:${currencyCode(currency)}:${period ? normalisePeriod(period[1]) : ""}`,
        value: amount(whole, fraction, scale),
        extra: period?.[0].length ?? 0,
      };
    });
  });

  take(/\b(\d+(?:\.\d+)?)\s?(%|per\s?cent\b)/gi, (match) => ({ key: "percent", value: String(Number(match[1])) }));
  take(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (match) => {
    const value = isoDate(match[1], Number(match[2]), match[3]);
    return value ? { key: "date", value } : null;
  });
  take(new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+${MONTH}\.?,?\s+(\d{4})\b`, "gi"), (match) => {
    const value = isoDate(match[3], MONTHS.indexOf(match[2].slice(0, 3).toLowerCase()) + 1, match[1]);
    return value ? { key: "date", value } : null;
  });
  take(new RegExp(String.raw`\b${MONTH}\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b`, "gi"), (match) => {
    const value = isoDate(match[3], MONTHS.indexOf(match[1].slice(0, 3).toLowerCase()) + 1, match[2]);
    return value ? { key: "date", value } : null;
  });
  // Day first, as written in the UK.
  take(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (match) => {
    const value = isoDate(match[3], Number(match[2]), match[1]);
    return value ? { key: "date", value } : null;
  });
  take(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (match) => ({ key: "time", value: `${match[1].padStart(2, "0")}:${match[2]}` }));
  take(/\b(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?([a-z]+)\b/gi, (match) => {
    const unit = QUANTITY_UNITS[match[2].toLowerCase()];
    return unit ? { key: `qty:${unit}`, value: String(Number(match[1].replace(/,/g, ""))) } : null;
  });
  return { values, rest };
}

/**
 * Prices, amounts, percentages, dates, times and quantities a record's text
 * states, keyed `kind=value` so equal values match. Value is how the text put it.
 */
export function statedValues(input: Pick<TextConflictInput, "title" | "content">): Map<string, string> {
  const text = [input.title, input.content].filter(Boolean).join(". ");
  const found = new Map<string, string>();
  for (const value of extractValues(text).values) {
    const key = `${value.key}=${value.value}`;
    if (!found.has(key)) found.set(key, value.display);
  }
  return found;
}

function words(text: string) {
  return (text.toLowerCase().match(/[a-z][a-z'-]+/g) ?? []).filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

/**
 * Subject words of a record, and the capitalised names in its text. A name
 * mid-sentence is "strong"; a capitalised first word may be an ordinary word,
 * so it only helps a match. Tags count as subject words but never as strong
 * names, because a wrong tag must not hide a conflict.
 */
function subjectOf(input: TextConflictInput) {
  const text = [input.title, input.content].filter(Boolean).join(". ");
  const { values, rest } = extractValues(text);
  const tokens = new Set([...words(rest), ...input.entities.flatMap(words), ...input.topics.flatMap(words)]);
  const names = new Set<string>(input.entities.flatMap(words));
  const strongNames = new Set<string>();
  for (const match of rest.matchAll(/[A-Z][a-zA-Z'-]+/g)) {
    const word = match[0].toLowerCase();
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    names.add(word);
    const before = rest.slice(0, match.index).trimEnd();
    if (before.length > 0 && !/[.!?:;\n]$/.test(before)) strongNames.add(word);
  }
  return { values, tokens, names, strongNames };
}

function intersect<T>(a: Set<T>, b: Set<T>) {
  return [...a].filter((value) => b.has(value));
}

/**
 * Terms for a reviewer when the candidate's text states a different value of
 * the same kind as the approved record on the same subject; empty otherwise.
 */
export function textConflictTerms(candidate: TextConflictInput, approved: TextConflictInput): string[] {
  const a = subjectOf(candidate);
  const b = subjectOf(approved);
  if (a.values.length === 0 || b.values.length === 0) return [];

  // Different names in both texts mean different subjects.
  if (a.strongNames.size > 0 && b.strongNames.size > 0 && intersect(a.strongNames, b.strongNames).length === 0) return [];
  const shared = intersect(a.tokens, b.tokens);
  const sharedNames = intersect(a.names, b.names);
  const sameSubject =
    sharedNames.length > 0
      ? shared.length >= 2
      : shared.length >= 3 && shared.length / Math.min(a.tokens.size, b.tokens.size) >= 0.5;
  if (!sameSubject) return [];

  const differences: string[] = [];
  for (const key of new Set(a.values.map((value) => value.key))) {
    const approvedValues = b.values.filter((value) => value.key === key);
    if (approvedValues.length === 0) continue;
    const known = new Set(approvedValues.map((value) => value.value));
    const differing = a.values.filter((value) => value.key === key && !known.has(value.value));
    for (const value of differing) {
      differences.push(`${value.display} vs ${[...new Set(approvedValues.map((other) => other.display))].join(" / ")}`);
    }
  }
  if (differences.length === 0) return [];
  const subject = [...sharedNames, ...shared.filter((word) => !sharedNames.includes(word))].slice(0, 4);
  return [...new Set([...subject, ...differences])];
}
