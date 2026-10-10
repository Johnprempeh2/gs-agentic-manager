import { formatEvidenceFootnote } from "./document-evidence.js";
import type { DocumentEvidenceBulletView } from "./types/document-evidence.js";

/**
 * Pre-fill draft KPIs from a research pack (GRE-1161, scope rev 3 section 2.3
 * and P6). Slide 5 lists reference points: a peer benchmark and, where the
 * client has one, its own baseline. These helpers turn its bullets into
 * suggestions a person checks and edits before the drafts are created.
 *
 * Peer figures are context, not targets: they go into the benchmark note,
 * never the baseline or the target.
 */

/** Slide 5 heading in the pre-read, e.g. "Slide 5. Benchmarks, limits and workshop questions". */
const SLIDE_FIVE_SECTION = /^slide\s*5\b/i;

/** "baseline 12.5%", "Baseline: USD 4.2m", "client baseline 31 days". */
const BASELINE_VALUE = /\bbaseline\b[^0-9\-]{0,24}(-?\d[\d,]*(?:\.\d+)?)\s*(%|[A-Za-z]{1,12})?/i;
const CURRENCY_BEFORE = /\b([A-Z]{3})\s*$/;
const TRAILING_SOURCE_KEYS = /(\s*\[[^\]]+\])+\s*\.?\s*$/;
const MAX_TITLE_CHARS = 120;

export interface KpiDraftSuggestion {
  bulletId: string;
  section: string | null;
  /** The bullet as written on the slide. */
  text: string;
  title: string;
  /** Only filled when the bullet names the client's baseline; a person enters it otherwise. */
  baselineValue: number | null;
  unit: string | null;
  /** "YYYY-MM-DD": end of the data period, else the date of the first linked source. */
  baselineDate: string | null;
  /** The bullet and its sources, kept with the draft as context for the target. */
  benchmarkNote: string;
  /** True when no source is linked; the person should check it before using the row. */
  unsourced: boolean;
}

export function isPackReferenceSection(section: string | null | undefined): boolean {
  return section != null && SLIDE_FIVE_SECTION.test(section.trim());
}

function suggestTitle(text: string): string {
  const withoutKeys = text.replace(TRAILING_SOURCE_KEYS, "").trim();
  const head = withoutKeys.split(/:|\s[-–—]\s|,|;|\.\s/)[0]?.trim() || withoutKeys;
  return head.length > MAX_TITLE_CHARS ? `${head.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : head;
}

function suggestBaseline(text: string): { value: number | null; unit: string | null } {
  const match = BASELINE_VALUE.exec(text);
  if (!match) return { value: null, unit: null };
  const value = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(value)) return { value: null, unit: null };
  const currency = CURRENCY_BEFORE.exec(text.slice(0, match.index + match[0].indexOf(match[1])))?.[1] ?? null;
  const after = match[2] ?? null;
  const unit = after === "%" ? "%" : currency ?? after;
  return { value, unit };
}

/** Slide-5 bullets of a pack document as editable draft-KPI rows, in slide order. */
export function suggestKpiDraftsFromPack(bullets: readonly DocumentEvidenceBulletView[]): KpiDraftSuggestion[] {
  const seen = new Set<string>();
  const out: KpiDraftSuggestion[] = [];
  for (const bullet of bullets) {
    if (!isPackReferenceSection(bullet.section) || seen.has(bullet.bulletId)) continue;
    seen.add(bullet.bulletId);
    const firstSource = bullet.link?.sources[0] ?? null;
    const footnote = formatEvidenceFootnote(bullet.link);
    const baseline = suggestBaseline(bullet.text);
    out.push({
      bulletId: bullet.bulletId,
      section: bullet.section,
      text: bullet.text,
      title: suggestTitle(bullet.text),
      baselineValue: baseline.value,
      unit: baseline.unit,
      baselineDate: firstSource?.periodEnd ?? firstSource?.sourceDate ?? null,
      benchmarkNote: footnote ? `${bullet.bulletId}: ${bullet.text}\nSources: ${footnote}` : `${bullet.bulletId}: ${bullet.text}`,
      unsourced: !bullet.link || bullet.link.sources.length === 0,
    });
  }
  return out;
}
