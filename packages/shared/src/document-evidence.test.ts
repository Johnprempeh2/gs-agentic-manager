import { describe, expect, it } from "vitest";
import {
  buildDocumentEvidenceExport,
  checkDocumentEvidence,
  extractEvidenceBullets,
  formatEvidenceFootnote,
} from "./document-evidence.js";
import type { DocumentEvidenceSource } from "./types/document-evidence.js";
import { upsertDocumentEvidenceSchema } from "./validators/document-evidence.js";

const NOW = new Date("2026-10-09T12:00:00Z");

/** Same shape as the GRE-1141 rev 3 pre-read: 5 + 5 list bullets, 7 + 5 table rows, 5 list bullets. Made-up company. */
const PRE_READ = [
  "# Test Mills, five-slide pre-read",
  "",
  "**FICTIONAL test only.** Source keys point to the step documents.",
  "",
  "## Slide 1. Strengths",
  "",
  ...[1, 2, 3, 4, 5].map((n) => `- **S${n}** Strength ${n}, **USD ${n}m, actual**. [F2]`),
  "",
  "## Slide 2. Weaknesses and gaps",
  "",
  ...[1, 2, 3, 4, 5].map((n) => `- **W${n}** Weakness ${n}. [F2]`),
  "",
  "## Slide 3. Environment",
  "",
  "| ID and lens | Dated line |",
  "|---|---|",
  ...[1, 2, 3, 4, 5, 6, 7].map((n) => `| **E${n}, economic** | Environment line ${n}. [U1] |`),
  "",
  "## Slide 4. Risks for consultant review",
  "",
  "| ID | Risk | Consultant fields |",
  "|---|---|---|",
  ...[1, 2, 3, 4, 5].map((n) => `| **R${n}** | Risk ${n} [F1] | Likelihood **medium, suggested, judgement** |`),
  "",
  "## Slide 5. Benchmarks, limits and workshop questions",
  "",
  ...[1, 2, 3, 4, 5].map((n) => `- **B${n}** Peer ${n} margin, actual ratio. [P1]`),
  "",
  "**Five workshop questions:** these are open questions, not claims.",
  "",
  "```",
  "- **S9** inside a code block is not a bullet",
  "```",
].join("\n");

function labelled(sourceId: string, extra: Partial<DocumentEvidenceSource> = {}): DocumentEvidenceSource {
  return {
    sourceId,
    locator: "page 1",
    sourceDate: "2026-10-09",
    type: "actual",
    geography: "Ghana",
    freshness: "current",
    ...extra,
  };
}

function rev3Links() {
  return extractEvidenceBullets(PRE_READ).map((bullet) => ({
    bulletId: bullet.bulletId,
    sources: [labelled(bullet.bulletId.startsWith("E") ? "U1" : "F2")],
    inference: bullet.bulletId === "W1",
    judgement: bullet.bulletId.startsWith("R"),
  }));
}

describe("extractEvidenceBullets", () => {
  it("finds list and table bullets by their bold ID, with the slide heading as section", () => {
    const bullets = extractEvidenceBullets(PRE_READ);
    expect(bullets).toHaveLength(27);
    expect(bullets.map((bullet) => bullet.bulletId).slice(0, 6)).toEqual(["S1", "S2", "S3", "S4", "S5", "W1"]);
    const e3 = bullets.find((bullet) => bullet.bulletId === "E3");
    expect(e3).toMatchObject({ section: "Slide 3. Environment", text: "economic | Environment line 3. [U1]" });
    expect(bullets.find((bullet) => bullet.bulletId === "S1")?.text).toBe("Strength 1, USD 1m, actual. [F2]");
    expect(bullets.some((bullet) => bullet.bulletId === "S9")).toBe(false);
  });

  it("ignores list items and rows without a bold ID", () => {
    expect(extractEvidenceBullets("- plain item\n- **Note:** no id\n| **Header** | x |")).toEqual([]);
  });
});

describe("checkDocumentEvidence", () => {
  it("reproduces the GRE-1141 rev 3 count: 27 bullets, 0 no source, 0 label missing, 5 judgement", () => {
    const check = checkDocumentEvidence({ bullets: extractEvidenceBullets(PRE_READ), links: rev3Links(), now: NOW });
    expect(check.totals).toEqual({ bullets: 27, noSource: 0, labelMissing: 0, judgement: 5, ok: 22 });
    expect(check.flagRate).toBe(0);
    expect(check.pass).toBe(true);
    expect(check.bullets.filter((b) => b.category === "judgement").map((b) => b.bulletId)).toEqual([
      "R1", "R2", "R3", "R4", "R5",
    ]);
  });

  it("flags the first-test shape: missing type and geography, old and ended-forecast sources not marked stale", () => {
    const links = rev3Links().map((link) => {
      switch (link.bulletId) {
        case "W1":
          return { ...link, sources: [labelled("F2", { type: null })] };
        case "E3":
          return { ...link, sources: [labelled("W1", { type: "forecast", sourceDate: "2025-08-14", periodEnd: "2025-12-31" })] };
        case "E4":
          return { ...link, sources: [labelled("B1", { type: "estimate", geography: null })] };
        case "E6":
          return { ...link, sources: [labelled("C1", { sourceDate: "2017-04-17" })] };
        default:
          return link.bulletId.startsWith("R")
            ? { ...link, judgement: false, sources: [labelled("F1", { type: null })] }
            : link;
      }
    });
    const check = checkDocumentEvidence({ bullets: extractEvidenceBullets(PRE_READ), links, now: NOW });
    expect(check.totals.labelMissing).toBe(9);
    expect(check.flagRate).toBe(0.333);
    expect(check.pass).toBe(false);
    const reasons = Object.fromEntries(check.bullets.map((b) => [b.bulletId, b.reasons]));
    expect(reasons.E3).toEqual(["W1: forecast period has ended, mark it stale until the actual replaces it"]);
    expect(reasons.E4).toEqual(["B1: geography missing"]);
    expect(reasons.E6).toEqual(["C1: source is older than 18 months, mark it stale"]);
    expect(reasons.W1).toEqual(["F2: type missing (actual, forecast or estimate)"]);
  });

  it("lists bullets with no source, orphaned links and duplicate IDs", () => {
    const bullets = extractEvidenceBullets("## A\n- **S1** one\n- **S2** two\n- **S2** again");
    const check = checkDocumentEvidence({
      bullets,
      links: [
        { bulletId: "S1", sources: [], inference: false, judgement: false },
        { bulletId: "X9", sources: [labelled("F1")], inference: false, judgement: false },
      ],
      now: NOW,
    });
    expect(check.bullets).toEqual([
      { bulletId: "S1", section: "A", category: "no_source", reasons: ["No source linked"] },
      { bulletId: "S2", section: "A", category: "no_source", reasons: ["No source linked"] },
    ]);
    expect(check.orphanedBulletIds).toEqual(["X9"]);
    expect(check.duplicateBulletIds).toEqual(["S2"]);
    expect(check.pass).toBe(false);
  });

  it("accepts an old source once it is marked stale", () => {
    const check = checkDocumentEvidence({
      bullets: extractEvidenceBullets("- **E6** decree"),
      links: [{ bulletId: "E6", sources: [labelled("C1", { sourceDate: "2017-04-17", freshness: "stale" })], inference: false, judgement: false }],
      now: NOW,
    });
    expect(check.bullets[0].category).toBe("ok");
  });
});

describe("buildDocumentEvidenceExport", () => {
  it("gives a footnote per bullet, notes per slide and a source appendix", () => {
    const exported = buildDocumentEvidenceExport({
      issueId: "issue-1",
      documentKey: "pre-read",
      revisionNumber: 3,
      bullets: extractEvidenceBullets(PRE_READ),
      links: rev3Links().filter((link) => link.bulletId !== "B5"),
      now: NOW,
    });
    expect(exported.sections.map((section) => section.section)).toEqual([
      "Slide 1. Strengths",
      "Slide 2. Weaknesses and gaps",
      "Slide 3. Environment",
      "Slide 4. Risks for consultant review",
      "Slide 5. Benchmarks, limits and workshop questions",
    ]);
    const slide2 = exported.sections[1];
    expect(slide2.bullets[0].footnote).toBe("F2, page 1, 2026-10-09, actual, Ghana, current [inference]");
    expect(slide2.notes.split("\n")[0]).toBe("W1: F2, page 1, 2026-10-09, actual, Ghana, current [inference]");
    expect(exported.sections[3].bullets[0].footnote).toContain("[suggested, judgement]");
    expect(exported.sections[4].notes).toContain("B5: NO SOURCE");
    expect(exported.sources.map((source) => [source.sourceId, source.citedBy.length])).toEqual([
      ["F2", 19],
      ["U1", 7],
    ]);
    expect(exported.check.totals.noSource).toBe(1);
    expect(exported.markdown).toContain("| U1 | page 1 | 2026-10-09 | actual | Ghana | current | E1, E2, E3, E4, E5, E6, E7 |");
    expect(exported.markdown).toContain("- **B5** NO SOURCE");
  });

  it("shows the forecast period and leaves missing labels out rather than inventing them", () => {
    expect(
      formatEvidenceFootnote({
        bulletId: "E1",
        sources: [{ sourceId: "U1", type: "forecast", periodEnd: "2026-06-30", sourceDate: "2025-05-01" }],
        inference: false,
        judgement: false,
      }),
    ).toBe("U1, 2025-05-01, forecast, period to 2026-06-30");
  });
});

describe("upsertDocumentEvidenceSchema", () => {
  it("accepts a link with only a source ID and rejects bad IDs, dates and repeats", () => {
    expect(upsertDocumentEvidenceSchema.safeParse({ bullets: [{ bulletId: "S1", sources: [{ sourceId: "F2" }] }] }).success).toBe(true);
    expect(upsertDocumentEvidenceSchema.safeParse({ bullets: [{ bulletId: "slide one", sources: [] }] }).success).toBe(false);
    expect(
      upsertDocumentEvidenceSchema.safeParse({ bullets: [{ bulletId: "S1", sources: [{ sourceId: "F2", sourceDate: "9 Oct" }] }] }).success,
    ).toBe(false);
    expect(
      upsertDocumentEvidenceSchema.safeParse({
        bullets: [
          { bulletId: "S1", sources: [] },
          { bulletId: "S1", sources: [] },
        ],
      }).success,
    ).toBe(false);
  });
});
