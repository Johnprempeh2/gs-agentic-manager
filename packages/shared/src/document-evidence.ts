import {
  DOCUMENT_EVIDENCE_PASS_MARK,
  DOCUMENT_EVIDENCE_STALE_AFTER_MONTHS,
  type DocumentEvidenceBullet,
  type DocumentEvidenceBulletCheck,
  type DocumentEvidenceCheck,
  type DocumentEvidenceExport,
  type DocumentEvidenceExportBullet,
  type DocumentEvidenceExportSection,
  type DocumentEvidenceExportSource,
  type DocumentEvidenceSource,
} from "./types/document-evidence.js";

/**
 * Evidence trail (GRE-1146): find the bullets in a document, check their
 * source links against the labelling rules in scope rev 3 section 2.3, and
 * build the notes and appendix the deck builder copies into the deck.
 */

type EvidenceLinkInput = {
  bulletId: string;
  sources: DocumentEvidenceSource[];
  inference: boolean;
  judgement: boolean;
};

const BOLD_ID_AT_START = /^\*\*([A-Z]{1,4}-?\d{1,4})(?=[\s,.:;*])([^*]*)\*\*\s*(.*)$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  // Header separator rows: | --- | :---: |
  if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) return null;
  return cells;
}

/**
 * Bullets are list items or table rows that start with a bold ID:
 * `- **S1** Revenue ...` or `| **E3, economic** | The World Bank ... |`.
 * Lines without a bold ID (headings, prose, table headers) are not bullets.
 */
export function extractEvidenceBullets(markdown: string): DocumentEvidenceBullet[] {
  const bullets: DocumentEvidenceBullet[] = [];
  let section: string | null = null;
  let inFence = false;
  const lines = markdown.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const heading = HEADING.exec(line);
    if (heading) {
      section = stripInlineMarkdown(heading[1]) || null;
      return;
    }
    const listItem = LIST_ITEM.exec(line);
    if (listItem) {
      const match = BOLD_ID_AT_START.exec(listItem[1].trim());
      if (match) {
        bullets.push({ bulletId: match[1], section, text: stripInlineMarkdown(match[3]), line: index + 1 });
      }
      return;
    }
    const cells = splitTableRow(line);
    if (cells && cells.length > 0) {
      const match = BOLD_ID_AT_START.exec(cells[0]);
      if (match) {
        const label = stripInlineMarkdown(match[2].replace(/^[\s,.:;]+/, ""));
        const text = [label, ...cells.slice(1).map(stripInlineMarkdown)].filter(Boolean).join(" | ");
        bullets.push({ bulletId: match[1], section, text, line: index + 1 });
      }
    }
  });
  return bullets;
}

function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function monthsBefore(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  result.setUTCMonth(result.getUTCMonth() - months);
  return result;
}

/** Missing or inconsistent labels on one source, in plain words. */
export function evidenceSourceLabelProblems(source: DocumentEvidenceSource, now: Date): string[] {
  const problems: string[] = [];
  const id = source.sourceId;
  if (!source.locator) problems.push(`${id}: page or URL missing`);
  if (!source.sourceDate) problems.push(`${id}: date missing`);
  if (!source.type) problems.push(`${id}: type missing (actual, forecast or estimate)`);
  if (!source.geography) problems.push(`${id}: geography missing`);
  if (!source.freshness) {
    problems.push(`${id}: freshness missing (current or stale)`);
  } else if (source.freshness !== "stale") {
    const sourceDate = parseIsoDate(source.sourceDate);
    const periodEnd = parseIsoDate(source.periodEnd);
    if (sourceDate && sourceDate < monthsBefore(now, DOCUMENT_EVIDENCE_STALE_AFTER_MONTHS)) {
      problems.push(`${id}: source is older than ${DOCUMENT_EVIDENCE_STALE_AFTER_MONTHS} months, mark it stale`);
    } else if (source.type === "forecast" && periodEnd && periodEnd < now) {
      problems.push(`${id}: forecast period has ended, mark it stale until the actual replaces it`);
    }
  }
  return problems;
}

/**
 * Sorts each bullet into one category, worst first: no source, label missing,
 * judgement (a correctly marked consultant field), ok. The flag rate counts
 * "no source" and "label missing" only, as the scope's pass mark does.
 */
export function checkDocumentEvidence(input: {
  bullets: DocumentEvidenceBullet[];
  links: EvidenceLinkInput[];
  now?: Date;
}): DocumentEvidenceCheck {
  const now = input.now ?? new Date();
  const linksByBullet = new Map(input.links.map((link) => [link.bulletId, link]));
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const results: DocumentEvidenceBulletCheck[] = [];
  for (const bullet of input.bullets) {
    if (seen.has(bullet.bulletId)) {
      duplicates.add(bullet.bulletId);
      continue;
    }
    seen.add(bullet.bulletId);
    const link = linksByBullet.get(bullet.bulletId);
    const base = { bulletId: bullet.bulletId, section: bullet.section };
    if (!link || link.sources.length === 0) {
      results.push({ ...base, category: "no_source", reasons: ["No source linked"] });
      continue;
    }
    const reasons = link.sources.flatMap((source) => evidenceSourceLabelProblems(source, now));
    if (reasons.length > 0) {
      results.push({ ...base, category: "label_missing", reasons });
    } else if (link.judgement) {
      results.push({ ...base, category: "judgement", reasons: ["Suggested, judgement: the consultant sets it at R2"] });
    } else {
      results.push({ ...base, category: "ok", reasons: [] });
    }
  }
  const count = (category: DocumentEvidenceBulletCheck["category"]) =>
    results.filter((result) => result.category === category).length;
  const totals = {
    bullets: results.length,
    noSource: count("no_source"),
    labelMissing: count("label_missing"),
    judgement: count("judgement"),
    ok: count("ok"),
  };
  const flagRate = totals.bullets === 0 ? 0 : (totals.noSource + totals.labelMissing) / totals.bullets;
  return {
    checkedAt: now.toISOString(),
    totals,
    flagRate: Math.round(flagRate * 1000) / 1000,
    passMark: DOCUMENT_EVIDENCE_PASS_MARK,
    pass: flagRate < DOCUMENT_EVIDENCE_PASS_MARK,
    bullets: results,
    orphanedBulletIds: input.links.map((link) => link.bulletId).filter((id) => !seen.has(id)).sort(),
    duplicateBulletIds: [...duplicates].sort(),
  };
}

/** "F2, pages 1-2, 2026-10-09, actual, Ghana, current". Missing labels are left out, not invented. */
export function formatEvidenceSource(source: DocumentEvidenceSource): string {
  const parts = [source.sourceId, source.locator, source.sourceDate, source.type];
  if (source.type === "forecast" && source.periodEnd) parts.push(`period to ${source.periodEnd}`);
  parts.push(source.geography, source.freshness, source.note);
  return parts.filter((part): part is string => Boolean(part)).join(", ");
}

export function formatEvidenceFootnote(link: EvidenceLinkInput | null | undefined): string {
  if (!link || link.sources.length === 0) return "";
  const markers = [link.inference ? "inference" : null, link.judgement ? "suggested, judgement" : null].filter(Boolean);
  const sources = link.sources.map(formatEvidenceSource).join("; ");
  return markers.length > 0 ? `${sources} [${markers.join("; ")}]` : sources;
}

/** Notes per slide, footnotes per bullet and the source appendix, for the deck builder. */
export function buildDocumentEvidenceExport(input: {
  issueId: string;
  documentKey: string;
  revisionNumber: number;
  bullets: DocumentEvidenceBullet[];
  links: EvidenceLinkInput[];
  now?: Date;
}): DocumentEvidenceExport {
  const check = checkDocumentEvidence(input);
  const linksByBullet = new Map(input.links.map((link) => [link.bulletId, link]));
  const sections: DocumentEvidenceExportSection[] = [];
  const sourcesById = new Map<string, DocumentEvidenceExportSource>();
  const seen = new Set<string>();
  for (const bullet of input.bullets) {
    if (seen.has(bullet.bulletId)) continue;
    seen.add(bullet.bulletId);
    const link = linksByBullet.get(bullet.bulletId) ?? null;
    const exportBullet: DocumentEvidenceExportBullet = {
      bulletId: bullet.bulletId,
      section: bullet.section,
      text: bullet.text,
      footnote: formatEvidenceFootnote(link),
      sources: link?.sources ?? [],
      inference: link?.inference ?? false,
      judgement: link?.judgement ?? false,
    };
    let section = sections[sections.length - 1];
    if (!section || section.section !== bullet.section) {
      section = { section: bullet.section, notes: "", bullets: [] };
      sections.push(section);
    }
    section.bullets.push(exportBullet);
    for (const source of exportBullet.sources) {
      const existing = sourcesById.get(source.sourceId);
      if (existing) {
        if (!existing.citedBy.includes(bullet.bulletId)) existing.citedBy.push(bullet.bulletId);
      } else {
        sourcesById.set(source.sourceId, { ...source, citedBy: [bullet.bulletId] });
      }
    }
  }
  for (const section of sections) {
    section.notes = section.bullets
      .map((bullet) => `${bullet.bulletId}: ${bullet.footnote || "NO SOURCE"}`)
      .join("\n");
  }
  const sources = [...sourcesById.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId));

  const markdown = [
    `# Evidence notes: ${input.documentKey} (revision ${input.revisionNumber})`,
    "",
    `Check: ${check.totals.noSource} no source, ${check.totals.labelMissing} label missing, ` +
      `${check.totals.judgement} judgement, of ${check.totals.bullets} bullets ` +
      `(flag rate ${Math.round(check.flagRate * 100)}%, ${check.pass ? "pass" : "fail"}).`,
    ...sections.flatMap((section) => [
      "",
      `## ${section.section ?? "Untitled section"}`,
      "",
      ...section.bullets.map((bullet) => `- **${bullet.bulletId}** ${bullet.footnote || "NO SOURCE"}`),
    ]),
    "",
    "## Evidence appendix",
    "",
    "| Source | Page or URL | Date | Type | Geography | Freshness | Cited by |",
    "|---|---|---|---|---|---|---|",
    ...sources.map((source) =>
      `| ${[
        source.sourceId,
        source.locator,
        source.sourceDate,
        source.type,
        source.geography,
        source.freshness,
        source.citedBy.join(", "),
      ].map((cell) => (cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`),
    "",
  ].join("\n");

  return {
    issueId: input.issueId,
    documentKey: input.documentKey,
    revisionNumber: input.revisionNumber,
    sections,
    sources,
    check,
    markdown,
  };
}
