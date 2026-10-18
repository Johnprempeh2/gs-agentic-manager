import { describe, expect, it } from "vitest";
import { directoryTerms, rankDirectory, type DirectoryAgentInput } from "../services/agent-directory.js";

const agent = (overrides: Partial<DirectoryAgentInput> & { id: string; name: string }): DirectoryAgentInput => ({
  role: "general",
  title: null,
  capabilities: null,
  status: "idle",
  reportsTo: null,
  ...overrides,
});

const agents = [
  agent({ id: "1", name: "Everest", role: "ceo", title: "Chief executive", capabilities: "Plans the week, hires agents" }),
  agent({ id: "2", name: "Ridge", role: "engineer", title: "Head of sales", capabilities: "Outbound email, lead research, SEO audits" }),
  agent({ id: "3", name: "Mason", role: "engineer", title: "Software engineer", capabilities: "Builds the website, fixes bugs" }),
  agent({ id: "4", name: "Quarry", role: "researcher", title: "SEO researcher", capabilities: "Keyword research", status: "paused" }),
  agent({ id: "5", name: "Gone", role: "engineer", capabilities: "SEO", status: "terminated" }),
];

describe("directoryTerms", () => {
  it("drops filler words and repeats", () => {
    expect(directoryTerms("Who can help me with SEO and seo audits?")).toEqual(["seo", "audits"]);
  });
});

describe("rankDirectory", () => {
  it("ranks capability matches first and skips removed agents", () => {
    const result = rankDirectory(agents, "SEO audits");
    expect(result.map((entry) => entry.name)).toEqual(["Ridge", "Quarry"]);
    expect(result[0]!.matched).toEqual(["seo", "audits"]);
  });

  it("puts a paused agent after a working one with the same score", () => {
    const list = [
      agent({ id: "a", name: "Alpha", capabilities: "research", status: "paused" }),
      agent({ id: "b", name: "Beta", capabilities: "research" }),
    ];
    expect(rankDirectory(list, "research").map((entry) => entry.name)).toEqual(["Beta", "Alpha"]);
  });

  it("lists every live agent by name with no query, up to the limit", () => {
    expect(rankDirectory(agents, "").map((entry) => entry.name)).toEqual(["Everest", "Mason", "Ridge", "Quarry"]);
    expect(rankDirectory(agents, "", 2)).toHaveLength(2);
  });
});
