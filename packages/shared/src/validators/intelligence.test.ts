import { describe, expect, it } from "vitest";
import {
  computeBoardMovement,
  pickComparisonSnapshotDate,
  upsertBoardSnapshotSchema,
  upsertIntelligenceReportSchema,
} from "./intelligence.js";

const tool = {
  name: "Cline",
  url: "https://github.com/cline/cline",
  what: "Open-source coding agent for the IDE and CLI.",
  category: "ai_coding",
  pricing: "Free",
  personalRating: 4,
  clientRating: 5,
  flaggedBy: "GitHub",
  quickTake: "Open, bring your own key, MCP ready.",
};

const pulse = {
  kind: "daily_pulse",
  status: "published",
  headline: "Meta ships Muse Wonder",
  sections: {
    quickWin: { title: "Try Cline", action: "Install Cline and run one task.", timeNeeded: "20 minutes", outcome: "A first-hand view." },
    tools: [tool],
  },
};

const news = {
  headline: "Meta releases Muse Wonder",
  tag: "Meta · Models",
  date: "2026-10-12",
  sourceName: "TechCrunch",
  url: "https://techcrunch.com/2026/10/12/meta-releases-its-first-frontier-model-muse-wonder/",
  verdict: "Meta now has a model near the leaders, at leader prices.",
  points: ["Scores 52 on the Artificial Analysis index."],
  action: "Run Muse Wonder against Sonnet on 20 client tasks.",
};

describe("intelligence validators", () => {
  it("accepts a well-formed Daily Pulse and fills defaults", () => {
    const parsed = upsertIntelligenceReportSchema.parse(pulse);
    expect(parsed.kind).toBe("daily_pulse");
    if (parsed.kind === "daily_pulse") {
      expect(parsed.sections.trends).toEqual([]);
      expect(parsed.sections.tools[0]!.learnMore).toEqual([]);
    }
  });

  it("refuses a tool without a source url, or with an http one", () => {
    const { url: _url, ...noUrl } = tool;
    const missing = upsertIntelligenceReportSchema.safeParse({ ...pulse, sections: { ...pulse.sections, tools: [noUrl] } });
    expect(missing.success).toBe(false);
    expect(missing.error!.issues[0]!.path).toEqual(["sections", "tools", 0, "url"]);

    const http = upsertIntelligenceReportSchema.safeParse({
      ...pulse,
      sections: { ...pulse.sections, tools: [{ ...tool, url: "http://example.com" }] },
    });
    expect(http.success).toBe(false);
    expect(http.error!.issues[0]!.message).toMatch(/https URL/);
  });

  it("refuses news without a url, unknown keys, overlong card text and a bad kind", () => {
    const briefing = (item: Record<string, unknown>) =>
      upsertIntelligenceReportSchema.safeParse({ kind: "ai_briefing", sections: { news: [item] } });
    expect(briefing(news).success).toBe(true);
    const { url: _url, ...noUrl } = news;
    expect(briefing(noUrl).success).toBe(false);
    expect(briefing({ ...news, extra: "x" }).success).toBe(false);
    expect(briefing({ ...news, verdict: "word ".repeat(41) }).success).toBe(false);
    expect(briefing({ ...news, points: [] }).success).toBe(false);
    expect(upsertIntelligenceReportSchema.safeParse({ ...pulse, kind: "weekly" }).success).toBe(false);
    expect(upsertIntelligenceReportSchema.safeParse({ ...pulse, sections: {} }).success).toBe(false);
  });

  it("refuses an opportunity with no sources and a board with duplicate names", () => {
    const opportunity = { title: "MCP audits", triggeredBy: "MCP adoption", targetClients: "Banks", revenuePotential: "high", nextStep: "Draft a one-pager", sources: [] };
    expect(upsertIntelligenceReportSchema.safeParse({ ...pulse, sections: { ...pulse.sections, opportunities: [opportunity] } }).success).toBe(false);
    expect(
      upsertBoardSnapshotSchema.safeParse({ entries: [{ name: "Claude", rank: 1, score: 97 }, { name: "claude", rank: 2, score: 96 }] }).success,
    ).toBe(false);
  });
});

describe("board movement", () => {
  it("measures rank and score change, new entries, and no comparison", () => {
    const now = [
      { name: "Claude", rank: 1, score: 97.3 },
      { name: "Gemini", rank: 2, score: 96.6 },
      { name: "Kimi", rank: 3, score: 72.3 },
    ];
    const before = [
      { name: "Gemini", rank: 1, score: 95.5 },
      { name: "Claude", rank: 2, score: 94.6 },
    ];
    expect(computeBoardMovement(now, before)).toEqual([
      { rankDelta: 1, scoreDelta: 2.7, isNew: false },
      { rankDelta: -1, scoreDelta: 1.1, isNew: false },
      { rankDelta: null, scoreDelta: null, isNew: true },
    ]);
    expect(computeBoardMovement(now, null)[0]).toEqual({ rankDelta: null, scoreDelta: null, isNew: false });
  });

  it("compares week over week, or with the earliest snapshot while history is short", () => {
    const dates = ["2026-10-01", "2026-10-05", "2026-10-06", "2026-10-12"];
    expect(pickComparisonSnapshotDate(dates, "2026-10-13")).toBe("2026-10-06");
    expect(pickComparisonSnapshotDate(["2026-10-12"], "2026-10-13")).toBe("2026-10-12");
    expect(pickComparisonSnapshotDate(["2026-10-14"], "2026-10-13")).toBeNull();
  });
});
