// One document, many entries (Ben, 13 Oct). The server already folds versions
// that share an issue and a key. Agents also re-register the same document
// under a new key or on a new task ("... v2", "... (draft)", "... 13 Oct
// 2026"), which the server sees as different deliverables. The Deliverables
// page folds those too: same project, same title once the version, status
// and date suffixes are taken off.

const MONTHS =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

/** Separators and brackets that can sit between a title and its suffix. */
const TRAILING_SEPARATORS = /[\s\-\u2013\u2014_:,.|/()[\]]+$/;
const LEFT = "(?:^|[\\s\\-\\u2013\\u2014_:,|/(\\[])";

/** Suffixes that name a version, a status or a date, never the document. */
const SUFFIXES: RegExp[] = [
  new RegExp(`${LEFT}(?:v|ver|version|rev|revision)\\s*\\.?\\s*\\d+(?:\\.\\d+)*$`),
  new RegExp(`${LEFT}(?:draft|final|updated|latest|copy|wip)$`),
  new RegExp(`${LEFT}\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}$`),
  new RegExp(`${LEFT}\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}$`),
  new RegExp(`${LEFT}\\d{8}$`),
  new RegExp(`${LEFT}\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\.?,?\\s+\\d{4}$`),
  new RegExp(`${LEFT}(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}$`),
  new RegExp(`${LEFT}(?:${MONTHS})\\.?\\s+\\d{4}$`),
];

/**
 * The document a title names: lower case, accents and punctuation gone, and
 * any trailing version ("v5.3", "version 3", "rev 2"), status ("(draft)",
 * "final") or date ("2026-10-13", "13 Oct 2026") suffixes removed, however
 * many are stacked. Two titles that normalise to the same text are versions
 * of one document.
 */
export function normaliseDeliverableTitle(title: string): string {
  let value = title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").trim();
  for (;;) {
    const trimmed = value.replace(TRAILING_SEPARATORS, "");
    const next = SUFFIXES.reduce((text, pattern) => text.replace(pattern, ""), trimmed);
    if (next === value) break;
    value = next;
  }
  return value.replace(/[^a-z0-9]+/g, " ").trim();
}

export interface DeliverableVersionCandidate {
  id: string;
  title: string;
  createdAt: string;
  version: number;
  project: { id: string } | null;
}

export interface DeliverableDocumentGroup<T extends DeliverableVersionCandidate> {
  /** `project id or "none"` + the normalised title. */
  key: string;
  /** The newest entry: the one the card shows. */
  latest: T;
  /** Every other entry for the same document, newest first. */
  older: T[];
}

function newerFirst(a: DeliverableVersionCandidate, b: DeliverableVersionCandidate): number {
  return b.createdAt.localeCompare(a.createdAt) || b.version - a.version || a.id.localeCompare(b.id);
}

/**
 * Folds entries for the same document into one group each: same project
 * (entries with no project only match each other) and the same normalised
 * title. Groups keep the order their first entry has in `items`, so the
 * list sort still holds; inside a group the newest entry leads. A title that
 * normalises to nothing ("v2") never merges with anything.
 */
export function groupDeliverableDocuments<T extends DeliverableVersionCandidate>(items: readonly T[]): Array<DeliverableDocumentGroup<T>> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const title = normaliseDeliverableTitle(item.title);
    const key = `${item.project?.id ?? "none"}:${title || `id:${item.id}`}`;
    const members = groups.get(key);
    if (members) members.push(item);
    else groups.set(key, [item]);
  }
  return [...groups].map(([key, members]) => {
    const [latest, ...older] = [...members].sort(newerFirst);
    return { key, latest: latest!, older };
  });
}
