/**
 * Saved reply snippets for the task chat composer. They live in this browser
 * only, so a board member keeps their own phrases without a server round trip.
 * All storage access is guarded so disabled or full storage never throws.
 */

export const REPLY_SNIPPETS_KEY = "paperclip:reply-snippets";
export const MAX_REPLY_SNIPPETS = 20;

export const DEFAULT_REPLY_SNIPPETS: readonly string[] = [
  "Approved, go ahead.",
  "Please add your sources and links.",
  "Keep it shorter and in plain English.",
  "Check with me before you send anything outside the company.",
];

export function loadReplySnippets(): string[] {
  try {
    const raw = localStorage.getItem(REPLY_SNIPPETS_KEY);
    if (raw === null) return [...DEFAULT_REPLY_SNIPPETS];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_REPLY_SNIPPETS];
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [...DEFAULT_REPLY_SNIPPETS];
  }
}

function saveReplySnippets(snippets: string[]): void {
  try {
    localStorage.setItem(REPLY_SNIPPETS_KEY, JSON.stringify(snippets));
  } catch {
    // Storage is full or disabled; the snippet simply is not kept.
  }
}

/** Adds a snippet to the top, dropping an exact duplicate and the oldest past the cap. */
export function addReplySnippet(snippets: string[], text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return snippets;
  const next = [trimmed, ...snippets.filter((item) => item !== trimmed)].slice(0, MAX_REPLY_SNIPPETS);
  saveReplySnippets(next);
  return next;
}

export function removeReplySnippet(snippets: string[], text: string): string[] {
  const next = snippets.filter((item) => item !== text);
  saveReplySnippets(next);
  return next;
}

/** One line for the menu: the first line, cut to a readable length. */
export function snippetLabel(text: string, max = 60): string {
  const firstLine = text.trim().split("\n")[0] ?? "";
  return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine;
}
