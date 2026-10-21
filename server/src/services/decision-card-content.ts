import type { DecisionCardActionId } from "@greatstone/shared";

/**
 * Plain-text helpers for decision cards: what an agent's comment asks of a
 * person, and what it recommends. Pure, so the card builder stays testable.
 */

/** An agent stall reaches a person after this long with the lead agent. */
export const STALL_ESCALATION_MS = 24 * 60 * 60 * 1000;

const EXCERPT_LIMIT = 280;

/** Markdown-light text, one line, cut at a word. */
export function commentExcerpt(body: string, limit = EXCERPT_LIMIT): string {
  const text = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > limit / 2 ? cut.slice(0, space) : cut}…`;
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z"'(])/).map((part) => part.trim()).filter(Boolean);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Words that make a sentence an ask of someone, not a mention. */
const ASK_CUE = /\b(reply|respond|answer|approve|confirm|check|send|sign|connect|log ?in|decide|choose|pick|review|waiting (?:for|on)|wait(?:s|ing)? for|needs?|please|asks?|accept|grant)\b/i;

/**
 * The sentence of an agent comment that asks the viewer to do something:
 * it names them (or "the board") and carries an action word. Null when the
 * comment asks nothing of them.
 */
export function namedAskSentence(body: string | null | undefined, names: string[]): string | null {
  if (!body) return null;
  const wanted = [...new Set(names.map((name) => name.trim()).filter((name) => name.length >= 2))];
  if (wanted.length === 0) return null;
  const nameRe = new RegExp(`\\b(${wanted.map(escapeRegExp).join("|")})\\b`, "i");
  for (const sentence of sentences(commentExcerpt(body, 2000))) {
    if (nameRe.test(sentence) && ASK_CUE.test(sentence)) return sentence.replace(/[…]$/, "").trim();
  }
  return null;
}

/** First name and full name of a person, plus "the board" for board users. */
export function viewerNames(fullName: string | null | undefined): string[] {
  const names = ["the board"];
  const full = fullName?.trim();
  if (full && full.toLowerCase() !== "board") {
    names.push(full);
    const first = full.split(/\s+/)[0];
    if (first && first.length >= 2) names.push(first);
  }
  return names;
}

const RECOMMENDATION_LINE = /^\s*(?:[-*>]\s*)?(?:\*\*|__)?(?:my\s+)?(?:recommendation|recommended|i\s+recommend)(?:\*\*|__)?\s*[:.-]?\s*(?:\*\*|__)?\s*(.+)$/im;

/** A "Recommendation: ..." (or "I recommend ...") line in an agent comment. */
export function recommendationFromComment(body: string | null | undefined): string | null {
  if (!body) return null;
  const match = RECOMMENDATION_LINE.exec(body);
  const text = match?.[1]?.replace(/\*\*|__/g, "").trim();
  return text ? commentExcerpt(text, 400) : null;
}

/** The card option a recommendation points at, when it names one. */
export function recommendedActionId(text: string): DecisionCardActionId | null {
  const lower = text.toLowerCase();
  if (/\b(reassign|hand (?:it )?(?:over|to)|give it to)\b/.test(lower)) return "reassign";
  if (/\bcancel\b/.test(lower)) return "cancel_task";
  if (/\bretry\b|\btry again\b/.test(lower)) return "retry";
  if (/\bapprove\b/.test(lower)) return "approve";
  if (/\b(reconnect|connect)\b/.test(lower)) return "reconnect";
  if (/\b(set (?:it )?aside|not now|later)\b/.test(lower)) return "not_now";
  return null;
}

/** "SAN-1 Title, SAN-2 Title and SAN-3 Title" (at most `limit`, then "and N more"). */
export function listTasks(labels: string[], limit = 3): string {
  const shown = labels.slice(0, limit);
  const rest = labels.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  if (shown.length <= 1) return shown[0] ?? "";
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}
