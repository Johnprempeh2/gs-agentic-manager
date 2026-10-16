/**
 * Word-level diff for editable draft cards (request_draft_review). Shared so
 * the card's live "3 changes" count and the stored result use one algorithm.
 */

export type DraftDiffSegmentType = "same" | "added" | "removed";

export interface DraftDiffSegment {
  type: DraftDiffSegmentType;
  text: string;
}

export interface DraftDiff {
  segments: DraftDiffSegment[];
  /** Contiguous edited regions; a replaced phrase counts once. */
  changeCount: number;
  addedWords: number;
  removedWords: number;
}

// ponytail: O(n*m) LCS table; past this many tokens a side we treat the
// whole text as one replacement. Upgrade to Myers if long drafts need detail.
const MAX_LCS_TOKENS = 2_000;

function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((token) => token.length > 0);
}

function isWord(token: string) {
  return /\S/.test(token);
}

function pushSegment(segments: DraftDiffSegment[], type: DraftDiffSegmentType, text: string) {
  const last = segments[segments.length - 1];
  if (last && last.type === type) last.text += text;
  else segments.push({ type, text });
}

export function diffDraftWords(original: string, edited: string): DraftDiff {
  const a = tokenize(original);
  const b = tokenize(edited);
  const segments: DraftDiffSegment[] = [];

  if (a.length > MAX_LCS_TOKENS || b.length > MAX_LCS_TOKENS) {
    if (original !== edited) {
      if (original) segments.push({ type: "removed", text: original });
      if (edited) segments.push({ type: "added", text: edited });
    } else if (original) {
      segments.push({ type: "same", text: original });
    }
  } else {
    const n = a.length;
    const m = b.length;
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        pushSegment(segments, "same", a[i]);
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        pushSegment(segments, "removed", a[i++]);
      } else {
        pushSegment(segments, "added", b[j++]);
      }
    }
    while (i < n) pushSegment(segments, "removed", a[i++]);
    while (j < m) pushSegment(segments, "added", b[j++]);
  }

  // Whitespace-only "same" runs between edits do not split a change.
  let changeCount = 0;
  let inChange = false;
  let addedWords = 0;
  let removedWords = 0;
  for (const segment of segments) {
    const words = tokenize(segment.text).filter(isWord).length;
    if (segment.type === "same") {
      if (words > 0) inChange = false;
      continue;
    }
    if (segment.type === "added") addedWords += words;
    else removedWords += words;
    if (!inChange) {
      changeCount++;
      inChange = true;
    }
  }
  return { segments, changeCount, addedWords, removedWords };
}

/** One factual line about an edit, for the drafting agent's working notes. */
export function describeDraftEdit(diff: DraftDiff): string {
  if (diff.changeCount === 0) return "No changes.";
  const parts = [`${diff.changeCount} ${diff.changeCount === 1 ? "change" : "changes"}`];
  if (diff.removedWords > 0) parts.push(`${diff.removedWords} words removed`);
  if (diff.addedWords > 0) parts.push(`${diff.addedWords} words added`);
  return `${parts.join(", ")}.`;
}
