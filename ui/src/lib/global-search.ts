/**
 * Helpers for global search (Cmd/Ctrl+K from any screen): plain-word labels
 * and a small ranker for the sources the palette matches in the browser
 * (clients, routines). Server search covers tasks, documents, agents and
 * projects; memory has its own `q` filter.
 */

/** Task status in the words Ben uses, not the stored enum. */
const TASK_STATUS_WORDS: Record<string, string> = {
  backlog: "Not started",
  todo: "To do",
  in_progress: "Being worked on",
  in_review: "Waiting for review",
  blocked: "Stuck",
  done: "Done",
  cancelled: "Cancelled",
};

export function plainTaskStatus(status: string | null | undefined): string {
  if (!status) return "";
  return TASK_STATUS_WORDS[status] ?? status.replace(/_/g, " ");
}

/** True for a task that can still be marked done. */
export function isOpenTaskStatus(status: string | null | undefined): boolean {
  return status !== "done" && status !== "cancelled";
}

/**
 * Score `fields` (most important first) against a query. Every word of the
 * query must appear in at least one field; earlier fields and word starts
 * score higher. `null` means no match.
 */
export function scoreTextMatch(query: string, fields: ReadonlyArray<string | null | undefined>): number | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const haystacks = fields.map((field) => (field ?? "").toLowerCase());
  let score = 0;
  for (const word of words) {
    let best: number | null = null;
    haystacks.forEach((text, index) => {
      const at = text.indexOf(word);
      if (at < 0) return;
      const weight = (haystacks.length - index) * 100;
      const startsWord = at === 0 || /[^a-z0-9]/.test(text[at - 1]!);
      const value = weight + (startsWord ? 50 : 0) + (text === word ? 50 : 0);
      if (best === null || value > best) best = value;
    });
    if (best === null) return null;
    score += best;
  }
  return score;
}

/** Rank `items` by `scoreTextMatch` over their fields and keep the top `limit`. */
export function rankByText<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => ReadonlyArray<string | null | undefined>,
  limit: number,
): T[] {
  return items
    .map((item) => ({ item, score: scoreTextMatch(query, fields(item)) }))
    .filter((entry): entry is { item: T; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item);
}

/** Window event that opens the command palette from anywhere (header button, tutorials). */
export const OPEN_COMMAND_PALETTE_EVENT = "gsam:open-command-palette";

export function openCommandPalette(query?: string) {
  window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT, { detail: { query: query ?? "" } }));
}
