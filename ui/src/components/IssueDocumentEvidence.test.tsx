// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  checkDocumentEvidence,
  extractEvidenceBullets,
  type DocumentEvidenceLink,
  type DocumentEvidenceView,
} from "@greatstone/shared";
import { DocumentEvidencePanel, evidenceCheckSummary } from "./IssueDocumentEvidence";

const BODY = [
  "## Slide 1. Strengths",
  "- **S1** Revenue was USD 78m, actual.",
  "- **S2** Three sites.",
  "## Slide 4. Risks",
  "- **R1** Wheat cost exposure.",
].join("\n");

function link(bulletId: string, overrides: Partial<DocumentEvidenceLink> = {}): DocumentEvidenceLink {
  return {
    id: `link-${bulletId}`,
    companyId: "c1",
    issueId: "i1",
    documentId: "d1",
    documentKey: "pre-read",
    bulletId,
    sources: [{
      sourceId: "F2",
      locator: "https://example.org/report.pdf",
      sourceDate: "2026-10-01",
      type: "actual",
      geography: "Ghana",
      freshness: "current",
    }],
    inference: false,
    judgement: false,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    createdAt: "2026-10-09T00:00:00Z",
    updatedAt: "2026-10-09T00:00:00Z",
    ...overrides,
  };
}

function view(links: DocumentEvidenceLink[]): DocumentEvidenceView {
  const bullets = extractEvidenceBullets(BODY);
  const byId = new Map(links.map((item) => [item.bulletId, item]));
  return {
    issueId: "i1",
    documentKey: "pre-read",
    documentId: "d1",
    revisionNumber: 2,
    bullets: bullets.map((bullet) => ({ ...bullet, link: byId.get(bullet.bulletId) ?? null })),
    orphanedLinks: [],
    check: checkDocumentEvidence({ bullets, links, now: new Date("2026-10-09T00:00:00Z") }),
  };
}

describe("DocumentEvidencePanel", () => {
  it("summarises the check in one line", () => {
    const v = view([link("S1"), link("R1", { judgement: true })]);
    expect(evidenceCheckSummary(v.check)).toBe(
      "1 no source, 0 label missing, 1 judgement of 3 bullets. Not yet (33% flagged, must be under 20%).",
    );
    expect(evidenceCheckSummary(view([link("S1"), link("S2"), link("R1")]).check)).toBe(
      "0 no source, 0 label missing, 0 judgement of 3 bullets. Pass (0% under 20%).",
    );
  });

  it("shows each bullet's sources, labels, markers and the reason it is flagged", () => {
    const html = renderToStaticMarkup(
      <DocumentEvidencePanel
        defaultOpen
        view={view([
          link("S1", { inference: true }),
          link("R1", { judgement: true, sources: [{ sourceId: "F1", locator: "page 2" }] }),
        ])}
      />,
    );
    expect(html).toContain("F2, https://example.org/report.pdf, 2026-10-01, actual, Ghana, current");
    expect(html).toContain('href="https://example.org/report.pdf"');
    expect(html).toContain("Inference");
    expect(html).toContain("Suggested, judgement");
    expect(html).toContain("No source linked");
    expect(html).toContain("F1: type missing (actual, forecast or estimate)");
    expect(html).toContain("Label missing");
  });

  it("does not turn a non-web locator into a link", () => {
    const html = renderToStaticMarkup(
      <DocumentEvidencePanel defaultOpen view={view([link("S1", { sources: [{ sourceId: "F1", locator: "javascript:alert(1)" }] })])} />,
    );
    expect(html).not.toContain("href=");
  });
});
