import { describe, expect, it } from "vitest";
import { extractEvidenceBullets } from "./document-evidence.js";
import { isPackReferenceSection, suggestKpiDraftsFromPack } from "./goal-kpi-drafts.js";
import { createKpiDraftsFromPackSchema } from "./validators/goal.js";
import type { DocumentEvidenceBulletView, DocumentEvidenceLink } from "./types/document-evidence.js";

/** Made-up company, same shape as the rev 3 pre-read. */
const PRE_READ = [
  "## Slide 4. Risks for consultant review",
  "- **R1** FX risk. [F1]",
  "## Slide 5. Benchmarks, limits and workshop questions",
  "- **B1** Gross margin: client baseline 18.5% (FY2025); peer median 24% (listed millers, FY2025). [F2] [P1]",
  "- **B2** Days sales outstanding, baseline USD 41 days, peer 30 days. [P2]",
  "- **B3** Feed volume growth, peers 6-9% a year. [P3]",
].join("\n");

function link(bulletId: string, extra: Partial<DocumentEvidenceLink> = {}): DocumentEvidenceLink {
  return {
    id: `link-${bulletId}`,
    companyId: "c1",
    issueId: "i1",
    documentId: "d1",
    documentKey: "pre-read",
    bulletId,
    sources: [{ sourceId: "P1", locator: "page 12", sourceDate: "2026-03-01", periodEnd: "2025-12-31", type: "actual", geography: "Ghana", freshness: "current" }],
    inference: false,
    judgement: false,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    createdAt: "2026-10-09T00:00:00Z",
    updatedAt: "2026-10-09T00:00:00Z",
    ...extra,
  };
}

function view(links: Record<string, DocumentEvidenceLink>): DocumentEvidenceBulletView[] {
  return extractEvidenceBullets(PRE_READ).map((bullet) => ({ ...bullet, link: links[bullet.bulletId] ?? null }));
}

describe("suggestKpiDraftsFromPack", () => {
  it("takes slide-5 bullets only, with title, the client's baseline and the sources in the benchmark note", () => {
    const rows = suggestKpiDraftsFromPack(view({ B1: link("B1") }));
    expect(rows.map((row) => row.bulletId)).toEqual(["B1", "B2", "B3"]);
    expect(rows[0]).toMatchObject({
      title: "Gross margin",
      baselineValue: 18.5,
      unit: "%",
      baselineDate: "2025-12-31",
      unsourced: false,
    });
    expect(rows[0].benchmarkNote).toContain("peer median 24%");
    expect(rows[0].benchmarkNote).toContain("Sources: P1, page 12, 2026-03-01, actual, Ghana, current");
  });

  it("reads a currency before the number and never uses a peer figure as the baseline", () => {
    const rows = suggestKpiDraftsFromPack(view({}));
    expect(rows[1]).toMatchObject({ title: "Days sales outstanding", baselineValue: 41, unit: "USD", unsourced: true });
    // Only peers on the line: the person enters the client's baseline.
    expect(rows[2]).toMatchObject({ title: "Feed volume growth", baselineValue: null, unit: null, baselineDate: null });
  });

  it("matches the slide 5 heading loosely", () => {
    expect(isPackReferenceSection("Slide 5. Benchmarks")).toBe(true);
    expect(isPackReferenceSection("slide 5 – reference points")).toBe(true);
    expect(isPackReferenceSection("Slide 50")).toBe(false);
    expect(isPackReferenceSection(null)).toBe(false);
  });
});

describe("createKpiDraftsFromPackSchema", () => {
  const row = { bulletId: "B1", title: "Gross margin", baselineValue: 18.5, baselineDate: "2025-12-31" };
  const sourceIssueId = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

  it("defaults the document to the pre-read and needs at least one row", () => {
    expect(createKpiDraftsFromPackSchema.parse({ sourceIssueId, rows: [row] }).documentKey).toBe("pre-read");
    expect(createKpiDraftsFromPackSchema.safeParse({ sourceIssueId, rows: [] }).success).toBe(false);
  });

  it("refuses the same bullet twice and a row without a baseline", () => {
    expect(createKpiDraftsFromPackSchema.safeParse({ sourceIssueId, rows: [row, row] }).success).toBe(false);
    const { baselineValue: _omit, ...noBaseline } = row;
    expect(createKpiDraftsFromPackSchema.safeParse({ sourceIssueId, rows: [noBaseline] }).success).toBe(false);
  });
});
