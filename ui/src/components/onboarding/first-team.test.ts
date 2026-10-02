import { describe, expect, it } from "vitest";
import type { CatalogTeam } from "@greatstone/shared";
import {
  firstTeamCandidates,
  firstTeamIndustries,
  groupFirstTeams,
  humanizeCatalogValue,
} from "./first-team";

function team(overrides: Partial<CatalogTeam> & Pick<CatalogTeam, "id" | "name" | "category">): CatalogTeam {
  return {
    key: overrides.id,
    kind: "optional",
    slug: overrides.id,
    description: "",
    path: `catalog/optional/${overrides.category}/${overrides.id}`,
    entrypoint: "TEAM.md",
    schema: "agentcompanies/v1",
    defaultInstall: false,
    recommendedForCompanyTypes: [],
    tags: ["greatstone"],
    counts: { agents: 3, projects: 1, tasks: 1, routines: 2, localSkills: 1, catalogSkills: 0, externalSkillSources: 0 },
    rootAgentSlugs: [],
    agentSlugs: [],
    projectSlugs: [],
    requiredSkills: [],
    envInputs: [],
    sourceRefs: [],
    files: [],
    trustLevel: "markdown_only",
    compatibility: "compatible",
    contentHash: "sha256:x",
    ...overrides,
  } as CatalogTeam;
}

const marketing = team({ id: "marketing", name: "Marketing Content Team", category: "marketing", recommendedForCompanyTypes: ["small-business", "marketing"] });
const assistant = team({ id: "assistant", name: "Executive Assistant", category: "operations", recommendedForCompanyTypes: ["small-business", "services"] });
const research = team({ id: "research", name: "Research and Reporting Team", category: "research", recommendedForCompanyTypes: ["consultancy"] });
const contentMachine = team({ id: "content-machine", name: "Content Machine", category: "content", tags: ["content"] });
const engineering = team({ id: "engineering", name: "Product Engineering", category: "software-development", kind: "bundled", tags: ["engineering"] });

describe("firstTeamCandidates", () => {
  it("offers only Greatstone teams that can be installed safely", () => {
    const scripted = team({ id: "scripted", name: "Scripted", category: "ops", trustLevel: "scripts_executables" });
    const invalid = team({ id: "invalid", name: "Invalid", category: "ops", compatibility: "invalid" });

    const ids = firstTeamCandidates([marketing, contentMachine, engineering, scripted, invalid, research]).map((t) => t.id);

    expect(ids).toEqual(["marketing", "research"]);
  });
});

describe("groupFirstTeams", () => {
  it("groups by department in name order when no industry is chosen", () => {
    const groups = groupFirstTeams([research, marketing, assistant], null);

    expect(groups.map((group) => group.label)).toEqual(["Marketing", "Operations", "Research"]);
    expect(groups[0]!.teams.map((t) => t.id)).toEqual(["marketing"]);
  });

  it("puts departments with a team for the chosen industry first", () => {
    const groups = groupFirstTeams([marketing, assistant, research], "consultancy");

    expect(groups.map((group) => group.category)).toEqual(["research", "marketing", "operations"]);
  });

  it("puts the matching teams first inside a department", () => {
    const generalist = team({ id: "ops-a", name: "Alpha Ops", category: "operations", recommendedForCompanyTypes: ["generalist"] });
    const groups = groupFirstTeams([generalist, assistant], "services");

    expect(groups[0]!.teams.map((t) => t.id)).toEqual(["assistant", "ops-a"]);
  });
});

describe("firstTeamIndustries", () => {
  it("lists each industry once, sorted", () => {
    expect(firstTeamIndustries([marketing, assistant, research])).toEqual([
      "consultancy",
      "marketing",
      "services",
      "small-business",
    ]);
  });
});

describe("humanizeCatalogValue", () => {
  it("turns a slug into a label", () => {
    expect(humanizeCatalogValue("small-business")).toBe("Small business");
    expect(humanizeCatalogValue("software-development")).toBe("Software development");
  });
});
