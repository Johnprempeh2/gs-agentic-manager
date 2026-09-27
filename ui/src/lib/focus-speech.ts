/**
 * Listen and Speak helpers for Decisions Focus mode (GRE-55). Pure functions:
 * the spoken summary a question card reads aloud, and the "option N" command a
 * dictated note can carry. The browser speech APIs live in the hooks.
 */

export interface SpokenOption {
  label: string;
  description?: string | null;
}

export interface SpokenSummaryInput {
  agentName: string | null;
  taskIdentifier: string | null;
  taskTitle: string | null;
  question: string;
  /** The agent's background note (summary / details / help text). */
  background: string | null;
  options: SpokenOption[];
  /** Word read before each option number. Defaults to "Option". */
  optionNoun?: string;
}

export type SpokenPart =
  | { kind: "intro"; text: string }
  | { kind: "question"; text: string }
  | { kind: "background"; text: string; sentenceIndex: number }
  | { kind: "option"; text: string; optionIndex: number };

/** Markdown down to speakable plain text: no marks, links read as their label. */
export function plainTextFromMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(\S(?:[\s\S]*?\S)?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split prose into sentences, keeping the closing punctuation. */
export function splitSentences(text: string): string[] {
  // A boundary is closing punctuation, a space, then a capital or digit — so
  // "v1.2" and "e.g. retry" stay inside their sentence.
  return text
    .trim()
    .replace(/([.!?]+["')\]]*)\s+(?=["'(\[]?[A-Z0-9])/g, "$1\u0000")
    .split("\u0000")
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function endSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?:]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * The spoken summary, one part per utterance, in the order the preview fixed:
 * who asks, the task, the question, the short background, then the options.
 * No background note → question and options only.
 */
export function buildSpokenSummary(input: SpokenSummaryInput): SpokenPart[] {
  const parts: SpokenPart[] = [];
  const who = input.agentName?.trim() || "An agent";
  const task = [input.taskIdentifier?.trim(), input.taskTitle?.trim()].filter(Boolean).join(", ");
  parts.push({ kind: "intro", text: task ? `${who} asks, on ${task}.` : `${who} asks.` });

  const question = plainTextFromMarkdown(input.question);
  if (question) parts.push({ kind: "question", text: endSentence(question) });

  const background = input.background ? plainTextFromMarkdown(input.background) : "";
  splitSentences(background).forEach((sentence, sentenceIndex) => {
    parts.push({ kind: "background", text: sentence, sentenceIndex });
  });

  const noun = input.optionNoun ?? "Option";
  input.options.forEach((option, optionIndex) => {
    const label = plainTextFromMarkdown(option.label);
    const description = option.description ? plainTextFromMarkdown(option.description) : "";
    const body = description ? `${endSentence(label)} ${endSentence(description)}` : endSentence(label);
    parts.push({ kind: "option", text: `${noun} ${optionIndex + 1}: ${body}`, optionIndex });
  });

  return parts;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, won: 1, first: 1,
  two: 2, to: 2, too: 2, second: 2,
  three: 3, third: 3,
  four: 4, for: 4, fore: 4, fourth: 4,
  five: 5, fifth: 5,
  six: 6, sixth: 6,
  seven: 7, seventh: 7,
  eight: 8, ate: 8, eighth: 8,
  nine: 9, ninth: 9,
};

const NUMBER_PATTERN = `(\\d{1,2}|${Object.keys(NUMBER_WORDS).join("|")})`;
const OPTION_COMMAND = new RegExp(`\\boption\\s+(?:number\\s+)?${NUMBER_PATTERN}\\b`, "i");
const ORDINAL_COMMAND = new RegExp(`\\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)\\s+option\\b`, "i");

/**
 * "option two", "option 2", "option number two" or "the second option" in a
 * dictated note → 2. Speech engines often hear "option two" as "option to", so
 * the homophones count. Returns null for no command or a number with no option.
 */
export function parseOptionCommand(transcript: string, optionCount: number): number | null {
  const match = OPTION_COMMAND.exec(transcript) ?? ORDINAL_COMMAND.exec(transcript);
  if (!match) return null;
  const token = match[1]!.toLowerCase();
  const value = /^\d+$/.test(token) ? Number(token) : NUMBER_WORDS[token];
  if (!value || value < 1 || value > optionCount) return null;
  return value;
}
