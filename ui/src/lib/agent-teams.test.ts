import { describe, expect, it } from "vitest";
import type { AgentTeam } from "@greatstone/shared";
import { filterAgentsByTeam, groupAgentsByTeam, NO_TEAM_FILTER, teamsByAgent } from "./agent-teams";

function team(id: string, name: string, memberAgentIds: string[], leadAgentId: string | null = null): AgentTeam {
  return {
    id,
    companyId: "c",
    name,
    color: "#2563eb",
    description: null,
    leadAgentId,
    memberAgentIds,
    createdAt: "2026-10-02T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
  };
}

const agents = [
  { id: "mason", name: "Mason" },
  { id: "mica", name: "Mica" },
  { id: "ridge", name: "Ridge" },
  { id: "everest", name: "Everest" },
];
const platform = team("t-platform", "Platform", ["mica", "mason"], "mason");
const reliability = team("t-rel", "Reliability", ["ridge", "mason"], "ridge");
const teams = [reliability, platform];

describe("agent teams helpers", () => {
  it("lists each agent's teams by name, including agents in two teams", () => {
    const map = teamsByAgent(teams);
    expect(map.get("mason")?.map((t) => t.name)).toEqual(["Platform", "Reliability"]);
    expect(map.get("everest")).toBeUndefined();
  });

  it("filters by team, by no team, and keeps everyone with no filter", () => {
    expect(filterAgentsByTeam(agents, teams, null).map((a) => a.id)).toEqual(["mason", "mica", "ridge", "everest"]);
    expect(filterAgentsByTeam(agents, teams, "t-platform").map((a) => a.id)).toEqual(["mason", "mica"]);
    expect(filterAgentsByTeam(agents, teams, NO_TEAM_FILTER).map((a) => a.id)).toEqual(["everest"]);
    expect(filterAgentsByTeam(agents, teams, "gone")).toEqual([]);
  });

  it("groups by team with the lead first, then a No team group", () => {
    const groups = groupAgentsByTeam(agents, teams);
    expect(groups.map((g) => [g.team?.name ?? null, g.agents.map((a) => a.id)])).toEqual([
      ["Platform", ["mason", "mica"]],
      ["Reliability", ["ridge", "mason"]],
      [null, ["everest"]],
    ]);
  });

  it("drops teams with no visible members and an empty No team group", () => {
    const groups = groupAgentsByTeam([agents[2]], teams);
    expect(groups.map((g) => g.team?.name ?? null)).toEqual(["Reliability"]);
  });
});
