import { describe, expect, it } from "vitest";
import { buildGsInterviewReleasedSynthesis, deepDiveReleaseReadiness, releaseDeepDiveInterviewSynthesisSchema } from "./deep-dive-interview-release.js";
import type { DeepDiveInterviewProposal } from "./deep-dive-interview-synthesis.js";

function proposal(over: Partial<DeepDiveInterviewProposal>): DeepDiveInterviewProposal {
  return {
    id: "p", roundId: "r", kind: "pain", themeKey: null, parentId: null, label: "", statement: "s", unitId: null, voices: 2,
    firstHandVoices: 1, websiteInsightId: null, websiteEmployeeId: null, anonymous: true, sources: [], status: "proposed",
    visibility: "internal", rulesVersion: "v", decidedByUserId: null, decidedAt: null, createdAt: "2026-10-26T00:00:00Z", ...over,
  };
}

const theme = (id: string, status: DeepDiveInterviewProposal["status"], unitId: string | null = null) =>
  proposal({ id, kind: "pain", themeKey: `pain:${id}`, label: `Theme ${id}`, statement: `About ${id}`, status, unitId });
const quote = (id: string, parentId: string, status: DeepDiveInterviewProposal["status"]) =>
  proposal({ id, kind: "quote", parentId, websiteInsightId: `ins_${id}`, statement: `Quote ${id}`, status });

describe("release readiness (GRE-2667)", () => {
  it("is ready only when every theme and quote is decided and each accepted theme keeps a quote", () => {
    expect(deepDiveReleaseReadiness([]).blockers.map((b) => b.code)).toEqual(["nothing_accepted"]);
    expect(deepDiveReleaseReadiness([theme("t1", "accepted"), quote("q1", "t1", "proposed")]).blockers.map((b) => b.code))
      .toEqual(["undecided", "theme_without_quote"]);
    // A role for the board does not block: it never goes to the client.
    const ready = deepDiveReleaseReadiness([theme("t1", "accepted"), quote("q1", "t1", "accepted"), proposal({ id: "pp", kind: "person" })]);
    expect(ready).toEqual({ ready: true, blockers: [], themes: 1, quotes: 1 });
  });

  it("needs a headline", () => {
    expect(releaseDeepDiveInterviewSynthesisSchema.safeParse({ headline: "  " }).success).toBe(false);
    expect(releaseDeepDiveInterviewSynthesisSchema.safeParse({ headline: "x", status: "released" }).success).toBe(false);
  });
});

describe("the released synthesis", () => {
  it("carries accepted themes and quotes only, with one-team themes as that team's hot spot", () => {
    const body = buildGsInterviewReleasedSynthesis({
      synthesisId: "syn-1",
      headline: "Orders are typed twice.",
      rulesVersion: "rules-1",
      unitNames: new Map([["u1", "Finance"]]),
      proposals: [
        theme("t1", "accepted", "u1"), quote("q1", "t1", "accepted"), quote("q2", "t1", "rejected"),
        theme("t2", "rejected"), quote("q3", "t2", "accepted"),
        theme("t3", "accepted"), quote("q4", "t3", "accepted"),
      ],
    });
    expect(body.themes.map((t) => [t.theme_id, t.evidence_quotes.map((q) => q.insight_id)])).toEqual([["pain:t1", ["ins_q1"]], ["pain:t3", ["ins_q4"]]]);
    expect(body.hotSpots).toEqual([{ team: "Finance", local_themes: [body.themes[0]] }]);
    expect(body).toMatchObject({ schema: "gs-interview-synthesis-v1", synthesisId: "syn-1", rulesVersion: "rules-1",
      headlineRead: { text: "Orders are typed twice.", supporting_insight_ids: ["ins_q1", "ins_q4"] }, inputInsightIds: ["ins_q1", "ins_q4"] });
  });
});
