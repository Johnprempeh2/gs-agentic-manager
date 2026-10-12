import { describe, expect, it } from "vitest";
import { kestrelAgents, kestrelNodes } from "../../fixtures/memoryKestrel";
import {
  contributorFocusKey,
  findCeoAgentId,
  formatAgentFocus,
  listContributors,
  parseAgentFocus,
  type MemoryAgentInfo,
} from "./memoryContributors";

const agents: MemoryAgentInfo[] = [
  { id: "ag-mason-syn", name: "Mason", role: "engineer" },
  { id: "ag-scribe-syn", name: "Scribe", role: "general" },
  { id: "ag-chief", name: "Harbor", role: "ceo" },
  { id: "ag-everest-syn", name: "Everest", role: "general" },
];

describe("findCeoAgentId", () => {
  it("uses the ceo role, never the name, when roles are known", () => {
    expect(findCeoAgentId(agents)).toBe("ag-chief");
    expect(findCeoAgentId(agents.filter((agent) => agent.role !== "ceo"))).toBeNull();
  });

  it("falls back to the name only when no agent has a role", () => {
    const noRoles = agents.map(({ role: _role, ...agent }) => agent);
    expect(findCeoAgentId(noRoles)).toBe("ag-everest-syn");
    expect(findCeoAgentId(noRoles.map((agent) => ({ ...agent, role: null })))).toBe("ag-everest-syn");
  });

  it("falls back to a contributor's name when the agent list is empty", () => {
    expect(findCeoAgentId([], kestrelNodes.map((node) => node.contributor))).toBe("ag-everest-syn");
    expect(findCeoAgentId([], [kestrelAgents.mason])).toBeNull();
  });
});

describe("listContributors", () => {
  it("counts entries per contributor, the main agent first, then by count", () => {
    const rows = listContributors(kestrelNodes, [{ id: "ag-everest-syn", name: "Everest", role: "ceo", appearance: null }]);

    expect(rows.map((row) => [row.key, row.count, row.isCeo])).toEqual([
      ["ag-everest-syn", 1, true],
      ["ag-mason-syn", 2, false],
      ["ag-scribe-syn", 2, false],
    ]);
    expect(rows[0].name).toBe("Everest");
    expect(rows[0].agent?.id).toBe("ag-everest-syn");
    // Not in the agent list: the name from the graph data, and no agent details.
    expect(rows[1].name).toBe("Mason (synthetic)");
    expect(rows[1].agent).toBeNull();
  });

  it("keys people and checks so they cannot clash with agent ids", () => {
    expect(contributorFocusKey(kestrelAgents.everest)).toBe("ag-everest-syn");
    expect(contributorFocusKey(kestrelAgents.john)).toBe("user:hu-john-syn");
    expect(contributorFocusKey(kestrelAgents.check)).toBe("system");
  });
});

describe("agent focus in the URL", () => {
  it("reads and writes a comma separated list", () => {
    expect(parseAgentFocus(null)).toEqual([]);
    expect(parseAgentFocus("a, b,,a")).toEqual(["a", "b"]);
    expect(formatAgentFocus([])).toBeUndefined();
    expect(formatAgentFocus(["a", "b"])).toBe("a,b");
  });
});
