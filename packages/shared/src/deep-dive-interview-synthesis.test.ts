import { describe, expect, it } from "vitest";
import {
  buildDeepDiveSynthesisEvidence,
  checkDeepDiveSynthesis,
  gsInterviewDetailSchema,
  gsInterviewInsightSchema,
  labelsMatch,
  mergeLabels,
  quoteGate,
  rollUpByUnit,
  submitDeepDiveSynthesisSchema,
  synthesisKindOf,
  twoVoiceRule,
  type GsInterviewDetail,
  type GsInterviewInsight,
} from "./deep-dive-interview-synthesis.js";

const consented = { participation: true, attribution: true };

function insight(id: string, label: string, extra: Partial<GsInterviewInsight> = {}): GsInterviewInsight {
  return gsInterviewInsightSchema.parse({ id, type: "pain_point", label, evidenceQuote: `We spend hours on ${label.toLowerCase()} every week.`, quoteEligible: true, attributionRedacted: false, ...extra });
}

function interview(id: string, voiceKey: string, unitId: string | null, insights: GsInterviewInsight[], consent = consented): GsInterviewDetail {
  return {
    interview: { interviewId: id, employeeId: `emp_${id}`, userId: `usr_${id}`, voiceKey, unitId, roleTitle: "Clerk", complete: true, partial: false, fingerprint: "f" },
    consent,
    insights,
  };
}

describe("rule 1: two voices", () => {
  it("does not promote a pain from one voice, even said twice", () => {
    expect(twoVoiceRule([{ voiceKey: "v1", secondHand: false }, { voiceKey: "v1", secondHand: false }])).toEqual({
      promoted: false, voices: 1, firstHand: 1, reason: "Only one person raised it",
    });
  });

  it("promotes two voices when one saw it first-hand", () => {
    expect(twoVoiceRule([{ voiceKey: "v1", secondHand: true }, { voiceKey: "v2", secondHand: false }])).toMatchObject({ promoted: true, voices: 2, firstHand: 1 });
  });

  it("does not promote two voices who only heard about it", () => {
    expect(twoVoiceRule([{ voiceKey: "v1", secondHand: true }, { voiceKey: "v2", secondHand: true }])).toMatchObject({
      promoted: false, reason: "Nobody who raised it saw it first-hand",
    });
  });
});

describe("rule 2: the quote gate", () => {
  const source = { quoteEligible: true, evidenceQuote: "Honestly, we re-key every order into SAP by hand.", attributionRedacted: false };

  it("refuses a quote when the person did not consent to take part", () => {
    expect(quoteGate({ quote: "we re-key every order into SAP", insight: source, consent: { participation: false, attribution: true } }))
      .toEqual({ ok: false, reason: "no_consent" });
  });

  it("refuses an insight the website did not mark quotable", () => {
    expect(quoteGate({ quote: "we re-key every order", insight: { ...source, quoteEligible: false }, consent: consented }))
      .toEqual({ ok: false, reason: "not_quote_eligible" });
  });

  it("refuses words the person did not say", () => {
    expect(quoteGate({ quote: "we re-key every invoice into SAP", insight: source, consent: consented })).toEqual({ ok: false, reason: "not_verbatim" });
  });

  it("allows a verbatim quote, ignoring spacing and curly quotes, and keeps it anonymous without attribution consent", () => {
    expect(quoteGate({ quote: "“we  re-key every order”", insight: source, consent: consented })).toEqual({ ok: true, quote: "we re-key every order", anonymous: false });
    expect(quoteGate({ quote: "we re-key every order", insight: source, consent: { participation: true, attribution: false } }))
      .toMatchObject({ ok: true, anonymous: true });
    expect(quoteGate({ quote: "we re-key every order", insight: { ...source, attributionRedacted: true }, consent: consented }))
      .toMatchObject({ ok: true, anonymous: true });
  });

  it("reads missing or unclear consent and flags as no", () => {
    const detail = gsInterviewDetailSchema.parse({ interview: { interviewId: "i1", voiceKey: "v1" }, consent: { participation: "maybe" }, turns: [{ content: "raw" }] });
    expect(detail.consent).toEqual({ participation: false, attribution: false });
    // The raw answers are dropped when the bridge answer is read.
    expect(detail).not.toHaveProperty("turns");
    expect(gsInterviewInsightSchema.parse({ id: "x1", label: "Late approvals" })).toMatchObject({ quoteEligible: false, attributionRedacted: true });
  });
});

describe("rule 3: near-duplicate labels merge", () => {
  it("merges plurals, hyphens, small words and typos", () => {
    expect(labelsMatch("Manual invoice matching", "manual invoices matching")).toBe(true);
    expect(labelsMatch("Re-keying orders into SAP", "Rekeying orders in SAP")).toBe(true);
    expect(labelsMatch("Invoice approval delays", "Invoice approvel delays")).toBe(true);
  });

  it("keeps different things apart", () => {
    expect(labelsMatch("Manual invoice matching", "Manual stock counts")).toBe(false);
    expect(labelsMatch("Month-end close takes too long", "Payroll errors")).toBe(false);
  });

  it("names the group by the label most people used, whatever the order", () => {
    const items = [{ label: "Manual invoice matching" }, { label: "manual invoices matching" }, { label: "Manual invoice matching" }, { label: "Stock counts" }];
    const forward = mergeLabels(items);
    const backward = mergeLabels([...items].reverse());
    expect(forward.map((g) => [g.label, g.items.length])).toEqual([["Manual invoice matching", 3], ["Stock counts", 1]]);
    expect(backward.map((g) => [g.label, g.items.length])).toEqual(forward.map((g) => [g.label, g.items.length]));
    expect(forward[0]!.labels).toEqual(["Manual invoice matching", "manual invoices matching"]);
  });
});

describe("rule 4: roll-up by team", () => {
  const units = [
    { id: "co", parentId: null, name: "Northwind" },
    { id: "fin", parentId: "co", name: "Finance" },
    { id: "ap", parentId: "fin", name: "Payables" },
    { id: "depot", parentId: "co", name: "Depot" },
  ];

  it("counts a theme in each team and again at every level above it", () => {
    const nodes = rollUpByUnit(units, [
      { key: "pain:slow-close", voices: [{ voiceKey: "a", secondHand: false, unitId: "ap" }, { voiceKey: "b", secondHand: false, unitId: "depot" }] },
    ]);
    expect(nodes.map((n) => [n.name, n.depth])).toEqual([["Northwind", 0], ["Finance", 1], ["Payables", 2], ["Depot", 1]]);
    const at = (name: string) => nodes.find((n) => n.name === name)!.themes[0];
    // One voice in each team: a candidate there, promoted where the teams meet.
    expect(at("Payables")).toMatchObject({ voices: 1, promoted: false });
    expect(at("Finance")).toMatchObject({ voices: 1, promoted: false });
    expect(at("Depot")).toMatchObject({ voices: 1, promoted: false });
    expect(at("Northwind")).toMatchObject({ voices: 2, promoted: true });
  });

  it("puts people not placed in a team under No team, and survives a broken parent", () => {
    const nodes = rollUpByUnit([...units, { id: "lost", parentId: "gone", name: "Lost" }], [
      { key: "k", voices: [{ voiceKey: "a", secondHand: false, unitId: null }, { voiceKey: "b", secondHand: false, unitId: "lost" }] },
    ]);
    expect(nodes.find((n) => n.unitId === null)).toMatchObject({ name: "No team", themes: [{ key: "k", voices: 1 }] });
    expect(nodes.find((n) => n.unitId === "lost")).toMatchObject({ depth: 0, themes: [{ voices: 1 }] });
  });
});

describe("evidence and the agent's submission", () => {
  const interviews = [
    interview("i1", "v1", "fin", [insight("a1", "Manual invoice matching"), insight("a2", "Payroll errors")]),
    interview("i2", "v2", "fin", [insight("b1", "manual invoices matching", { secondHand: true })]),
    interview("i3", "v3", "fin", [insight("c1", "Manual invoice matching")], { participation: false, attribution: false }),
    interview("i4", "v4", "depot", [insight("d1", "Route planning", { type: "process" }), insight("d2", "Route planning by hand", { type: "workflow" })]),
  ];
  const units = [{ id: "fin", parentId: null, name: "Finance" }, { id: "depot", parentId: null, name: "Depot" }];
  const evidence = buildDeepDiveSynthesisEvidence("round-1", interviews, units);

  it("leaves out interviews without consent and applies every rule", () => {
    expect(evidence).toMatchObject({ interviews: 4, withoutConsent: 1 });
    expect(evidence.people.map((p) => p.interviewId)).toEqual(["i1", "i2", "i4"]);
    const matching = evidence.themes.find((t) => t.label === "Manual invoice matching")!;
    expect(matching).toMatchObject({ kind: "pain", voices: 2, firstHand: 1, promoted: true, unitIds: ["fin"] });
    expect(evidence.themes.find((t) => t.label === "Payroll errors")).toMatchObject({ promoted: false, reason: "Only one person raised it" });
    // One person saying it twice is still one voice.
    expect(evidence.themes.find((t) => t.kind === "process")).toMatchObject({ voices: 1, promoted: false });
    expect(synthesisKindOf("frustration")).toBe("pain");
    expect(synthesisKindOf("handoff")).toBe("process");
    expect(synthesisKindOf("opportunity")).toBe("finding");
  });

  it("refuses the whole submission when a one-voice pain or an unconsented quote is in it", () => {
    const matching = evidence.themes.find((t) => t.label === "Manual invoice matching")!;
    const payroll = evidence.themes.find((t) => t.label === "Payroll errors")!;
    const result = checkDeepDiveSynthesis(evidence, interviews, submitDeepDiveSynthesisSchema.parse({
      items: [
        { themeKey: matching.key, statement: "Finance matches invoices by hand.", quotes: [{ insightId: "a1", quote: "We spend hours on manual invoice matching" }, { insightId: "c1", quote: "manual invoice matching" }] },
        { themeKey: payroll.key, statement: "Payroll has errors." },
      ],
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals).toEqual([
      { item: 0, themeKey: matching.key, quote: 1, reason: "The insight is not part of this theme" },
      { item: 1, themeKey: payroll.key, quote: null, reason: "Not promoted: Only one person raised it" },
    ]);
  });

  it("accepts a promoted theme with a verbatim, consented quote", () => {
    const matching = evidence.themes.find((t) => t.label === "Manual invoice matching")!;
    const result = checkDeepDiveSynthesis(evidence, interviews, submitDeepDiveSynthesisSchema.parse({
      items: [{ themeKey: matching.key, statement: "Finance matches invoices by hand.", quotes: [{ insightId: "a1", quote: "We spend hours on manual invoice matching" }] }],
    }));
    expect(result).toMatchObject({ ok: true, items: [{ statement: "Finance matches invoices by hand.", quotes: [{ quote: "We spend hours on manual invoice matching", anonymous: false }] }] });
  });
});
