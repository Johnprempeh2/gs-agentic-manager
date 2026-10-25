import { describe, expect, it } from "vitest";
import { DEEP_DIVE_GIF, DEEP_DIVE_STREAMS } from "./deep-dive.js";
import {
  deepDiveInterviewContextPackSchema,
  deepDiveInterviewQuestionSchema,
  deepDiveInterviewReadiness,
  draftDeepDiveInterviewSet,
  readDeepDiveInterviewContextPack,
  type DeepDiveInterviewCell,
  type DeepDiveInterviewTarget,
} from "./deep-dive-interviews.js";

const team: DeepDiveInterviewTarget = { kind: "unit", id: "u1", name: "Finance", detail: "Team" };

function allCells(overrides: (cell: DeepDiveInterviewCell) => Partial<DeepDiveInterviewCell> = () => ({})) {
  return DEEP_DIVE_STREAMS.flatMap((stream) =>
    DEEP_DIVE_GIF.map((gif) => {
      const cell: DeepDiveInterviewCell = {
        streamKey: stream.key,
        gifKey: gif.key,
        depth: "full",
        knowledge: "unknown",
        cellText: null,
        findings: [],
      };
      return { ...cell, ...overrides(cell) };
    }),
  );
}

describe("draftDeepDiveInterviewSet (GRE-2611)", () => {
  it("never asks a Known cell, and places it for the interviewer instead", () => {
    const cells = allCells((cell) =>
      cell.streamKey === "operations" && cell.gifKey === "current-state"
        ? { knowledge: "known", cellText: "# Current state\n\nOrders are keyed by hand into Sage." }
        : { knowledge: "known" },
    );
    const draft = draftDeepDiveInterviewSet({ cells, target: team, targetMinutes: 20 });
    expect(draft.questions).toEqual([]);
    expect(draft.known).toContainEqual({ streamKey: "operations", gifKey: "current-state", text: "Orders are keyed by hand into Sage." });
    expect(draft.known).toHaveLength(45);
  });

  it("validates Indicated cells first, quoting what we believe, then investigates Unknown ones", () => {
    const cells = allCells((cell) =>
      cell.streamKey === "operations" && cell.gifKey === "business-impact"
        ? { knowledge: "indicated", findings: [{ statement: "Month-end close takes nine days.", status: "proposed" }] }
        : {},
    );
    const draft = draftDeepDiveInterviewSet({ cells, target: team, targetMinutes: 20 });
    expect(draft.questions[0]).toEqual({
      prompt: "We understand that month-end close takes nine days. Is that right for your team? What would you add or correct?",
      purpose: "validate",
      streamKey: "operations",
      gifKey: "business-impact",
    });
    expect(draft.questions.slice(1).every((q) => q.purpose === "investigate")).toBe(true);
  });

  it("keeps near the target length and counts what it left out", () => {
    const draft = draftDeepDiveInterviewSet({ cells: allCells(), target: team, targetMinutes: 20 });
    expect(draft.questions).toHaveLength(10);
    expect(draft.leftOut).toBe(35);
    // Current state across the streams comes first, in Book V order.
    expect(draft.questions.slice(0, 9).map((q) => [q.streamKey, q.gifKey])).toEqual(
      DEEP_DIVE_STREAMS.map((stream) => [stream.key, "current-state"]),
    );
    expect(draft.questions[0]!.prompt).toBe("How does leadership work today in your team? Walk us through a normal week.");
  });

  it("asks about Full streams before Reduced ones, and speaks to a person's role", () => {
    const cells = allCells((cell) => (cell.streamKey === "leadership" ? { depth: "reduced" } : {}));
    const person: DeepDiveInterviewTarget = { kind: "person", id: "p1", name: "Ama", detail: "Finance lead" };
    const draft = draftDeepDiveInterviewSet({ cells, target: person, targetMinutes: 10 });
    expect(draft.questions).toHaveLength(5);
    expect(draft.questions.some((q) => q.streamKey === "leadership")).toBe(false);
    expect(draft.questions[0]!.prompt).toContain("your role");
  });
});

describe("Parallel Interview contract (GRE-2611)", () => {
  it("takes only Everest's context keys", () => {
    expect(deepDiveInterviewContextPackSchema.safeParse({ company_background: "A haulier", do_not_discuss: "Pay" }).success).toBe(true);
    expect(deepDiveInterviewContextPackSchema.safeParse({ secret_notes: "x" }).success).toBe(false);
    expect(readDeepDiveInterviewContextPack({ scope: "Revenue", other: "x", systems: 4 })).toEqual({ scope: "Revenue" });
  });

  it("names a question's stream and GIF question together or not at all", () => {
    expect(deepDiveInterviewQuestionSchema.safeParse({ prompt: "Anything else?", purpose: "investigate", streamKey: null, gifKey: null }).success).toBe(true);
    expect(deepDiveInterviewQuestionSchema.safeParse({ prompt: "Hm", purpose: "validate", streamKey: "data", gifKey: null }).success).toBe(false);
  });

  it("is ready to invite only when a person approved every set", () => {
    expect(deepDiveInterviewReadiness({ sets: [] }).ready).toBe(false);
    const sets = [{ status: "approved" }, { status: "draft" }] as Parameters<typeof deepDiveInterviewReadiness>[0]["sets"];
    expect(deepDiveInterviewReadiness({ sets })).toEqual({ total: 2, approved: 1, ready: false });
  });
});
