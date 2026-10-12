import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { catalogManifest, catalogTeams, resolveCatalogTeamRef } from "./index.js";
import { asBoolean, asString, parseFrontmatterMarkdown } from "./frontmatter.js";
import type { CatalogTeam } from "./types.js";

const EXPECTED_BUNDLED_KEYS = [
  "paperclipai/bundled/company-defaults/core-exec-team",
  "paperclipai/bundled/product/product-design",
  "paperclipai/bundled/software-development/product-engineering",
];

const EXPECTED_OPTIONAL_KEYS = [
  "paperclipai/optional/content/content-machine",
  "paperclipai/optional/marketing/marketing-content",
  "paperclipai/optional/operations/executive-assistant",
  "paperclipai/optional/operations/operations-team",
  "paperclipai/optional/research/research-and-reporting",
];

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("shipped teams catalog", () => {
  it("ships the expected bundled and optional team fixtures", () => {
    const bundledKeys = catalogTeams
      .filter((team) => team.kind === "bundled")
      .map((team) => team.key)
      .sort();
    const optionalKeys = catalogTeams
      .filter((team) => team.kind === "optional")
      .map((team) => team.key)
      .sort();

    expect(bundledKeys).toEqual(EXPECTED_BUNDLED_KEYS);
    expect(optionalKeys).toEqual(EXPECTED_OPTIONAL_KEYS);
  });

  it("keeps every shipped team free of executable scripts and external sources in Phase B", () => {
    const risky = catalogTeams.filter(
      (team) => team.trustLevel === "scripts_executables" || team.trustLevel === "external_sources",
    );
    expect(risky, formatViolations("script-bearing or external-source teams require later security review", risky)).toEqual([]);
  });

  it("populates browse/search-relevant fields for every shipped team", () => {
    const issues: string[] = [];
    for (const team of catalogTeams) {
      if (team.compatibility !== "compatible") {
        issues.push(`${team.key} compatibility=${team.compatibility}`);
      }
      if (!team.description || team.description.length < 40) {
        issues.push(`${team.key} description must be at least 40 characters for catalog browse/search`);
      }
      if (team.recommendedForCompanyTypes.length === 0) {
        issues.push(`${team.key} must list recommendedForCompanyTypes`);
      }
      if (team.tags.length === 0) {
        issues.push(`${team.key} must list tags`);
      }
      if (team.rootAgentSlugs.length === 0) {
        issues.push(`${team.key} must list a root agent slug`);
      }
    }
    expect(issues).toEqual([]);
  });

  it("ships every Greatstone team with a department, industries, a starter task and paused routines (GRE-434)", () => {
    const greatstone = catalogTeams.filter((team) => team.tags.includes("greatstone"));
    expect(greatstone.map((team) => team.slug).sort()).toEqual([
      "executive-assistant",
      "marketing-content",
      "operations-team",
      "research-and-reporting",
    ]);

    const issues: string[] = [];
    for (const team of greatstone) {
      if (!team.category) issues.push(`${team.key} must set a category`);
      if (team.recommendedForCompanyTypes.length === 0) issues.push(`${team.key} must list recommendedForCompanyTypes`);
      if (team.counts.tasks < 1 || team.counts.tasks > 2) issues.push(`${team.key} must ship one or two starter tasks`);

      const sidecarPath = path.join(PACKAGE_DIR, team.path, ".paperclip.yaml");
      const sidecar = fs.existsSync(sidecarPath) ? fs.readFileSync(sidecarPath, "utf8") : "";
      const routineCount = (sidecar.match(/^ {4}status: paused$/gm) ?? []).length;
      if (routineCount !== team.counts.routines) {
        issues.push(`${team.key} must ship every routine paused (${routineCount} of ${team.counts.routines})`);
      }
    }
    expect(issues).toEqual([]);
  });

  it("gives the Marketing Content Team an Analyst (GRE-434)", () => {
    const team = catalogTeams.find((entry) => entry.slug === "marketing-content");
    expect(team?.agentSlugs).toContain("marketing-analyst");
    expect(team?.rootAgentSlugs).toEqual(["marketing-lead"]);
  });

  it("keeps prices out of every Greatstone team", () => {
    const issues: string[] = [];
    for (const team of catalogTeams.filter((entry) => entry.tags.includes("greatstone"))) {
      for (const file of team.files) {
        const content = fs.readFileSync(path.join(PACKAGE_DIR, team.path, file.path), "utf8");
        if (/[£$€]\s?\d|budgetMonthlyCents/.test(content)) issues.push(`${team.key}/${file.path}`);
      }
    }
    expect(issues).toEqual([]);
  });

  it("uses canonical gsam keys derived from kind/category/slug", () => {
    const violations: string[] = [];
    for (const team of catalogTeams) {
      const expectedKey = `paperclipai/${team.kind}/${team.category}/${team.slug}`;
      const expectedId = `paperclipai:${team.kind}:${team.category}:${team.slug}`;
      if (team.key !== expectedKey) violations.push(`${team.key} should be ${expectedKey}`);
      if (team.id !== expectedId) violations.push(`${team.id} should be ${expectedId}`);
    }
    expect(violations).toEqual([]);
  });

  it("exposes a stable manifest header for downstream consumers", () => {
    expect(catalogManifest.schemaVersion).toBe(1);
    expect(catalogManifest.packageName).toBe("@greatstone/teams-catalog");
    expect(catalogTeams.length).toBe(EXPECTED_BUNDLED_KEYS.length + EXPECTED_OPTIONAL_KEYS.length);
  });

  it("resolves shipped teams by id, key, and unique slug", () => {
    const sample = catalogTeams.find((team) => team.key === "paperclipai/bundled/company-defaults/core-exec-team");
    expect(sample, "expected core-exec-team to ship in the bundled catalog").toBeDefined();
    if (!sample) return;

    expect(resolveCatalogTeamRef(sample.id)).toMatchObject({ key: sample.key });
    expect(resolveCatalogTeamRef(sample.key)).toMatchObject({ key: sample.key });
    expect(resolveCatalogTeamRef(sample.slug)).toMatchObject({ key: sample.key });
  });

  it("declares a valid project for every shipped recurring task", () => {
    const issues: string[] = [];

    for (const team of catalogTeams) {
      for (const file of team.files.filter((entry) => entry.kind === "task")) {
        const absolutePath = path.join(PACKAGE_DIR, team.path, file.path);
        const parsed = parseFrontmatterMarkdown(fs.readFileSync(absolutePath, "utf8"));
        if (!asBoolean(parsed.frontmatter.recurring)) continue;

        const project = asString(parsed.frontmatter.project);
        if (!project) {
          issues.push(`${team.key}/${file.path} recurring task must declare a project`);
          continue;
        }
        if (!team.projectSlugs.includes(project)) {
          issues.push(`${team.key}/${file.path} project=${project} must match a team project`);
        }
      }
    }

    expect(issues).toEqual([]);
  });
});

function formatViolations(label: string, teams: CatalogTeam[]) {
  if (teams.length === 0) return label;
  const detail = teams.map((team) => `${team.key} (${team.trustLevel})`).join(", ");
  return `${label}: ${detail}`;
}
