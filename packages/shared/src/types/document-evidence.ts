/**
 * Evidence trail on documents (GRE-1146, scope rev 3 section 2.3, GRE-1137).
 *
 * A bullet is identified by the bold ID at the start of a list item or table
 * row (`- **S1** ...`, `| **E3, economic** | ... |`). Each bullet can carry one
 * or more source links with labels; the check lists bullets with no source or
 * a missing label.
 */

export const DOCUMENT_EVIDENCE_SOURCE_TYPES = ["actual", "forecast", "estimate"] as const;
export type DocumentEvidenceSourceType = (typeof DOCUMENT_EVIDENCE_SOURCE_TYPES)[number];

export const DOCUMENT_EVIDENCE_FRESHNESS = ["current", "stale"] as const;
export type DocumentEvidenceFreshness = (typeof DOCUMENT_EVIDENCE_FRESHNESS)[number];

/** A source older than this many months must be marked stale (scope rev 3, 2.3). */
export const DOCUMENT_EVIDENCE_STALE_AFTER_MONTHS = 18;
/** Pass mark: "no source" plus "label missing" flags must stay under this share of bullets. */
export const DOCUMENT_EVIDENCE_PASS_MARK = 0.2;

export interface DocumentEvidenceSource {
  /** Claim or source key from the evidence table, e.g. "F2" or "C-014". */
  sourceId: string;
  /** Page, section or URL. */
  locator?: string | null;
  /** "YYYY-MM-DD": published date, or access date for a web page. For a forecast, the date it was made. */
  sourceDate?: string | null;
  type?: DocumentEvidenceSourceType | null;
  /** "YYYY-MM-DD": end of the data period. A forecast whose period has ended must be marked stale. */
  periodEnd?: string | null;
  /** Area the source covers, e.g. "WAEMU, not Côte d'Ivoire". */
  geography?: string | null;
  freshness?: DocumentEvidenceFreshness | null;
  note?: string | null;
}

export interface DocumentEvidenceLink {
  id: string;
  companyId: string;
  issueId: string;
  documentId: string;
  documentKey: string;
  bulletId: string;
  sources: DocumentEvidenceSource[];
  /** A conclusion drawn from facts, not a fact. */
  inference: boolean;
  /** "Suggested, judgement": a consultant field the reviewer sets. */
  judgement: boolean;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface DocumentEvidenceBullet {
  bulletId: string;
  /** Nearest heading above the bullet, e.g. "Slide 1. Strengths". */
  section: string | null;
  text: string;
  line: number;
}

export type DocumentEvidenceFlagCategory = "no_source" | "label_missing" | "judgement" | "ok";

export interface DocumentEvidenceBulletCheck {
  bulletId: string;
  section: string | null;
  category: DocumentEvidenceFlagCategory;
  /** Plain-language reasons, e.g. "U1: forecast period has ended, mark it stale". */
  reasons: string[];
}

export interface DocumentEvidenceCheck {
  checkedAt: string;
  totals: {
    bullets: number;
    noSource: number;
    labelMissing: number;
    judgement: number;
    ok: number;
  };
  /** (noSource + labelMissing) / bullets, 0 when there are no bullets. */
  flagRate: number;
  passMark: number;
  pass: boolean;
  bullets: DocumentEvidenceBulletCheck[];
  /** Links whose bullet ID is no longer in the document. */
  orphanedBulletIds: string[];
  /** Bullet IDs used more than once in the document; only the first is checked. */
  duplicateBulletIds: string[];
}

export interface DocumentEvidenceBulletView extends DocumentEvidenceBullet {
  link: DocumentEvidenceLink | null;
}

export interface DocumentEvidenceView {
  issueId: string;
  documentKey: string;
  documentId: string;
  revisionNumber: number;
  bullets: DocumentEvidenceBulletView[];
  orphanedLinks: DocumentEvidenceLink[];
  check: DocumentEvidenceCheck;
}

export interface DocumentEvidenceExportBullet {
  bulletId: string;
  section: string | null;
  text: string;
  /** One line for the slide footnote or notes field. Empty when the bullet has no source. */
  footnote: string;
  sources: DocumentEvidenceSource[];
  inference: boolean;
  judgement: boolean;
}

export interface DocumentEvidenceExportSection {
  section: string | null;
  /** Notes-field text for the slide: one footnote line per bullet. */
  notes: string;
  bullets: DocumentEvidenceExportBullet[];
}

export interface DocumentEvidenceExportSource extends DocumentEvidenceSource {
  citedBy: string[];
}

export interface DocumentEvidenceExport {
  issueId: string;
  documentKey: string;
  revisionNumber: number;
  sections: DocumentEvidenceExportSection[];
  /** Evidence appendix: each source once, with the bullets that cite it. */
  sources: DocumentEvidenceExportSource[];
  check: DocumentEvidenceCheck;
  /** The same content as markdown, for an agent or a notes file. */
  markdown: string;
}

export interface UpsertDocumentEvidenceBullet {
  bulletId: string;
  sources: DocumentEvidenceSource[];
  inference?: boolean;
  judgement?: boolean;
}

export interface UpsertDocumentEvidenceRequest {
  bullets: UpsertDocumentEvidenceBullet[];
}
