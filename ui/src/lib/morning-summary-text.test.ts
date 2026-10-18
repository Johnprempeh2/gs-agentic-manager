import { describe, expect, it } from "vitest";
import type { MorningSummary } from "@greatstone/shared";
import { morningSummarySpeech, morningSummaryText } from "./morning-summary-text";

describe("morningSummaryText", () => {
  it("writes each section with counts, late items and what is left over", () => {
    const text = morningSummaryText(
      {
        needsYou: { count: 3, items: [{ id: "1", identifier: "GRE-12", title: "Approve the hire" }] },
        dueToday: { count: 1, items: [{ id: "2", identifier: null, title: "Send the deck", dueDate: "2026-10-14" }] },
        finished: { count: 0, items: [] },
        stuck: { count: 0, items: [] },
      },
      "2026-10-16",
    );
    expect(text.split("\n")).toEqual([
      "Today, 16 Oct",
      "",
      "Needs me (3)",
      "• GRE-12 Approve the hire",
      "• and 2 more",
      "",
      "Due today (1)",
      "• Send the deck, late, due 14 Oct",
      "",
      "Finished since yesterday: nothing yet",
      "",
      "Stuck: nothing",
    ]);
  });
});

describe("morningSummarySpeech", () => {
  const base: MorningSummary = {
    companyId: "c",
    generatedAt: "",
    since: "",
    needsYou: { count: 3, items: [{ id: "a", identifier: "GRE-1", title: "Approve the brief" }, { id: "b", identifier: "GRE-2", title: "Pick a date" }] },
    dueToday: { count: 1, items: [{ id: "c", identifier: "GRE-3", title: "Send the invoice", dueDate: "2026-10-14" }] },
    finished: { count: 1, items: [{ id: "d", identifier: "GRE-4", title: "Write the one-pager" }] },
    stuck: { count: 0, items: [] },
    deals: { won: 1, lost: 1, items: [{ id: "e", pipelineId: "p", title: "Indago rollout", outcome: "won" }, { id: "f", pipelineId: "p", title: "Acme", outcome: "lost" }] },
  };

  it("reads the day section by section, without task numbers", () => {
    expect(morningSummarySpeech(base, "2026-10-16", "Good morning")).toEqual([
      "Good morning. 3 things need you.",
      "Needs you: Approve the brief, Pick a date and 1 more.",
      "Due today: Send the invoice, which is late.",
      "1 task finished since yesterday: Write the one-pager.",
      "1 deal won and 1 deal lost since yesterday. Won: Indago rollout.",
      "Nothing is stuck.",
    ]);
  });

  it("keeps a quiet day short", () => {
    const quiet = { ...base, needsYou: { count: 0, items: [] }, dueToday: { count: 0, items: [] }, finished: { count: 0, items: [] }, deals: undefined };
    expect(morningSummarySpeech(quiet, "2026-10-16", "Good evening")).toEqual([
      "Good evening. Nothing needs you right now.",
      "No tasks finished since yesterday.",
      "Nothing is stuck.",
    ]);
  });
});
