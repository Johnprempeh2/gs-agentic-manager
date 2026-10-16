import { describe, expect, it } from "vitest";
import type { DailyPulseSections } from "@greatstone/shared";
import { pulseText } from "./pulse-text";

describe("pulseText", () => {
  it("writes the headline, quick win and each non-empty section with links", () => {
    const sections = {
      quickWin: { title: "Try the new model", timeNeeded: "10 minutes", action: "Open the playground.", outcome: "Faster drafts.", url: "https://example.com/q" },
      weekInReview: null,
      trends: [{ headline: "Agents go mainstream", sourceName: "The Verge", whyItMatters: "Clients will ask.", url: "https://example.com/t" }],
      tools: [],
      skillIdeas: [],
      creators: [],
      opportunities: [{ title: "Agent audit offer", nextStep: "Draft a one pager." }],
    } as unknown as DailyPulseSections;
    expect(pulseText({ sections, headline: "A busy day for agents.", reportDate: "2026-10-16" }).split("\n")).toEqual([
      "Daily Pulse, 16 Oct 2026",
      "A busy day for agents.",
      "",
      "Quick win (10 minutes): Try the new model",
      "Open the playground.",
      "Faster drafts.",
      "https://example.com/q",
      "",
      "AI industry trends",
      "• Agents go mainstream (The Verge): Clients will ask. https://example.com/t",
      "",
      "Greatstone opportunities",
      "• Agent audit offer: Draft a one pager.",
    ]);
  });
});
